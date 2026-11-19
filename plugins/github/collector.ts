import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import {
  cursorPages,
  maxConnectionPages,
  ReadBudgetExhausted,
  readFailure,
  record,
  type Data,
  type PageGap,
  type PageResult,
} from "./pages.ts";
import { maxJobPages, readAttempts } from "./ci-attempts.ts";

const kinds = ["issue", "pr"] as const;
type Kind = (typeof kinds)[number];
type Request = { repo: string; previous?: Record<string, string | null> } & (
  { mode: "discover"; author: string } | { mode: "verify"; kind: Kind; number: number }
);
type Target = { repo: string; kind: Kind; number: number };
const commonFacets = ["labels", "assignees", "comments", "links"] as const;
const prFacets = ["files", "reviews", "contexts", "reviewThreads"] as const;
type Facet = (typeof commonFacets)[number] | (typeof prFacets)[number];
type Operation =
  | ({ type: "object" } & Target)
  | ({ type: "page"; facet: Facet; cursor: string } & Target)
  | ({ type: "threadComments"; threadId: string; cursor: string } & Target)
  | { type: "jobs"; repo: string; runId: number; page: number }
  | { type: "search"; repo: string; author: string; kind: Kind; page: number }
  | { type: "compare"; repo: string; oid: string; ref: string };
export type GitHubRead = (operation: Operation) => Promise<unknown>;
type Problem = {
  facet: string;
  reason: PageGap | "not-found" | "scope-mismatch" | "attempt-unverified";
};
type Link = { repo: string; number: number; state: string; url: string };

const pageSize = 100;
const discoveryPages = 10;
const compareLimit = 300;
const objectConcurrency = 4;
const repoPattern = /^[a-z0-9][a-z0-9-]*\/(?!\.{1,2}$)[a-z0-9_.-]+$/i;
const loginPattern = /^[a-z0-9](?:[a-z0-9-]{0,38})$/i;
const oidPattern = /^[a-f0-9]{40}$/i;

function text(value: unknown): string {
  if (typeof value !== "string") throw new Error("invalid-response");
  return value;
}

function positive(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function fingerprints(value: unknown) {
  return Object.fromEntries(
    Object.entries(record(value)).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string" && /^[a-f0-9]{64}$/.test(entry[1]),
    ),
  );
}

function parseRepo(value: unknown) {
  if (typeof value !== "string" || !repoPattern.test(value)) throw new Error("invalid repository");
  return value.toLowerCase();
}

export function parseGitHubRequest(input: unknown): Request {
  const { mode, repo, author, kind, number, previous } = record(input);
  const scope = { repo: parseRepo(repo), previous: fingerprints(previous) };
  if (mode === "discover" && typeof author === "string" && loginPattern.test(author)) {
    return { ...scope, mode, author: author.toLowerCase() };
  }
  if (mode === "verify" && (kind === "issue" || kind === "pr") && positive(number) && number <= 2_147_483_647) {
    return { ...scope, mode, kind, number };
  }
  throw new Error("invalid collection request");
}

function key(target: Target) {
  return `github:${target.repo}:${target.kind}:${target.number}`;
}

async function query(read: GitHubRead, operation: Operation) {
  try {
    return { value: record(await read(operation)) };
  } catch (error) {
    return { failure: readFailure(error) };
  }
}

function searchPage(value: Data) {
  const { items, incomplete_results: incomplete, total_count: total } = value;
  if (
    !Array.isArray(items) ||
    items.length > pageSize ||
    typeof incomplete !== "boolean" ||
    !(total === 0 || positive(total))
  )
    return null;
  const numbers = items.map((item) => record(item).number);
  if (!numbers.every(positive)) return null;
  return { numbers, total, incomplete };
}

function searchCoverage(pages: NonNullable<ReturnType<typeof searchPage>>[]) {
  const listed = pages.flatMap((page) => page.numbers);
  const numbers = [...new Set(listed)];
  const covered = pages.length > 0;
  const truncated =
    pages.some((page) => page.incomplete || page.total !== numbers.length) || listed.length !== numbers.length;
  return { covered, truncated, numbers };
}

async function discoverKind(request: Extract<Request, { mode: "discover" }>, kind: Kind, read: GitHubRead) {
  const operation = { type: "search" as const, repo: request.repo, author: request.author, kind };
  const pages: NonNullable<ReturnType<typeof searchPage>>[] = [];
  const problems: Problem[] = [];
  const facet = `discovery:${kind}`;
  for (let page = 1; page <= discoveryPages; page++) {
    const result = await query(read, { ...operation, page });
    if (!result.value) {
      problems.push({ facet, reason: result.failure });
      break;
    }
    const current = searchPage(result.value);
    if (!current) {
      problems.push({ facet, reason: "invalid-response" });
      break;
    }
    pages.push(current);
    if (current.numbers.length < pageSize || page * pageSize >= current.total) break;
  }
  const { covered, truncated, numbers } = searchCoverage(pages);
  if (truncated) problems.push({ facet, reason: "truncated" });
  const targets = numbers.sort((left, right) => left - right).map((number) => ({ repo: request.repo, kind, number }));
  return { targets, problems, covered };
}

function connection<Value>(data: Data, facet: string, problems: Problem[], parse: (node: Data) => Value): Value[] {
  const { nodes, pageInfo } = record(data[facet]);
  const hasNext = record(pageInfo).hasNextPage;
  if (!Array.isArray(nodes) || typeof hasNext !== "boolean") {
    problems.push({ facet, reason: "invalid-response" });
    return [];
  }
  if (hasNext) problems.push({ facet, reason: "truncated" });
  return nodes.flatMap((node) => {
    try {
      return [parse(record(node))];
    } catch {
      if (!problems.some((problem) => problem.facet === facet && problem.reason === "invalid-response")) {
        problems.push({ facet, reason: "invalid-response" });
      }
      return [];
    }
  });
}

function login(value: unknown) {
  return value === null ? null : text(record(value).login).toLowerCase();
}

function link(node: Data): Link {
  const repo = text(record(node.repository).nameWithOwner).toLowerCase();
  if (!repoPattern.test(repo) || !positive(node.number)) throw new Error("invalid-response");
  return { repo, number: node.number, state: text(node.state), url: text(node.url) };
}

function compareText(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function objectState(value: unknown, kind: Kind) {
  const state = text(value);
  const states = kind === "pr" ? ["OPEN", "CLOSED", "MERGED"] : ["OPEN", "CLOSED"];
  if (!states.includes(state)) throw new Error("invalid-response");
  return state;
}

function baseFields(node: Data, kind: Kind, problems: Problem[]) {
  return {
    title: text(node.title),
    body: text(node.body),
    state: objectState(node.state, kind),
    url: text(node.url),
    updatedAt: text(node.updatedAt),
    author: login(node.author),
    labels: connection(node, "labels", problems, (entry) => text(entry.name)).sort(),
    assignees: connection(node, "assignees", problems, (entry) => text(entry.login).toLowerCase()).sort(),
    comments: connection(node, "comments", problems, (entry) => ({
      id: text(entry.id),
      author: login(entry.author),
      body: text(entry.body),
      createdAt: text(entry.createdAt),
      updatedAt: text(entry.updatedAt),
    })).sort((left, right) => compareText(left.createdAt, right.createdAt) || compareText(left.id, right.id)),
    links: connection(node, "links", problems, link).sort(
      (left, right) => compareText(left.repo, right.repo) || left.number - right.number,
    ),
  };
}

function nullableText(value: unknown) {
  return value === null ? null : text(value);
}

function optionalText(value: unknown) {
  return nullableText(value ?? null);
}

function optionalId(value: unknown) {
  if (value == null) return null;
  if (!positive(value)) throw new Error("invalid-response");
  return value;
}

function inlineThread(node: Data, problems: Problem[]) {
  const id = text(node.id);
  if (typeof node.isResolved !== "boolean" || typeof node.isOutdated !== "boolean") throw new Error("invalid-response");
  return {
    id,
    path: text(node.path),
    line: optionalId(node.line),
    originalLine: optionalId(node.originalLine),
    isResolved: node.isResolved,
    isOutdated: node.isOutdated,
    comments: connection(node, "comments", problems, (entry) => ({
      id: text(entry.id),
      author: login(entry.author),
      body: text(entry.body),
      url: text(entry.url),
      createdAt: text(entry.createdAt),
      updatedAt: text(entry.updatedAt),
    })).sort((left, right) => compareText(left.createdAt, right.createdAt) || compareText(left.id, right.id)),
  };
}

function workflowEvidence(value: unknown) {
  if (value == null) return null;
  const run = record(value);
  return {
    id: optionalId(run.databaseId),
    latestAttempt: optionalId(run.runAttempt),
    workflowId: optionalId(record(run.workflow).databaseId),
    event: nullableText(run.event ?? null),
    createdAt: nullableText(run.createdAt ?? null),
  };
}

function check(entry: Data) {
  if (entry.__typename === "CheckRun") {
    const suite = record(entry.checkSuite);
    const workflow = workflowEvidence(suite.workflowRun);
    return {
      kind: "check" as const,
      nodeId: optionalText(entry.id),
      checkId: optionalId(entry.databaseId),
      name: text(entry.name),
      workflowName: optionalText(record(record(suite.workflowRun).workflow).name),
      workflowRun: workflow,
      app: optionalText(record(suite.app).slug),
      startedAt: optionalText(entry.startedAt),
      completedAt: optionalText(entry.completedAt),
      attempt: workflow?.latestAttempt === 1 && workflow.id !== null ? 1 : null,
      status: text(entry.status),
      conclusion: nullableText(entry.conclusion),
      url: optionalText(entry.detailsUrl),
    };
  }
  if (entry.__typename === "StatusContext") {
    return {
      kind: "status",
      name: text(entry.context),
      status: text(entry.state),
      conclusion: null,
      url: optionalText(entry.targetUrl),
    } as const;
  }
  throw new Error("invalid-response");
}

function pullVersion(node: Data) {
  const baseOid = text(node.baseRefOid);
  const headOid = text(node.headRefOid);
  const baseRef = text(node.baseRefName);
  if (!oidPattern.test(baseOid) || !oidPattern.test(headOid) || !baseRef || typeof node.isDraft !== "boolean") {
    throw new Error("invalid-response");
  }
  return { baseOid, headOid, baseRef, draft: node.isDraft };
}

function rollupFields(value: unknown, problems: Problem[]) {
  if (value === null) return null;
  const rollup = record(value);
  return {
    state: text(rollup.state),
    checks: connection(rollup, "contexts", problems, check).sort((left, right) =>
      compareText(JSON.stringify(left), JSON.stringify(right)),
    ),
  };
}

function attemptsReader(read: GitHubRead) {
  const cache = new Map<string, ReturnType<typeof readAttempts>>();
  return (repo: string, runId: number, latestAttempt: number) => {
    const key = `${repo}:${runId}:${latestAttempt}`;
    let result = cache.get(key);
    if (!result) {
      result = readAttempts(repo, runId, latestAttempt, (page) => read({ type: "jobs", repo, runId, page }));
      cache.set(key, result);
    }
    return result;
  };
}

type Check = ReturnType<typeof check>;

function conflictingRuns(checks: Check[]) {
  const attempts = new Map<number, number>();
  const conflicts = new Set<number>();
  for (const entry of checks) {
    if (entry.kind !== "check" || !entry.workflowRun) continue;
    const { id, latestAttempt } = entry.workflowRun;
    if (id === null || latestAttempt === null) continue;
    if (attempts.has(id) && attempts.get(id) !== latestAttempt) conflicts.add(id);
    attempts.set(id, latestAttempt);
  }
  return conflicts;
}

function noteAttemptGap(problems: Problem[], id: number | null, reason: Problem["reason"]) {
  const facet = id === null ? "ciAttempts" : `ciAttempts:${id}`;
  if (!problems.some((problem) => problem.facet === facet)) problems.push({ facet, reason });
}

async function verifyAttempt(
  entry: Check,
  repo: string,
  attempts: ReturnType<typeof attemptsReader>,
  conflicts: Set<number>,
  problems: Problem[],
): Promise<Check> {
  if (entry.kind !== "check" || !entry.workflowRun) return entry;
  const { id, latestAttempt } = entry.workflowRun;
  if (id !== null && conflicts.has(id)) {
    noteAttemptGap(problems, id, "object-changed");
    return { ...entry, attempt: null };
  }
  if (id === null || latestAttempt === null || entry.checkId === null) {
    noteAttemptGap(problems, id, "attempt-unverified");
    return { ...entry, attempt: null };
  }
  if (entry.attempt !== null) return entry;
  const matched = await attempts(repo, id, latestAttempt);
  const attempt = matched instanceof Map ? (matched.get(entry.checkId) ?? null) : null;
  if (attempt === null) noteAttemptGap(problems, id, matched instanceof Map ? "attempt-unverified" : matched.gap);
  return { ...entry, attempt };
}

async function resolveAttempts(
  ci: ReturnType<typeof rollupFields>,
  repo: string,
  attempts: ReturnType<typeof attemptsReader>,
  problems: Problem[],
) {
  if (!ci) return ci;
  const conflicts = conflictingRuns(ci.checks);
  const checks = [];
  for (const entry of ci.checks) checks.push(await verifyAttempt(entry, repo, attempts, conflicts, problems));
  return { ...ci, checks };
}

function pullFields(node: Data, problems: Problem[]) {
  return {
    ...pullVersion(node),
    mergeable: text(node.mergeable),
    mergeState: text(node.mergeStateStatus),
    reviewDecision: nullableText(node.reviewDecision),
    files: connection(node, "files", problems, (entry) => text(entry.path)).sort(),
    reviewThreads: connection(node, "reviewThreads", problems, (thread) => inlineThread(thread, problems)).sort(
      (left, right) => compareText(left.id, right.id),
    ),
    reviews: connection(node, "reviews", problems, (entry) => ({
      id: text(entry.id),
      author: login(entry.author),
      state: text(entry.state),
      body: text(entry.body),
      submittedAt: nullableText(entry.submittedAt),
    })).sort(
      (left, right) => compareText(left.submittedAt ?? "", right.submittedAt ?? "") || compareText(left.id, right.id),
    ),
    ci: rollupFields(node.statusCheckRollup, problems),
  };
}

function comparisonPaths(files: unknown[]) {
  const paths = new Set<string>();
  for (const file of files) {
    const { filename, previous_filename: previous } = record(file);
    if (typeof filename !== "string" || (previous !== undefined && typeof previous !== "string")) return null;
    paths.add(filename);
    if (previous) paths.add(previous);
  }
  return paths;
}

function compareReader(read: GitHubRead) {
  const cache = new Map<string, ReturnType<typeof query>>();
  return async (repo: string, pull: ReturnType<typeof pullFields>, problems: Problem[]) => {
    if (!pull.files.length) return problems.some((problem) => problem.facet === "files") ? null : [];
    const operation = { type: "compare" as const, repo, oid: pull.baseOid, ref: pull.baseRef };
    const cacheKey = JSON.stringify(operation);
    if (!cache.has(cacheKey)) cache.set(cacheKey, query(read, operation));
    const result = await cache.get(cacheKey)!;
    if (!result.value) {
      problems.push({ facet: "compare", reason: result.failure });
      return null;
    }
    const files = result.value.files;
    const paths = Array.isArray(files) ? comparisonPaths(files) : null;
    if (!Array.isArray(files) || !paths) {
      problems.push({ facet: "compare", reason: "invalid-response" });
      return null;
    }
    if (files.length >= compareLimit) problems.push({ facet: "compare", reason: "truncated" });
    return pull.files.filter((file) => paths.has(file));
  };
}

type Fields = ReturnType<typeof baseFields> & Partial<ReturnType<typeof pullFields>> & { overlap?: string[] | null };
type Observation = Target & {
  key: string;
  observedAt: string;
  status: "complete" | "partial" | "failed";
  problems: Problem[];
  change: "unknown" | "baseline" | "unchanged" | "changed";
  fingerprint: string | null;
  fields: Fields | null;
};

function objectEvidence(response: Data, target: Target) {
  if (Array.isArray(response.errors) && response.errors.length) throw new Error("invalid-response");
  const repository = record(record(response.data).repository);
  if (record(response.data).repository === null || repository.item === null) return null;
  const node = record(repository.item);
  if (text(repository.nameWithOwner).toLowerCase() !== target.repo || node.number !== target.number) {
    throw new Error("invalid-response");
  }
  return node;
}

function sameVersion(left: Data, right: Data) {
  return (
    left.updatedAt === right.updatedAt && left.headRefOid === right.headRefOid && left.baseRefOid === right.baseRefOid
  );
}

function facetOf(node: Data, facet: Facet) {
  return facet === "contexts" ? record(node.statusCheckRollup).contexts : node[facet];
}

async function objectPage(
  read: GitHubRead,
  target: Target,
  version: Data,
  facet: Facet,
  cursor: string,
): Promise<PageResult> {
  const result = await query(read, { ...target, type: "page", facet, cursor });
  if (!result.value) return { gap: result.failure };
  try {
    const node = objectEvidence(result.value, target);
    if (!node || !sameVersion(version, node)) return { gap: "object-changed" };
    if (facet === "contexts" && record(version.statusCheckRollup).state !== record(node.statusCheckRollup).state) {
      return { gap: "object-changed" };
    }
    return { page: facetOf(node, facet) };
  } catch {
    return { gap: "invalid-response" };
  }
}

async function threadPage(
  read: GitHubRead,
  target: Target,
  version: Data,
  prior: Data,
  threadId: string,
  cursor: string,
): Promise<PageResult> {
  const result = await query(read, { ...target, type: "threadComments", threadId, cursor });
  if (!result.value) return { gap: result.failure };
  const { data, errors } = result.value;
  if (Array.isArray(errors) && errors.length) return { gap: "invalid-response" };
  const node = record(record(data).node);
  const current = record(node.pullRequest);
  const repo = record(node.repository).nameWithOwner;
  if (
    node.id !== threadId ||
    current.number !== target.number ||
    typeof repo !== "string" ||
    repo.toLowerCase() !== target.repo
  ) {
    return { gap: "invalid-response" };
  }
  if (
    !sameVersion(version, current) ||
    ["isResolved", "isOutdated", "path", "line", "originalLine"].some((field) => prior[field] !== node[field])
  ) {
    return { gap: "object-changed" };
  }
  return { page: node.comments };
}

async function collectThreadReplies(
  value: unknown,
  target: Target,
  version: Data,
  read: GitHubRead,
  problems: Problem[],
) {
  const threads = record(value);
  if (!Array.isArray(threads.nodes)) return value;
  const nodes = [];
  for (const item of threads.nodes) {
    const thread = record(item);
    const id = thread.id;
    if (typeof id !== "string" || !id) {
      nodes.push(item);
      continue;
    }
    const replies = await cursorPages(thread.comments, (cursor) =>
      threadPage(read, target, version, thread, id, cursor),
    );
    if (replies.gap) problems.push({ facet: `reviewThreads:${id}:comments`, reason: replies.gap });
    nodes.push({ ...thread, comments: replies.value });
  }
  return { ...threads, nodes };
}

async function completeConnections(target: Target, version: Data, read: GitHubRead, problems: Problem[]) {
  const result = { ...version };
  const facets =
    target.kind === "pr" && version.statusCheckRollup !== null
      ? [...commonFacets, ...prFacets]
      : target.kind === "pr"
        ? [...commonFacets, ...prFacets.filter((facet) => facet !== "contexts")]
        : commonFacets;
  for (const facet of facets) {
    const collected = await cursorPages(facetOf(version, facet), (cursor) =>
      objectPage(read, target, version, facet, cursor),
    );
    if (collected.gap) problems.push({ facet, reason: collected.gap });
    if (facet === "contexts")
      result.statusCheckRollup = { ...record(version.statusCheckRollup), contexts: collected.value };
    else result[facet] = collected.value;
  }
  if (target.kind === "pr")
    result.reviewThreads = await collectThreadReplies(result.reviewThreads, target, version, read, problems);
  return result;
}

async function observe(
  target: Target,
  request: Request,
  read: GitHubRead,
  compare: ReturnType<typeof compareReader>,
  attempts: ReturnType<typeof attemptsReader>,
): Promise<Observation> {
  const result = await query(read, { ...target, type: "object" });
  const problems: Problem[] = [];
  const observation: Observation = {
    ...target,
    key: key(target),
    observedAt: new Date().toISOString(),
    problems,
    fields: null,
    status: "failed",
    change: "unknown",
    fingerprint: null,
  };
  const fail = (reason: Problem["reason"]) => {
    problems.push({ facet: "object", reason });
    return observation;
  };
  if (!result.value) return fail(result.failure);
  try {
    const node = objectEvidence(result.value, target);
    if (!node) return fail("not-found");
    if (request.mode === "discover" && login(node.author) !== request.author) return fail("scope-mismatch");
    const completed = await completeConnections(target, node, read, problems);
    const fields = baseFields(completed, target.kind, problems);
    observation.fields = await enrichPull(target, completed, fields, compare, attempts, problems);
  } catch {
    return fail("invalid-response");
  }
  observation.observedAt = new Date().toISOString();
  return finishObservation(observation, request.previous?.[observation.key]);
}

async function enrichPull(
  target: Target,
  node: Data,
  fields: ReturnType<typeof baseFields>,
  compare: ReturnType<typeof compareReader>,
  attempts: ReturnType<typeof attemptsReader>,
  problems: Problem[],
): Promise<Fields> {
  if (target.kind !== "pr") return fields;
  const pull = pullFields(node, problems);
  return {
    ...fields,
    ...pull,
    ci: await resolveAttempts(pull.ci, target.repo, attempts, problems),
    overlap: fields.state === "OPEN" ? await compare(target.repo, pull, problems) : [],
  };
}

function finishObservation(observation: Observation, previous: string | null | undefined): Observation {
  if (observation.problems.length) return { ...observation, status: "partial" };
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify([observation.key, observation.fields], (field, value) =>
        field === "updatedAt" ? undefined : value,
      ),
    )
    .digest("hex");
  const change = !previous ? "baseline" : previous === fingerprint ? "unchanged" : "changed";
  return { ...observation, status: "complete", change, fingerprint };
}

function referenceNumbers(text: string, limit = text.length) {
  const plain = text.replace(/https?:\/\/\S+/gi, (url) => " ".repeat(url.length));
  return [...plain.matchAll(/(?<![\w/#-])#(\d+)\b/g)]
    .filter((match) => match.index + match[0].length <= limit)
    .map((match) => Number(match[1]));
}

function inferredLinks(observations: Observation[]) {
  const issues = new Map(
    observations.filter((item) => item.kind === "issue" && item.fields).map((item) => [item.number, item.key]),
  );
  return observations.flatMap((item) => {
    if (item.kind !== "pr" || !item.fields) return [];
    const first = item.fields.comments[0];
    const matches = referenceNumbers(item.fields.body);
    if (first?.author && first.author === item.fields.author) matches.push(...referenceNumbers(first.body, 500));
    return [...new Set(matches.map((number) => issues.get(number)))]
      .filter((target): target is string => !!target)
      .sort()
      .map((target) => ({ pr: item.key, issue: target, evidence: "text-reference" as const }));
  });
}

export async function collectGitHub(input: unknown, read: GitHubRead = githubReader()) {
  const request = parseGitHubRequest(input);
  const discovery =
    request.mode === "discover" ? await Promise.all(kinds.map((kind) => discoverKind(request, kind, read))) : [];
  const targets =
    request.mode === "verify"
      ? [{ repo: request.repo, kind: request.kind, number: request.number }]
      : discovery.flatMap((result) => result.targets);
  const problems = discovery.flatMap((result) => result.problems);
  const observations: Observation[] = [];
  const compare = compareReader(read);
  const attempts = attemptsReader(read);
  for (let offset = 0; offset < targets.length; offset += objectConcurrency) {
    const group = targets.slice(offset, offset + objectConcurrency);
    observations.push(...(await Promise.all(group.map((target) => observe(target, request, read, compare, attempts)))));
  }
  const hasProblems = problems.length || observations.some((item) => item.status !== "complete");
  const hasEvidence = observations.some((item) => item.fields) || discovery.some((result) => result.covered);
  return {
    version: 1,
    observedAt: new Date().toISOString(),
    repo: request.repo,
    scope:
      request.mode === "discover"
        ? { mode: request.mode, author: request.author }
        : { mode: request.mode, kind: request.kind, number: request.number },
    status: !hasProblems ? "complete" : hasEvidence ? "partial" : "failed",
    limits: {
      discoveredPerKind: discoveryPages * pageSize,
      connectionPage: pageSize,
      connectionPages: maxConnectionPages,
      jobPages: maxJobPages,
      compareFiles: compareLimit,
    },
    problems,
    observations,
    inferredLinks: inferredLinks(observations),
  } as const;
}

const fields = (selection: string) => `{ totalCount pageInfo { hasNextPage endCursor } nodes { ${selection} } }`;
const threadPageSize = 25;
const replyPageSize = 10;
const threadVersion = "id path line originalLine isResolved isOutdated";
const replyFields = fields("id author { login } body url createdAt updatedAt");
const pullVersionFields = "headRefOid baseRefOid";
const objectVersion = (kind: Kind) => `number updatedAt ${kind === "pr" ? pullVersionFields : ""}`;
const linkedFields = "id number state url repository { nameWithOwner }";
const contextsFields = `__typename
    ... on CheckRun { id databaseId name status conclusion detailsUrl startedAt completedAt
      checkSuite { app { slug } workflowRun { databaseId runAttempt event createdAt workflow { databaseId name } } } }
    ... on StatusContext { id context state targetUrl }`;
const facetFields: Record<Facet, string> = {
  labels: "id name",
  assignees: "id login",
  comments: "id author { login } body createdAt updatedAt",
  links: linkedFields,
  files: "path",
  reviews: "id author { login } state body submittedAt",
  contexts: contextsFields,
  reviewThreads: `${threadVersion} comments(first: ${replyPageSize}) ${replyFields}`,
};

function selectFacet(kind: Kind, facet: Facet, after = false) {
  const name =
    facet === "links"
      ? `links: ${kind === "issue" ? "closedByPullRequestsReferences" : "closingIssuesReferences"}`
      : facet;
  const selection = `${name}(first: ${facet === "reviewThreads" ? threadPageSize : pageSize}${after ? ", after: $after" : ""}) ${fields(facetFields[facet])}`;
  return facet === "contexts" ? `statusCheckRollup { state ${selection} }` : selection;
}

function objectArgs(operation: Extract<Operation, { type: "object" | "page" }>) {
  const [owner, repo] = operation.repo.split("/");
  const facets = operation.kind === "pr" ? [...commonFacets, ...prFacets] : commonFacets;
  const selection =
    operation.type === "page"
      ? selectFacet(operation.kind, operation.facet, true)
      : `
    title body url state author { login }
    ${operation.kind === "pr" ? "isDraft mergeable mergeStateStatus reviewDecision baseRefName" : ""}
    ${facets.map((facet) => selectFacet(operation.kind, facet)).join("\n")}`;
  const query = `query($owner: String!, $repo: String!, $number: Int!${operation.type === "page" ? ", $after: String!" : ""}) {
    repository(owner: $owner, name: $repo) { nameWithOwner
      item: ${operation.kind === "issue" ? "issue" : "pullRequest"}(number: $number) { ${objectVersion(operation.kind)} ${selection} }
    }
  }`;
  return [
    "graphql",
    "-f",
    `query=${query}`,
    "-f",
    `owner=${owner}`,
    "-f",
    `repo=${repo}`,
    "-F",
    `number=${operation.number}`,
    ...(operation.type === "page" ? ["-f", `after=${operation.cursor}`] : []),
  ];
}

function replyArgs(operation: Extract<Operation, { type: "threadComments" }>) {
  const query = `query($thread: ID!, $after: String!) {
    node(id: $thread) { ... on PullRequestReviewThread { ${threadVersion}
      repository { nameWithOwner } pullRequest { ${objectVersion("pr")} }
      comments(first: ${replyPageSize}, after: $after) ${replyFields}
    } }
  }`;
  return ["graphql", "-f", `query=${query}`, "-f", `thread=${operation.threadId}`, "-f", `after=${operation.cursor}`];
}

function ghArgs(operation: Operation) {
  if (operation.type === "jobs")
    return [
      `repos/${operation.repo}/actions/runs/${operation.runId}/jobs?filter=all&per_page=100&page=${operation.page}`,
    ];
  if (operation.type === "threadComments") return replyArgs(operation);
  if (operation.type === "search") {
    const query = new URLSearchParams({
      q: `repo:${operation.repo} author:${operation.author} is:${operation.kind}`,
      sort: "created",
      order: "asc",
      per_page: String(pageSize),
      page: String(operation.page),
    });
    return [`search/issues?${query}`];
  }
  if (operation.type === "compare") {
    return [
      `repos/${operation.repo}/compare/${operation.oid}...${encodeURIComponent(operation.ref)}?per_page=1&page=1`,
    ];
  }
  return objectArgs(operation);
}

export function githubReader(signal = AbortSignal.timeout(120_000)): GitHubRead {
  const exec = promisify(execFile);
  return async (operation) => {
    if (signal.aborted) throw new ReadBudgetExhausted();
    try {
      const { stdout } = await exec("gh", ["api", "--hostname", "github.com", ...ghArgs(operation)], {
        timeout: 20_000,
        maxBuffer: 8 * 1024 * 1024,
        signal,
        env: { ...process.env, GH_PROMPT_DISABLED: "1" },
      });
      return JSON.parse(stdout);
    } catch (error) {
      if (signal.aborted) throw new ReadBudgetExhausted();
      throw error;
    }
  };
}

if (import.meta.main) {
  try {
    process.stdout.write(`${JSON.stringify(await collectGitHub(JSON.parse(process.argv[2] ?? "null")))}\n`);
  } catch {
    process.stderr.write("GitHub collection request is invalid\n");
    process.exitCode = 2;
  }
}
