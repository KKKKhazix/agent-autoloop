import { pages, type Read } from "./api.ts";
import { commitSha } from "./changes.ts";
import { evidenceParts, type Text } from "./evidence.ts";
import { decimal, record, type Config, type Target } from "./input.ts";

function relatedLink(value: unknown, kind: Target["kind"], repositories: Config["repositories"], text: Text) {
  const item = record(value);
  const number = decimal(item.number);
  const path = kind === "pr" ? "merge_requests" : "issues";
  const raw = typeof item.html_url === "string" ? item.html_url : "";
  const match = /^https:\/\/gitcode\.com\/([a-z0-9_.-]+\/[a-z0-9_.-]+)\/(issues|merge_requests)\/([^/?#]+)\/?$/i.exec(
    raw,
  );
  if (!number || !match || match[2] !== path || match[3] !== number) return null;
  const repository = match[1].toLowerCase();
  const repo = repositories.get(repository);
  return {
    id: `${repository}:${number}`,
    permitted: Boolean(repo),
    repo: repository,
    kind,
    number,
    state: text(item.state, 32).text || null,
    link: `https://gitcode.com/${repo ?? repository}/${path}/${number}`,
    relationship: "platform_related",
  };
}

export async function platformLinks(read: Read, path: string, target: Target, config: Config, text: Text) {
  const isPull = target.kind === "pr";
  const endpoint = isPull ? "issues" : "pull_requests";
  const { items, coverage, reason } = await pages(read, `${path}/${endpoint}`, {}, (value) =>
    relatedLink(value, isPull ? "issue" : "pr", config.repositories, text),
  );
  return {
    meta: {
      facet: "platform-links",
      coverage,
      reason,
      excludedByScope: items.filter((item) => !item.permitted).length,
    },
    links: items.filter(({ permitted }) => permitted).map(({ id, permitted, ...link }) => link),
  };
}

function apiId(value: unknown) {
  return typeof value === "string" && /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(value) ? value : decimal(value);
}

function checkFields(item: Record<string, unknown>, text: Text) {
  const timestamp = (value: unknown) =>
    typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : text(value, 40).text || null;
  return {
    name: text(item.workflow_name ?? item.name ?? item.title, 120).text || null,
    status: text(item.status, 48).text || null,
    conclusion: text(item.conclusion, 48).text || null,
    startedAt: timestamp(item.start_time ?? item.started_at ?? item.run_started_at),
    completedAt: timestamp(item.end_time ?? item.completed_at),
    updatedAt: timestamp(item.updated_at),
  };
}

async function workflowRuns(read: Read, path: string, number: string, headSha: string) {
  const matches = new Map<string, Record<string, unknown>>();
  const seen = new Set<string>();
  let total: number | undefined;
  for (let page = 1; page <= 4; page += 1) {
    const reply = await read(path, { pull_request_id: number, page: String(page), per_page: "20" });
    if ("reason" in reply) return { matches, reason: reply.reason };
    const data = record(reply.value);
    if (
      !Array.isArray(data.workflow_runs) ||
      typeof data.total_count !== "number" ||
      !Number.isSafeInteger(data.total_count) ||
      data.total_count < 0 ||
      data.workflow_runs.length > 20
    )
      return { matches, reason: "invalid_response" };
    if (total !== undefined && total !== data.total_count) return { matches, reason: "run_count_changed" };
    total = data.total_count;
    for (const value of data.workflow_runs) {
      const run = record(value);
      const id = apiId(run.workflow_run_id ?? run.id);
      const sha = commitSha(run.head_sha);
      if (!id || !sha || seen.has(id)) return { matches, reason: "invalid_or_repeated_run" };
      seen.add(id);
      if (sha === headSha) matches.set(id, run);
    }
    if (seen.size === total) return { matches };
    if (seen.size > total || !data.workflow_runs.length) return { matches, reason: "run_count_mismatch" };
  }
  return { matches, reason: "run_page_limit" };
}

async function workflowJobs(read: Read, path: string, runId: string, text: Text) {
  const reply = await read(`${path}/${encodeURIComponent(runId)}/jobs`);
  if ("reason" in reply) return { rows: [], reason: reply.reason };
  const data = record(reply.value);
  if (
    !Array.isArray(data.jobs) ||
    typeof data.total_count !== "number" ||
    !Number.isSafeInteger(data.total_count) ||
    data.total_count < 0
  )
    return { rows: [], reason: "invalid_job_response" };
  const seen = new Set<string>();
  const rows = data.jobs.flatMap((value) => {
    const job = record(value);
    const jobId = apiId(job.job_run_id ?? job.id ?? job.job_id);
    if (!jobId || seen.has(jobId)) return [];
    seen.add(jobId);
    return [{ kind: "job", runId, jobId, ...checkFields(job, text) }];
  });
  const reason =
    data.jobs.length !== rows.length || rows.length > data.total_count
      ? "invalid_job_response"
      : rows.length < data.total_count
        ? "job_count_mismatch"
        : undefined;
  return { rows, reason };
}

export async function platformCi(read: Read, target: Target, headSha: string | null, text: Text) {
  const meta = { facet: "current-ci", source: "actions", headSha };
  if (!headSha)
    return { observed: false, meta: { ...meta, coverage: "failed", reason: "missing_pr_revision" }, rows: [] };
  const path = `/v8/repos/${target.repo}/actions/runs`;
  const { matches, reason } = await workflowRuns(read, path, target.number, headSha);
  if (!matches.size)
    return {
      observed: false,
      meta: { ...meta, coverage: reason ? "failed" : "unverified", reason: reason ?? "no_matching_run" },
      rows: [],
    };
  const checked = [...matches].slice(0, 5);
  const byRun = await Promise.all(
    checked.map(async ([runId, run]) => {
      const jobs = await workflowJobs(read, path, runId, text);
      return {
        ...jobs,
        rows: [{ kind: "run", runId, ...checkFields(run, text), jobsReason: jobs.reason }, ...jobs.rows],
      };
    }),
  );
  const gap = reason ?? (checked.length < matches.size ? "run_detail_limit" : byRun.find((run) => run.reason)?.reason);
  return {
    observed: true,
    meta: { ...meta, coverage: gap ? "partial" : "complete", reason: gap, matchedRuns: matches.size },
    rows: byRun.flatMap(({ rows }) => rows),
  };
}

export function platformParts(
  links: Awaited<ReturnType<typeof platformLinks>>,
  ci: Awaited<ReturnType<typeof platformCi>> | null,
  maxParts: number,
) {
  const linksParts = evidenceParts(links.meta, "links", links.links, ci ? Math.max(1, maxParts - 1) : maxParts);
  return ci ? [...linksParts, ...evidenceParts(ci.meta, "rows", ci.rows, maxParts - linksParts.length)] : linksParts;
}
