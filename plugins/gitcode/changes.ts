import { pages, type Read } from "./api.ts";
import { evidenceParts } from "./evidence.ts";
import { decimal, record, type Target } from "./input.ts";

export function commitSha(value: unknown) {
  return typeof value === "string" && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(value) ? value.toLowerCase() : null;
}

export function pullRevision(item: Record<string, unknown>) {
  return { headSha: commitSha(record(item.head).sha), baseSha: commitSha(record(item.base).sha) };
}

function filename(value: unknown, token: string) {
  const name = record(value).filename;
  if (typeof name !== "string" || !name || name.includes("\0") || name.includes(token)) return null;
  return { id: name };
}

async function resolveBranch(read: Read, root: string, baseRef: string) {
  if (!/^(?!\.$)(?!.*\.\.)[^\p{Cc}\p{Cs}]+$/u.test(baseRef)) return { reason: "invalid_base_ref" };
  const branch = await read(`${root}/branches/${encodeURIComponent(baseRef)}`);
  if ("reason" in branch) return branch;
  const commit = record(record(branch.value).commit);
  const targetSha = commitSha(commit.sha) || commitSha(commit.id);
  return targetSha ? { targetSha } : { reason: "invalid_branch_response" };
}

async function verifyRevision(
  read: Read,
  path: string,
  target: Target,
  revision: ReturnType<typeof pullRevision>,
  baseRef: unknown,
) {
  if (!revision.headSha || !revision.baseSha) return "missing_pr_revision";
  const reply = await read(path);
  if ("reason" in reply) return reply.reason;
  const item = record(reply.value);
  const latest = pullRevision(item);
  const same =
    decimal(item.number) === target.number &&
    latest.headSha === revision.headSha &&
    latest.baseSha === revision.baseSha &&
    record(item.base).ref === baseRef;
  return same ? null : "pr_revision_changed";
}

async function comparePaths(read: Read, root: string, baseSha: string, targetSha: string, token: string) {
  const reply = await read(`${root}/compare/${baseSha}...${targetSha}`);
  if ("reason" in reply) return { paths: [], reason: reply.reason };
  const result = record(reply.value);
  if (!Array.isArray(result.files)) return { paths: [], reason: "invalid_response" };
  const parsed = result.files.map((value) => filename(value, token));
  const paths = parsed.flatMap((name) => (name ? [name.id] : []));
  if (paths.length !== parsed.length) return { paths, reason: "invalid_response" };
  if (result.truncated === false) return { paths, reason: null };
  return { paths, reason: result.truncated === true ? "compare_truncated" : "compare_coverage_unknown" };
}

async function overlapEvidence(
  read: Read,
  root: string,
  baseRef: string,
  baseSha: string | null,
  paths: string[],
  reason: string | null,
  token: string,
) {
  if (!baseSha || reason) return { paths: [], coverage: "failed", reason: reason || "missing_pr_revision" };
  const branch = await resolveBranch(read, root, baseRef);
  if ("reason" in branch) return { paths: [], coverage: "failed", reason: branch.reason };
  const { targetSha } = branch;
  const compared = await comparePaths(read, root, baseSha, targetSha, token);
  const baseChanges = new Set(compared.paths);
  const common = paths.filter((path) => baseChanges.has(path));
  return {
    paths: common,
    targetSha,
    coverage: compared.reason ? "partial" : "complete",
    reason: compared.reason || undefined,
  };
}

type Coverage = { coverage: string; reason?: string };
type Revision = ReturnType<typeof pullRevision>;
type DiffRevision = { diffBaseSha: string; diffStartSha: string };

function fileParts(
  revision: Revision,
  paths: string[],
  files: Coverage & { source: string; diff?: DiffRevision; primaryReason?: string },
  invalid: string | null,
  maxParts: number,
) {
  return evidenceParts(
    {
      facet: "files",
      coverage: invalid ? (paths.length ? "partial" : "failed") : files.coverage,
      reason: invalid || files.reason,
      source: files.source,
      diffRevision: files.diff,
      primaryReason: files.primaryReason,
      ...revision,
      revisionVerified: !invalid,
    },
    "paths",
    paths,
    maxParts,
  );
}

function overlapParts(
  revision: Revision,
  files: Coverage,
  overlap: Coverage & { paths: string[]; targetSha?: string },
  maxParts: number,
) {
  const { paths: common, ...facts } = overlap;
  const reason = facts.reason || files.reason;
  const coverage = facts.coverage === "complete" && files.coverage !== "complete" ? "partial" : facts.coverage;
  return evidenceParts({ facet: "overlap", ...revision, ...facts, coverage, reason }, "paths", common, maxParts);
}

async function checkedDiff(read: Read, path: string, headSha: string | null, known: string[], token: string) {
  if (!headSha) return null;
  const reply = await read(`${path}/files.json`);
  if ("reason" in reply) return null;
  const data = record(reply.value);
  const refs = record(data.diff_refs);
  const diffStartSha = commitSha(refs.start_sha);
  const diffBaseSha = commitSha(refs.base_sha);
  if (
    !Array.isArray(data.diffs) ||
    data.count !== data.diffs.length ||
    data.truncated === true ||
    commitSha(refs.head_sha) !== headSha ||
    !diffStartSha ||
    !diffBaseSha
  )
    return null;
  const paths = new Set<string>();
  for (const value of data.diffs) {
    const parsed = filename({ filename: record(record(value).statistic).path }, token);
    if (!parsed || paths.has(parsed.id)) return null;
    paths.add(parsed.id);
  }
  return known.every((name) => paths.has(name))
    ? { paths: [...paths].sort(), diff: { diffStartSha, diffBaseSha } }
    : null;
}

export async function changes(read: Read, target: Target, item: Record<string, unknown>, token: string, maxParts = 8) {
  const revision = pullRevision(item);
  if (item.state !== "open" && item.state !== "opened") {
    return ["files", "overlap"].map((facet) => ({ facet, coverage: "not_applicable", ...revision }));
  }
  const root = `/repos/${target.repo}`;
  const path = `${root}/pulls/${target.number}`;
  const files = await pages(read, `${path}/files`, {}, (value) => filename(value, token), 100);
  const known = files.items.map(({ id }) => id).sort();
  const fallback = files.coverage !== "complete" ? await checkedDiff(read, path, revision.headSha, known, token) : null;
  const paths = fallback?.paths ?? known;
  const coverage = fallback
    ? { coverage: "complete", source: "pr-diff", diff: fallback.diff, primaryReason: files.reason }
    : { ...files, source: "pr-files" };
  const baseRef = record(item.base).ref;
  const invalid = await verifyRevision(read, path, target, revision, baseRef);
  const ref = typeof baseRef === "string" && !baseRef.includes(token) ? baseRef : "";
  const overlap = await overlapEvidence(read, root, ref, revision.baseSha, paths, invalid, token);
  const bases = fallback && Object.values(fallback.diff);
  const basis =
    bases && !bases.some((sha) => sha === revision.baseSha)
      ? { coverage: "partial", reason: "file_diff_basis_unaligned" }
      : coverage;
  return [
    ...fileParts(revision, paths, coverage, invalid, maxParts),
    ...overlapParts(revision, basis, overlap, maxParts),
  ];
}
