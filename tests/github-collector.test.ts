// Failure modes: wrong repository identity, incomplete reads treated as no change, or webhook compatibility lost.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import github from "../plugins/github/source.ts";
import { collectGitHub, type GitHubRead } from "../plugins/github/collector.ts";

const repo = "Alpha/Example";
const update = "2026-11-19T08:00:00Z";
const sha = "a".repeat(40);
const connection = (nodes: unknown[] = [], hasNextPage = false, endCursor?: string, totalCount = nodes.length) => ({
  nodes,
  totalCount,
  pageInfo: { hasNextPage, endCursor },
});
const envelope = (node: object) => ({ data: { repository: { nameWithOwner: repo, item: node } } });
const comment = (id: string) => ({
  id,
  author: { login: "alice" },
  body: id,
  url: `https://github.com/${repo}/pull/7#${id}`,
  createdAt: update,
  updatedAt: update,
});
const item = (kind: "issue" | "pr", number = 7) => ({
  number,
  title: "Title",
  body: "See #8",
  url: `https://github.com/${repo}/${kind === "pr" ? "pull" : "issues"}/${number}`,
  state: "OPEN",
  updatedAt: update,
  author: { login: "alice" },
  labels: connection([{ name: "bug" }]),
  assignees: connection([{ login: "bob" }]),
  comments: connection([{ id: "one", author: null, body: "hello", createdAt: update, updatedAt: update }]),
  ...(kind === "issue"
    ? { links: connection() }
    : {
        links: connection([
          { number: 8, state: "OPEN", url: `https://github.com/${repo}/issues/8`, repository: { nameWithOwner: repo } },
        ]),
        isDraft: false,
        mergeable: "MERGEABLE",
        mergeStateStatus: "CLEAN",
        reviewDecision: "APPROVED",
        headRefOid: "b".repeat(40),
        baseRefName: "release/v2",
        baseRefOid: sha,
        reviews: connection([
          { id: "review", state: "APPROVED", body: "LGTM", author: { login: "bob" }, submittedAt: update },
        ]),
        files: connection([{ path: "src/example.ts" }]),
        reviewThreads: connection(),
        statusCheckRollup: {
          state: "SUCCESS",
          contexts: connection([{ __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "SUCCESS" }]),
        },
      }),
});

const verify = { mode: "verify", repo, kind: "pr", number: 7 } as const;
const discover = { mode: "discover", repo, author: "alice" } as const;
const read: GitHubRead = async (operation) => {
  if (operation.type === "search")
    return { total_count: 1, incomplete_results: false, items: [{ number: operation.kind === "issue" ? 8 : 7 }] };
  if (operation.type === "object")
    return { data: { repository: { nameWithOwner: repo, item: item(operation.kind, operation.number) } } };
  assert.equal(operation.type, "compare");
  assert.equal(operation.ref, "release/v2");
  assert.equal(operation.oid, sha);
  return { files: [{ filename: "src/example.ts" }, { filename: "README.md" }] };
};

test("author discovery and direct verification share object evidence and stable fingerprints", async () => {
  const batch = await collectGitHub(discover, read);
  const direct = await collectGitHub(verify, read);
  assert.equal(batch.status, "complete");
  assert.equal(batch.version, 1);
  assert.deepEqual(batch.scope, { mode: "discover", author: "alice" });
  assert.equal(batch.limits.discoveredPerKind, 1000);
  assert.deepEqual(direct.scope, { mode: "verify", kind: "pr", number: 7 });
  assert.deepEqual(
    batch.observations.map((observation) => observation.key),
    ["github:alpha/example:issue:8", "github:alpha/example:pr:7"],
  );
  const [pr] = direct.observations;
  assert.equal(pr.fingerprint, batch.observations[1].fingerprint);
  assert.ok(pr.fingerprint);
  assert.equal(pr.change, "baseline");
  assert.deepEqual(pr.fields?.overlap, ["src/example.ts"]);
  assert.equal(pr.fields?.links[0].repo, "alpha/example");
  const repeated = await collectGitHub({ ...verify, previous: { [pr.key]: pr.fingerprint } }, read);
  assert.equal(repeated.observations[0].change, "unchanged");
  assert.notEqual(repeated.observedAt, undefined);
});

test("an independent search can still succeed when the other fails; errors contain no remote text", async () => {
  const result = await collectGitHub(discover, async (operation) => {
    if (operation.type === "search" && operation.kind === "issue") throw new Error("secret in stderr");
    return read(operation);
  });
  assert.equal(result.status, "partial");
  assert.equal(result.observations.length, 1);
  assert.match(JSON.stringify(result), /read-failed/);
  assert.doesNotMatch(JSON.stringify(result), /secret/);
  const failed = await collectGitHub(verify, async () => ({
    data: { repository: { nameWithOwner: repo, item: null } },
  }));
  assert.equal(failed.status, "failed");
  assert.equal(failed.observations[0].change, "unknown");
});

test("search truncation, nested pagination and comparison limits cannot report unchanged", async () => {
  const result = await collectGitHub(discover, async (operation) => {
    if (operation.type === "search" && operation.kind === "pr") {
      return { total_count: 800, incomplete_results: true, items: operation.page === 1 ? [{ number: 7 }] : [] };
    }
    if (operation.type === "object" && operation.kind === "pr") {
      return { data: { repository: { nameWithOwner: repo, item: { ...item("pr"), reviews: connection([], true) } } } };
    }
    if (operation.type === "compare")
      return { files: Array.from({ length: 300 }, (_, index) => ({ filename: `file-${index}` })) };
    return read(operation);
  });
  assert.equal(result.status, "partial");
  const pr = result.observations[1];
  assert.equal(pr.change, "unknown");
  assert.equal(pr.fingerprint, null);
  assert.deepEqual(
    pr.problems.map((problem) => problem.facet),
    ["reviews", "compare"],
  );
});

test("wrong object identity is rejected and a compare failure preserves usable PR evidence", async () => {
  const wrong = await collectGitHub(verify, async () => ({
    data: { repository: { nameWithOwner: "other/repo", item: item("pr") } },
  }));
  assert.equal(wrong.status, "failed");
  const partial = await collectGitHub(verify, async (operation) => {
    if (operation.type === "compare") throw new Error("unavailable");
    return read(operation);
  });
  assert.equal(partial.status, "partial");
  assert.equal(partial.observations[0].fields?.overlap, null);
});

test("upstream rename overlaps a file touched by the PR at the original path", async () => {
  const result = await collectGitHub(verify, async (operation) =>
    operation.type === "compare"
      ? { files: [{ filename: "src/renamed.ts", previous_filename: "src/example.ts" }] }
      : read(operation),
  );
  assert.equal(result.status, "complete");
  assert.deepEqual(result.observations[0].fields?.overlap, ["src/example.ts"]);
});

test("malformed comparison cannot certify an empty overlap", async () => {
  for (const wrong of [{}, { files: [{ filename: "src/renamed.ts", previous_filename: false }] }]) {
    const result = await collectGitHub(verify, async (operation) =>
      operation.type === "compare" ? wrong : read(operation),
    );
    assert.equal(result.status, "partial");
    assert.equal(result.observations[0].fields?.overlap, null);
    assert.deepEqual(result.observations[0].problems, [{ facet: "compare", reason: "invalid-response" }]);
  }
});

test("the author comment evidence window cannot turn #80 into a link to #8", async () => {
  const result = await collectGitHub(discover, async (operation) => {
    if (operation.type !== "object" || operation.kind !== "pr") return read(operation);
    const node = {
      ...item("pr"),
      body: "No mention",
      links: connection(),
      comments: connection([
        { id: "one", author: { login: "alice" }, body: `${"a".repeat(497)} #80`, createdAt: update, updatedAt: update },
      ]),
    };
    return { data: { repository: { nameWithOwner: repo, item: node } } };
  });
  assert.equal(result.status, "complete");
  assert.deepEqual(result.inferredLinks, []);
});

test("metadata-only updates do not signal a change, but a comment edit does", async () => {
  const [original] = (await collectGitHub(verify, read)).observations;
  const input = { ...verify, previous: { [original.key]: original.fingerprint } };
  const withComment =
    (body: string): GitHubRead =>
    async (operation) => {
      if (operation.type !== "object") return read(operation);
      const updatedAt = "2026-11-19T09:00:00Z";
      const current = {
        ...item("pr"),
        updatedAt,
        comments: connection([{ id: "one", author: null, body, createdAt: update, updatedAt }]),
      };
      return { data: { repository: { nameWithOwner: repo, item: current } } };
    };
  const same = await collectGitHub(input, withComment("hello"));
  assert.equal(same.observations[0].change, "unchanged");
  assert.equal(same.observations[0].fields?.updatedAt, "2026-11-19T09:00:00Z");
  const changed = await collectGitHub(input, withComment("edited"));
  assert.equal(changed.observations[0].change, "changed");
});

test("complete empty discovery is a successful observation of the scope, not an error or deletion", async () => {
  const calls: string[] = [];
  const result = await collectGitHub(discover, async (operation) => {
    assert.equal(operation.type, "search");
    calls.push(`${operation.kind}:${operation.page}`);
    return { total_count: 0, incomplete_results: false, items: [] };
  });
  assert.equal(result.status, "complete");
  assert.deepEqual(result.observations, []);
  assert.deepEqual(calls.sort(), ["issue:1", "pr:1"]);
});

test("bad targets and broadened scopes fail before the remote reader is called", async () => {
  let called = false;
  const reader = async () => {
    called = true;
  };
  for (const invalid of [
    { ...verify, kind: "discussion" },
    { ...verify, number: 0 },
    { ...verify, number: 1.2 },
    { ...verify, number: "7" },
    { ...discover, author: "alice is:pr" },
    { ...discover, author: null },
    { mode: "other", repo, author: "alice" },
  ]) {
    await assert.rejects(collectGitHub(invalid, reader));
  }
  assert.equal(called, false);
});

test("GraphQL partial-error envelopes and missing repositories cannot certify current state", async () => {
  const mixed = await collectGitHub(verify, async () => ({
    errors: [{ message: "permission" }],
    data: { repository: { nameWithOwner: repo, item: item("pr") } },
  }));
  assert.equal(mixed.status, "failed");
  assert.equal(mixed.observations[0].problems[0].reason, "invalid-response");
  const wrongRepo = await collectGitHub(verify, async () => ({ data: { repository: null } }));
  assert.equal(wrongRepo.status, "failed");
  assert.equal(wrongRepo.observations[0].problems[0].reason, "not-found");
});

test("invalid search payload or nested comments never look like a complete empty read", async () => {
  const noSearch = await collectGitHub(discover, async () => ({ total_count: 0, items: [] }));
  assert.equal(noSearch.status, "failed");
  assert.ok(noSearch.problems.every((entry) => entry.reason === "invalid-response"));
  const result = await collectGitHub(verify, async (operation) => {
    if (operation.type !== "object") return read(operation);
    const node = { ...item("pr"), comments: connection([null, { id: "bad" }]), labels: {} };
    return { data: { repository: { nameWithOwner: repo, item: node } } };
  });
  assert.equal(result.status, "partial");
  assert.deepEqual(result.observations[0].problems, [
    { facet: "labels", reason: "invalid-response" },
    { facet: "comments", reason: "invalid-response" },
  ]);
});

test("equivalent connection ordering yields the same fingerprint without losing activity", async () => {
  const fixture =
    (order: string[]): GitHubRead =>
    async (operation) => {
      if (operation.type !== "object") return read(operation);
      const node = {
        ...item("pr"),
        comments: connection(order.map((id) => ({ id, author: null, body: id, createdAt: update, updatedAt: update }))),
      };
      return { data: { repository: { nameWithOwner: repo, item: node } } };
    };
  const [original] = (await collectGitHub(verify, fixture(["b", "a", "c"]))).observations;
  const [reordered] = (await collectGitHub(verify, fixture(["c", "a", "b"]))).observations;
  assert.deepEqual(
    original.fields?.comments.map((comment) => comment.id),
    ["a", "b", "c"],
  );
  assert.equal(original.fingerprint, reordered.fingerprint);
});

test("terminal PRs report nullable review and CI without reading the base branch", async () => {
  const result = await collectGitHub(verify, async (operation) => {
    assert.equal(operation.type, "object");
    const node = { ...item("pr"), state: "MERGED", reviewDecision: null, statusCheckRollup: null };
    return { data: { repository: { nameWithOwner: repo, item: node } } };
  });
  assert.equal(result.status, "complete");
  const [pr] = result.observations;
  assert.deepEqual(
    [pr.fields?.state, pr.fields?.reviewDecision, pr.fields?.ci, pr.fields?.overlap],
    ["MERGED", null, null, []],
  );
});

test("check runs and legacy status contexts retain their separate status and link evidence", async () => {
  const result = await collectGitHub(verify, async (operation) => {
    if (operation.type !== "object") return read(operation);
    const node = {
      ...item("pr"),
      statusCheckRollup: {
        state: "PENDING",
        contexts: connection([
          { __typename: "StatusContext", context: "lint", state: "PENDING", targetUrl: "https://example.com/lint" },
          {
            __typename: "CheckRun",
            databaseId: 501,
            name: "test",
            status: "IN_PROGRESS",
            conclusion: null,
            detailsUrl: null,
            checkSuite: { workflowRun: { databaseId: 400, runAttempt: 1, workflow: { name: "Build" } } },
          },
          {
            __typename: "CheckRun",
            name: "test",
            status: "QUEUED",
            conclusion: null,
            detailsUrl: null,
            checkSuite: null,
          },
        ]),
      },
    };
    return { data: { repository: { nameWithOwner: repo, item: node } } };
  });
  assert.equal(result.status, "complete");
  const ci = result.observations[0].fields?.ci;
  assert.deepEqual(
    ci && {
      state: ci.state,
      checks: ci.checks.map((entry) => ({
        kind: entry.kind,
        name: entry.name,
        ...(entry.kind === "check" ? { workflowName: entry.workflowName } : {}),
        status: entry.status,
        conclusion: entry.conclusion,
        url: entry.url,
      })),
    },
    {
      state: "PENDING",
      checks: [
        { kind: "check", name: "test", workflowName: "Build", status: "IN_PROGRESS", conclusion: null, url: null },
        { kind: "check", name: "test", workflowName: null, status: "QUEUED", conclusion: null, url: null },
        { kind: "status", name: "lint", status: "PENDING", conclusion: null, url: "https://example.com/lint" },
      ],
    },
  );
});

test("saturated search fetches page two and rejects duplicate coverage and wrong authors", async () => {
  const pages: number[] = [];
  const result = await collectGitHub(discover, async (operation) => {
    if (operation.type === "search" && operation.kind === "issue") {
      pages.push(operation.page);
      return {
        total_count: 101,
        incomplete_results: false,
        items: Array.from({ length: operation.page === 1 ? 100 : 1 }, (_, index) => ({ number: index + 1 })),
      };
    }
    if (operation.type === "object" && operation.kind === "issue") {
      return {
        data: {
          repository: { nameWithOwner: repo, item: { ...item("issue", operation.number), author: { login: "other" } } },
        },
      };
    }
    return read(operation);
  });
  assert.deepEqual(pages, [1, 2]);
  assert.deepEqual(result.problems, [{ facet: "discovery:issue", reason: "truncated" }]);
  const issues = result.observations.filter((item) => item.kind === "issue");
  assert.equal(issues.length, 100);
  assert.ok(issues.every((item) => item.status === "failed" && item.problems[0].reason === "scope-mismatch"));
});

test("discovery continues past the old 200-object boundary", async () => {
  const pages: number[] = [];
  const result = await collectGitHub(discover, async (operation) => {
    if (operation.type === "search" && operation.kind === "issue") {
      pages.push(operation.page);
      return {
        total_count: 201,
        incomplete_results: false,
        items: Array.from({ length: operation.page < 3 ? 100 : 1 }, (_, index) => ({
          number: (operation.page - 1) * 100 + index + 1,
        })),
      };
    }
    return read(operation);
  });
  assert.deepEqual(pages, [1, 2, 3]);
  assert.equal(result.status, "complete");
  assert.ok(result.observations.some((entry) => entry.key === "github:alpha/example:issue:201"));
});

test("comments follow cursors and a changed object or repeated cursor cannot certify completeness", async () => {
  const target = { mode: "verify", repo, kind: "issue", number: 7 } as const;
  const firstPage = { ...item("issue"), comments: connection([comment("first")], true, "one", 2) };
  const after = { ...item("issue"), comments: connection([comment("second")], false, undefined, 2) };
  const collect = (next: typeof after) =>
    collectGitHub(target, async (operation) => {
      if (operation.type === "object") return envelope(firstPage);
      assert.equal(operation.type, "page");
      assert.equal(operation.facet, "comments");
      assert.equal(operation.cursor, "one");
      return envelope(next);
    });
  const complete = await collect(after);
  assert.equal(complete.status, "complete");
  assert.deepEqual(
    complete.observations[0].fields?.comments.map((entry) => entry.id),
    ["first", "second"],
  );
  for (const next of [
    { ...after, updatedAt: "2026-11-19T09:00:00Z" },
    { ...after, comments: connection([comment("first")], false, undefined, 2) },
    { ...after, comments: connection([comment("second")], true, "one", 2) },
  ]) {
    const partial = await collect(next);
    assert.equal(partial.status, "partial");
    assert.equal(partial.observations[0].fingerprint, null);
    assert.equal(partial.observations[0].fields?.comments[0].id, "first");
  }
});

test("review threads retain resolution, file location and every reply across both cursor levels", async () => {
  const thread = {
    id: "thread-id",
    path: "src/example.ts",
    line: 5,
    originalLine: 4,
    isResolved: false,
    isOutdated: true,
  };
  const first = { ...thread, comments: connection([comment("first")], true, "reply-cursor", 2) };
  const closed = { ...thread, id: "resolved-id", isResolved: true, comments: connection([comment("resolved")]) };
  const result = await collectGitHub(verify, async (operation) => {
    if (operation.type === "object")
      return envelope({ ...item("pr"), reviewThreads: connection([first], true, "thread-cursor", 2) });
    if (operation.type === "page" && operation.facet === "reviewThreads") {
      assert.equal(operation.cursor, "thread-cursor");
      return envelope({ ...item("pr"), reviewThreads: connection([closed], false, undefined, 2) });
    }
    if (operation.type === "threadComments") {
      assert.equal(operation.threadId, thread.id);
      assert.equal(operation.cursor, "reply-cursor");
      return {
        data: {
          node: {
            ...thread,
            repository: { nameWithOwner: repo },
            pullRequest: item("pr"),
            comments: connection([comment("reply")], false, undefined, 2),
          },
        },
      };
    }
    return read(operation);
  });
  const [observation] = result.observations;
  assert.equal(result.status, "complete");
  const threads = observation.fields?.reviewThreads;
  assert.equal(threads?.length, 2);
  assert.equal(threads?.find((entry) => entry.id === thread.id)?.isOutdated, true);
  assert.equal(threads?.find((entry) => entry.id === "resolved-id")?.isResolved, true);
  assert.deepEqual(
    threads?.find((entry) => entry.id === thread.id)?.comments.map((entry) => entry.body),
    ["first", "reply"],
  );
});

test("CI reruns retain exact check-to-attempt evidence and never assume the latest attempt", async () => {
  const run = {
    databaseId: 400,
    runAttempt: 2,
    event: "pull_request",
    createdAt: update,
    workflow: { databaseId: 30, name: "Build" },
  };
  const contexts = connection(
    [501, 502].map((id) => ({
      __typename: "CheckRun",
      id: `check-${id}`,
      databaseId: id,
      name: "test",
      status: "COMPLETED",
      conclusion: id === 501 ? "FAILURE" : "SUCCESS",
      startedAt: update,
      completedAt: update,
      checkSuite: { app: { slug: "github-actions" }, workflowRun: run },
    })),
  );
  let calls = 0;
  const collect = (findBoth: boolean) =>
    collectGitHub(verify, async (operation) => {
      if (operation.type === "object")
        return envelope({ ...item("pr"), statusCheckRollup: { state: "SUCCESS", contexts } });
      if (operation.type === "jobs") {
        calls++;
        assert.equal(operation.runId, 400);
        assert.equal(operation.page, 1);
        const jobs = (findBoth ? [501, 502] : [502]).map((id) => ({
          run_id: 400,
          run_attempt: id === 501 ? 1 : 2,
          check_run_url: `https://api.github.com/repos/${repo}/check-runs/${id}`,
        }));
        return { total_count: jobs.length, jobs };
      }
      return read(operation);
    });
  const [complete] = (await collect(true)).observations;
  assert.equal(calls, 1);
  assert.equal(complete.status, "complete");
  const checks = complete.fields?.ci?.checks.filter((entry) => entry.kind === "check");
  assert.deepEqual(
    checks?.map((entry) => [entry.checkId, entry.attempt, entry.workflowRun?.latestAttempt, entry.completedAt]),
    [
      [501, 1, 2, update],
      [502, 2, 2, update],
    ],
  );
  const [partial] = (await collect(false)).observations;
  assert.equal(partial.status, "partial");
  assert.equal(
    partial.fields?.ci?.checks.find((entry) => entry.kind === "check" && entry.checkId === 501)?.kind,
    "check",
  );
  assert.equal(partial.fingerprint, null);
});

test("conflicting CI attempts across cursor pages are not an unchanged observation", async () => {
  const check = (id: number, runAttempt: number | null) => ({
    __typename: "CheckRun",
    id: `check-${id}`,
    databaseId: id,
    name: "test",
    status: "COMPLETED",
    conclusion: "SUCCESS",
    checkSuite: { workflowRun: { databaseId: 400, runAttempt } },
  });
  const result = await collectGitHub(verify, async (operation) => {
    const pull = item("pr");
    if (operation.type === "object")
      return envelope({
        ...pull,
        statusCheckRollup: { state: "SUCCESS", contexts: connection([check(501, 1)], true, "ci-after", 2) },
      });
    if (operation.type === "page")
      return envelope({
        ...pull,
        statusCheckRollup: { state: "SUCCESS", contexts: connection([check(502, 2)], false, undefined, 2) },
      });
    if (operation.type === "jobs")
      return {
        total_count: 1,
        jobs: [{ run_id: 400, run_attempt: 2, check_run_url: `https://api.github.com/repos/${repo}/check-runs/502` }],
      };
    return read(operation);
  });
  assert.equal(result.status, "partial");
  const [pr] = result.observations;
  assert.deepEqual(pr.problems, [{ facet: "ciAttempts:400", reason: "object-changed" }]);
  assert.ok(pr.fields?.ci?.checks.every((entry) => entry.kind === "check" && entry.attempt === null));
  assert.equal(pr.fingerprint, null);
  const missing = await collectGitHub(verify, async (operation) =>
    operation.type === "object"
      ? envelope({ ...item("pr"), statusCheckRollup: { state: "SUCCESS", contexts: connection([check(501, null)]) } })
      : read(operation),
  );
  assert.deepEqual(missing.observations[0].problems, [{ facet: "ciAttempts:400", reason: "attempt-unverified" }]);
});

test("a missing connection total does not prove there are no comments", async () => {
  const result = await collectGitHub({ mode: "verify", repo, kind: "issue", number: 7 }, async () =>
    envelope({ ...item("issue"), comments: { nodes: [], pageInfo: { hasNextPage: false } } }),
  );
  assert.equal(result.status, "partial");
  assert.deepEqual(result.observations[0].problems, [{ facet: "comments", reason: "invalid-response" }]);
});

test("an already exhausted remote budget does not fall through to a GitHub request", async () => {
  const { githubReader } = await import("../plugins/github/collector.ts");
  const result = await collectGitHub(verify, githubReader(AbortSignal.abort()));
  assert.equal(result.status, "failed");
  assert.deepEqual(result.observations[0].problems, [{ facet: "object", reason: "budget-exhausted" }]);
});

test(
  "the one-shot command exercises search, GraphQL and compare through gh",
  { skip: process.platform === "win32" },
  () => {
    const folder = mkdtempSync(join(tmpdir(), "autoloop-github-"));
    try {
      const script = `#!/bin/sh
test "$1 $2 $3" = 'api --hostname github.com' || exit 1
case "$4" in
  search/issues*is%3Aissue*) echo '{"total_count":1,"incomplete_results":false,"items":[{"number":8}]}' ;;
  search/issues*is%3Apr*) echo '{"total_count":1,"incomplete_results":false,"items":[{"number":7}]}' ;;
  graphql)
    case "$*" in
      *number=7) printf '%s\\n' "$FIXTURE_PR" ;;
      *number=8) printf '%s\\n' "$FIXTURE_ISSUE" ;;
      *) exit 1 ;;
    esac ;;
  'repos/alpha/example/compare/${sha}...release%2Fv2?per_page=1&page=1') echo '{"files":[{"filename":"src/example.ts"}]}' ;;
  *) exit 1 ;;
esac
`;
      writeFileSync(join(folder, "gh"), script, { mode: 0o700 });
      const collector = fileURLToPath(new URL("../plugins/github/collector.ts", import.meta.url));
      const envelope = (node: object) => JSON.stringify({ data: { repository: { nameWithOwner: repo, item: node } } });
      const invoke = (request: unknown) =>
        spawnSync(process.execPath, [collector, JSON.stringify(request)], {
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: `${folder}${delimiter}${process.env.PATH}`,
            FIXTURE_ISSUE: envelope(item("issue", 8)),
            FIXTURE_PR: envelope(item("pr")),
          },
        });
      const found = invoke(discover);
      assert.equal(found.status, 0, found.stderr);
      const batch = JSON.parse(found.stdout);
      assert.equal(batch.status, "complete");
      assert.equal(batch.inferredLinks[0].issue, "github:alpha/example:issue:8");
      const pr = batch.observations[1];
      assert.deepEqual(pr.fields.overlap, ["src/example.ts"]);
      const manual = invoke({ ...verify, previous: { [pr.key]: pr.fingerprint } });
      assert.equal(manual.status, 0);
      assert.equal(JSON.parse(manual.stdout).observations[0].change, "unchanged");
      assert.equal(invoke({ ...verify, repo: "../example" }).status, 2);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  },
);

test("signed comments retain release text and CI clues preserve webhook identity", () => {
  const send = (kind: string, payload: object) => {
    const secret = "testing";
    const body = JSON.stringify({ repository: { full_name: repo }, ...payload });
    const headers = {
      "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
      "x-github-event": kind,
      "x-github-delivery": "delivery",
    };
    return github({ headers, body, secret })[0];
  };
  const comment = send("issue_comment", {
    action: "created",
    issue: { number: 7, body: "issue" },
    comment: { body: "a".repeat(3999) + "😀" },
  });
  assert.equal(comment.detail, "a".repeat(3999));
  const check = send("check_run", {
    action: "completed",
    check_run: { head_sha: sha, pull_requests: [{ number: 7 }] },
  });
  assert.deepEqual(
    [check.id, check.type, check.subject, check.detail],
    ["delivery", "check_run.completed", repo, `head=${sha} prs=7`],
  );
  assert.equal(send("push", { after: sha, ref: "refs/heads/release/v2" }).detail, `head=${sha} branch=release/v2`);
  assert.equal(send("status", { sha, branches: [{ name: "main" }] }).detail, `head=${sha} branch=main`);
  assert.equal(
    send("check_suite", { check_suite: { head_sha: sha, head_branch: "main" } }).detail,
    `head=${sha} branch=main`,
  );
  assert.equal(
    send("workflow_run", { workflow_run: { head_sha: sha, pull_requests: [{ number: 7 }, { number: 9 }] } }).detail,
    `head=${sha} prs=7,9`,
  );
  assert.equal(send("push", { after: "0".repeat(40) }).detail, "");
  assert.deepEqual(
    github({
      headers: {
        "x-github-event": "ping",
        "x-hub-signature-256": `sha256=${createHmac("sha256", "k").update("{}").digest("hex")}`,
      },
      body: "{}",
      secret: "k",
    }),
    [],
  );
  const headers = { "x-github-event": "issues", "x-hub-signature-256": `sha256=${"a".repeat(64)}` };
  assert.throws(() => github({ headers, body: "{}", secret: "k" }), /signature/);
  assert.throws(() => github({ headers, body: "{}", secret: "" }), /signature/);
  assert.throws(() => github({ headers: {}, body: "{}", secret: "k" }), /signature/);
});
