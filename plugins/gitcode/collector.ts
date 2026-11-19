import { author, checkAccount, owned, pages, reader, type Options, type Read } from "./api.ts";
import { changes, pullRevision } from "./changes.ts";
import { evidenceParts, pack, type Evidence, type Text } from "./evidence.ts";
import {
  actorId,
  decimal,
  DISCOVER,
  FOLLOW,
  parseConfig,
  readTarget,
  record,
  scanSubject,
  SWEEP,
  VERIFY,
  type Config,
  type Target,
} from "./input.ts";
import { platformCi, platformLinks, platformParts } from "./platform.ts";
import { references } from "./references.ts";
import { ciReport, reviewSummary } from "./reports.ts";

export { parseConfig };

type Event = { id: string; type: string; subject: string; summary: string; detail: string; link: string };
type Emit = (type: string, summary: string, data: object, suffix?: string) => Event;
type Scan = NonNullable<ReturnType<typeof readTarget>> & { run: string };

function textReader(token: string): Text {
  return (value, limit) => {
    const input = typeof value === "string" ? value.replaceAll(token, "[redacted]") : "";
    const clean = input
      .replace(/((?:access[_-]token|private[_-]token)=)[^&#\s"'<>]+/gi, "$1[redacted]")
      .toWellFormed()
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
      .trim();
    const chars = [...clean];
    return { text: chars.slice(0, limit).join(""), truncated: chars.length > limit };
  };
}

const collection = (target: Target) => (target.kind === "pr" ? "pulls" : "issues");
function linkFor({ repo, kind, number }: Target) {
  const repoUrl = `https://gitcode.com/${repo}`;
  if (number === "own") return repoUrl;
  return `${repoUrl}/${kind === "pr" ? "merge_requests" : "issues"}/${number}`;
}

function schedule(config: Config, run: string): Event[] {
  const make = (type: string, subject: string): Event => ({
    id: `gitcode:${run}:${subject}`,
    type,
    subject,
    summary: type === SWEEP ? "发现本人事项" : "核实 GitCode 事项",
    detail: type === SWEEP ? JSON.stringify({ scheduled: true, scanRun: run }) : "",
    link: "",
  });
  const found = [...config.repositories.keys()].flatMap((repo) =>
    ["pr", "issue"].map((kind) => make(SWEEP, `gitcode:${repo}:${kind}:own`)),
  );
  return [...found, ...config.targets.map(({ subject }) => make(VERIFY, subject))];
}

function scanEvent(scan: Scan, type: string, subject: string): Event {
  return {
    id: `gitcode:scan:${scan.scanRun ?? scan.run}:${type}:${subject}`,
    type,
    subject,
    summary: "继续核实 GitCode 事项",
    detail: JSON.stringify({ scanRun: scan.scanRun ?? scan.run, scheduled: scan.scheduled }),
    link: "",
  };
}

async function discover(scan: Scan, config: Config, read: Read, emit: Emit) {
  const { target } = scan;
  const filter = target.kind === "pr" ? "author" : "creator";
  const { items, nextPage, ...coverage } = await owned(
    read,
    `/repos/${target.repo}/${collection(target)}`,
    filter,
    config.account,
    target.page,
  );
  const numbers = items.filter(({ owned }) => owned).map(({ id }) => id);
  const nextRequest = nextPage && { type: scan.auto ? SWEEP : DISCOVER, subject: scanSubject(target, nextPage) };
  const queued =
    scan.auto && scan.canFollow
      ? numbers.flatMap((number) => {
          const subject = scanSubject(target, 1, number);
          return scan.scheduled && config.targets.some((item) => item.subject === subject)
            ? []
            : [scanEvent(scan, FOLLOW, subject)];
        })
      : [];
  const continued = scan.auto && scan.canContinue && nextRequest;
  return [
    emit("gitcode.discovery.observed", "GitCode 本人事项发现", {
      ...coverage,
      numbers,
      ...(target.page > 1 ? { startPage: target.page, canonicalSubject: scanSubject(target) } : {}),
      ...(nextRequest ? { nextRequest } : {}),
      ...(scan.auto
        ? { queued: queued.length, continuationQueued: Boolean(continued), followLimit: !scan.canFollow }
        : {}),
    }),
    ...queued,
    ...(continued ? [scanEvent(scan, continued.type, continued.subject)] : []),
  ];
}

function prFacts(item: Record<string, unknown>, text: Text) {
  const gate = record(item.mergeable_state);
  const bool = (value: unknown) => (typeof value === "boolean" ? value : null);
  const integer = (value: unknown) => (typeof value === "number" && Number.isSafeInteger(value) ? value : null);
  const base = text(record(item.base).ref, 120);
  const head = text(record(item.head).ref, 120);
  return {
    ...pullRevision(item),
    baseRef: base.text || null,
    baseRefTruncated: base.truncated,
    headRef: head.text || null,
    headRefTruncated: head.truncated,
    mergedAt: text(item.merged_at, 40).text || null,
    closeRelatedIssuesOnMerge: bool(item.close_related_issue),
    draft: bool(item.draft),
    mergeable: bool(item.mergeable),
    canMergeCheck: bool(item.can_merge_check),
    mergeGate: {
      state: bool(gate.state),
      ciStatePassed: bool(gate.ci_state_passed),
      discussionPassed: bool(gate.resolve_discussion_passed),
      conflictPassed: bool(gate.conflict_passed),
    },
    approvalGate: {
      reviewersPassed: bool(gate.approval_reviewers_required_passed),
      approversPassed: bool(gate.approval_approvers_required_passed),
      testersPassed: bool(gate.approval_testers_required_passed),
      approversResult: integer(gate.approval_approvers_result),
      testersResult: integer(gate.approval_testers_result),
    },
  };
}

function issueFacts(item: Record<string, unknown>, text: Text) {
  return {
    issueState: text(item.issue_state, 64).text || null,
    issueType: text(item.issue_type, 64).text || null,
    priority: typeof item.priority === "number" && Number.isSafeInteger(item.priority) ? item.priority : null,
    priorityName: text(record(item.issue_priority_detail).title, 64).text || null,
    finishedAt: text(item.finished_at, 40).text || null,
    stateName: text(record(item.issue_state_detail).title, 64).text || null,
  };
}

function labels(raw: unknown, text: Text) {
  if (!Array.isArray(raw)) return { labels: null, labelsTruncated: false };
  const shown = raw.slice(0, 12).map((label) => text(typeof label === "string" ? label : record(label).name, 50));
  return {
    labels: shown.map((label) => label.text).filter(Boolean),
    labelsTruncated: raw.length > shown.length || shown.some((label) => label.truncated || !label.text),
  };
}

function comment(value: unknown, text: Text, botIds: Config["botIds"]) {
  const item = record(value);
  const id = decimal(item.id);
  if (!id || typeof item.body !== "string") return null;
  const publisher = actorId(record(item.user).id);
  const body = text(item.body, 1100);
  const report = publisher && botIds.has(publisher);
  const entry = {
    id,
    authorId: publisher,
    author: text(author(item), 64).text,
    createdAt: text(item.created_at, 40).text,
    updatedAt: text(item.updated_at, 40).text,
    commentType: text(item.comment_type, 32).text || null,
    body: body.text,
    bodyTruncated: body.truncated,
    reviewSummary: reviewSummary(item.body),
  };
  return {
    id,
    entry: report ? { ...entry, reportRevision: "unverified" } : entry,
    report: report ? ciReport(item.body, text) : undefined,
  };
}

function splitReport(entry: object, report: NonNullable<ReturnType<typeof ciReport>>) {
  const budget = Math.min(1000, 3500 - JSON.stringify(entry).length);
  let size = 2;
  let inline = 0;
  for (const check of report.checks) {
    size += JSON.stringify(check).length + 1;
    if (size > budget) break;
    inline += 1;
  }
  return { ...report, checks: report.checks.slice(0, inline), overflow: report.checks.slice(inline) };
}

function discussionEvents(items: NonNullable<ReturnType<typeof comment>>[], maxParts: number, emit: Emit) {
  const comments = items.map(({ id, entry, report }) => ({ id, entry, report: report && splitReport(entry, report) }));
  const rows = comments.flatMap(({ id: commentId, report }) =>
    report ? report.overflow.map((check, index) => ({ ...check, commentId, index: index + report.checks.length })) : [],
  );
  const parts =
    rows.length && maxParts > 0
      ? evidenceParts({ facet: "ci-checks", coverage: "complete" }, "rows", rows, maxParts)
      : [];
  const counts = new Map<string, number>();
  for (const { rows: checks } of parts)
    for (const { commentId } of checks) counts.set(commentId, (counts.get(commentId) ?? 0) + 1);
  const events = comments.map(({ id, entry, report }) => {
    if (!report) return emit("gitcode.comment.observed", "GitCode 评论证据", entry, id);
    const { overflow, ...inline } = report;
    const continued = counts.get(id) ?? 0;
    const ciReport = { ...inline, continued, omitted: overflow.length - continued };
    return emit("gitcode.comment.observed", "GitCode 评论证据", { ...entry, ciReport }, id);
  });
  return [...events, ...emitEvidence(parts, emit)];
}

function logins(raw: unknown, text: Text) {
  if (!Array.isArray(raw)) return { names: null, incomplete: true };
  const entries = raw.slice(0, 12).map((entry) => text(typeof entry === "string" ? entry : record(entry).login, 64));
  return {
    names: [...new Set(entries.map(({ text }) => text).filter(Boolean))].sort(),
    incomplete: entries.length < raw.length || entries.some(({ text, truncated }) => !text || truncated),
  };
}

function people(target: Target, item: Record<string, unknown>, text: Text) {
  const assignees = logins(item.assignees, text);
  const testers = target.kind === "pr" ? logins(item.testers, text) : null;
  const data = {
    facet: "people",
    coverage: assignees.incomplete || testers?.incomplete ? "partial" : "complete",
    assignees: assignees.names,
    ...(testers ? { testers: testers.names } : {}),
  };
  if (target.kind !== "pr") return data;
  const raw = item.approval_reviewers;
  if (!Array.isArray(raw)) return { ...data, approvalReviewers: null, approvalCoverage: "unverified" };
  const reviewers = raw.slice(0, 12).flatMap((value) => {
    const reviewer = record(value);
    const login = text(reviewer.login ?? record(reviewer.user).login, 64);
    const state = text(reviewer.accept_status ?? reviewer.state ?? reviewer.status, 48);
    return login.text && !login.truncated && !state.truncated
      ? [
          {
            id: actorId(reviewer.id ?? record(reviewer.user).id),
            login: login.text,
            accepted: typeof reviewer.accept === "boolean" ? reviewer.accept : null,
            state: state.text || null,
          },
        ]
      : [];
  });
  const { chunks } = pack(reviewers, 3500 - JSON.stringify(data).length, 1);
  const approvalReviewers = chunks[0];
  return {
    ...data,
    approvalReviewers,
    approvalCoverage: approvalReviewers.length === raw.length ? "complete" : "partial",
  };
}

async function related(
  target: Target,
  item: Record<string, unknown>,
  read: Read,
  token: string,
  account: string,
  text: Text,
  maxFileParts: number,
) {
  const evidence =
    target.kind === "pr"
      ? await changes(read, target, item, token, maxFileParts)
      : await references(read, target, account, text);
  return [people(target, item, text), ...evidence];
}

function emitEvidence(values: Evidence[], emit: Emit) {
  return values.map((data, index) =>
    emit("gitcode.evidence.observed", "GitCode 补充证据", data, `evidence:${data.facet}:${index + 1}`),
  );
}

async function verify(scan: Scan, read: Read, config: Config, token: string, emit: Emit) {
  const { target } = scan;
  const path = `/repos/${target.repo}/${collection(target)}/${target.number}`;
  const reply = await read(path);
  if ("reason" in reply) return [failed(emit, target, reply.reason)];
  const item = record(reply.value);
  if (decimal(item.number) !== target.number || typeof item.state !== "string" || !item.state)
    return [failed(emit, target, "invalid_response")];
  const text = textReader(token);
  const body = text(item.body, 400);
  const { items, nextPage, ...comments } = await pages(
    read,
    `${path}/comments`,
    {},
    (value) => comment(value, text, config.botIds),
    20,
    target.page,
  );
  const nextRequest = nextPage && { type: VERIFY, subject: scanSubject(target, nextPage) };
  const continued = scan.auto && scan.canFollow && nextRequest;
  const follow = continued ? [scanEvent(scan, FOLLOW, continued.subject)] : [];
  const firstPage = target.page === 1;
  const maxFileParts = Math.min(8, Math.floor((100 - items.length - 5 - follow.length) / 2));
  const [evidence, links, ci] = await Promise.all(
    firstPage
      ? [
          related(target, item, read, token, config.account, text, maxFileParts),
          platformLinks(read, path, target, config, text),
          target.kind === "pr" ? platformCi(read, target, pullRevision(item).headSha, text) : null,
        ]
      : [[], null, null],
  );
  const available = 100 - 1 - items.length - evidence.length - follow.length;
  const structured = links ? platformParts(links, ci, Math.min(10, available - 1)) : [];
  const object = emit("gitcode.object.observed", "GitCode 事项核实", {
    coverage: comments.coverage === "complete" ? "complete" : "partial",
    ...(firstPage ? {} : { scope: "comment-page", canonicalSubject: scanSubject(target) }),
    title: text(item.title, 150).text,
    state: text(item.state, 32).text,
    author: text(author(item), 64).text,
    updatedAt: text(item.updated_at, 40).text,
    createdAt: text(item.created_at ?? item.issue_created_at, 40).text || null,
    closedAt: text(item.closed_at ?? item.issue_closed_at, 40).text || null,
    body: body.text,
    bodyTruncated: body.truncated,
    ...labels(item.labels, text),
    ...(target.kind === "pr"
      ? { ...prFacts(item, text), currentCi: ci?.observed ? "observed" : "unverified" }
      : issueFacts(item, text)),
    comments: {
      ...comments,
      count: items.length,
      ...(firstPage ? {} : { startPage: target.page }),
      ...(nextRequest ? { nextRequest, continuationQueued: Boolean(continued) } : {}),
    },
  });
  const discussion = discussionEvents(items, available - structured.length, emit);
  return [object, ...discussion, ...emitEvidence([...evidence, ...structured], emit), ...follow];
}

function failed(emit: Emit, target: Target | null, reason: string) {
  const type = target?.number === "own" ? "discovery" : target ? "object" : "request";
  return emit(`gitcode.${type}.observed`, "GitCode 未取得观察", { coverage: "failed", reason });
}

function emitter(
  run: string,
  account: string,
  target: Target | null,
  now = () => new Date().toISOString(),
  scanRun?: string | null,
): Emit {
  const subject = target ? target.subject : "gitcode:invalid";
  return (type, summary, data, suffix = "result") => ({
    id: `gitcode:${run}:${subject}:${suffix}`,
    type,
    subject,
    summary,
    detail: JSON.stringify({
      version: 1,
      observedAt: now(),
      account,
      ...(scanRun ? { scanRun } : {}),
      ...data,
    }),
    link: target ? linkFor(target) : "",
  });
}

export async function runCollector(
  mode: "schedule" | "collect",
  config: Config,
  events: unknown[],
  run: string,
  options: Options,
): Promise<Event[]> {
  if (!decimal(run)) throw new Error("采集轮次无效");
  if (mode === "schedule") return schedule(config, run);
  const input = readTarget(events, config);
  const target = input?.target ?? null;
  const scanRun = input?.auto ? (input.scanRun ?? run) : null;
  const emit = emitter(run, config.account, target, options.now, scanRun);
  if (!input || !target) return [failed(emit, null, "invalid_request")];
  if (!options.token) return [failed(emit, target, "missing_token")];
  const read = reader(options);
  const error = await checkAccount(read, config.account);
  if (error) return [failed(emit, target, error)];
  const scan = { ...input, scanRun, run };
  if (target.number === "own") return discover(scan, config, read, emit);
  return verify(scan, read, config, options.token, emit);
}
