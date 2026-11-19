// The old tracker silently turned missing files into “no overlap” and comment text into current CI.
import assert from "node:assert/strict";
import { test } from "node:test";
import { readMessage, resultFrom } from "../worker/contract.ts";
import { parseConfig, runCollector } from "../plugins/gitcode/collector.ts";
import { evidenceParts, pack } from "../plugins/gitcode/evidence.ts";
import { ciReport, reviewSummary } from "../plugins/gitcode/reports.ts";

const base = "a".repeat(40);
const head = "b".repeat(40);
const tip = "c".repeat(40);
const bot = "68efbe75d3e71e35266cc152";
const credential = "private-fixture-token";
const pull = {
  number: 7,
  state: "open",
  draft: true,
  mergeable: false,
  can_merge_check: false,
  head: { sha: head },
  base: { sha: base, ref: "release/next" },
  assignees: [{ login: "reviewer" }],
  testers: [{ login: "qa" }],
};

function verify(
  kind: "pr" | "issue",
  reply: (path: string, params: URLSearchParams) => unknown,
  botIds: string[] = [],
) {
  const subject = `gitcode:team/repo:${kind}:7`;
  const config = parseConfig({ account: "me", repositories: ["Team/Repo"], botIds });
  const fetcher: typeof fetch = async (input) => {
    const url = new URL(String(input));
    const path = url.pathname.replace(/^\/api\/v[58]\/repos\/Team\/Repo/, "");
    const value = path === "/api/v5/user" ? { login: "me" } : reply(path, url.searchParams);
    return value instanceof Response ? value : Response.json(value);
  };
  return runCollector(
    "collect",
    config,
    [{ source: "gitcode-request", type: "gitcode.verify.requested", subject }],
    "1",
    { token: credential, fetcher },
  );
}

type Receipt = Awaited<ReturnType<typeof verify>>;
const facet = (events: Receipt, name: string) =>
  events
    .filter(({ type }) => type === "gitcode.evidence.observed")
    .map(({ detail }) => JSON.parse(detail))
    .filter(({ facet }) => facet === name);

test("PR facts include review fields, changed paths and the intersection against a pinned destination", async () => {
  const paths: string[] = [];
  const events = await verify("pr", (path, params) => {
    paths.push(path);
    if (path === "/pulls/7") return pull;
    if (path === "/pulls/7/files")
      return params.get("page") === "1" ? [{ filename: " b/src.ts " }, { filename: "other.ts" }] : [];
    if (path === "/branches/release%2Fnext") return { commit: { sha: tip } };
    if (path === `/compare/${base}...${tip}`) return { files: [{ filename: " b/src.ts " }], truncated: false };
    return [];
  });
  const object = JSON.parse(events[0].detail);
  assert.deepEqual(
    [object.draft, object.mergeable, object.canMergeCheck, object.baseSha, object.baseRef],
    [true, false, false, base, "release/next"],
  );
  const [people] = facet(events, "people");
  assert.deepEqual([people.assignees, people.testers], [["reviewer"], ["qa"]]);
  const [files] = facet(events, "files");
  assert.deepEqual(
    [files.paths, files.coverage, files.revisionVerified],
    [[" b/src.ts ", "other.ts"], "complete", true],
  );
  const [overlap] = facet(events, "overlap");
  assert.deepEqual(
    [overlap.paths, overlap.coverage, overlap.baseSha, overlap.targetSha, overlap.headSha],
    [[" b/src.ts "], "complete", base, tip, head],
  );
  assert.equal(paths.filter((path) => path === "/pulls/7").length, 2);
});

test("a same-head diff count recovers files hidden behind the repeated page; a stale or inconsistent one does not", async () => {
  for (const variant of ["verified", "stale", "wrong_count", "missing_seen_path"] as const) {
    const events = await verify("pr", (path) => {
      if (path === "/pulls/7") return pull;
      if (path.endsWith("/files")) return [{ filename: "one.ts" }];
      if (path.endsWith("/files.json"))
        return {
          count: variant === "wrong_count" ? 3 : 2,
          diff_refs: { base_sha: base, start_sha: base, head_sha: variant === "stale" ? tip : head },
          diffs: [variant === "missing_seen_path" ? "other.ts" : "one.ts", "two.ts"].map((name) => ({
            statistic: { path: name },
          })),
        };
      if (path.startsWith("/branches/")) return { commit: { sha: tip } };
      if (path.startsWith("/compare/")) return { files: [{ filename: "two.ts" }], truncated: false };
      return [];
    });
    const [files] = facet(events, "files");
    const [overlap] = facet(events, "overlap");
    if (variant === "verified") {
      assert.deepEqual([files.paths, files.coverage, files.source], [["one.ts", "two.ts"], "complete", "pr-diff"]);
      assert.deepEqual([overlap.paths, overlap.coverage], [["two.ts"], "complete"]);
    } else {
      assert.deepEqual([files.paths, files.coverage], [["one.ts"], "partial"]);
      assert.equal(overlap.coverage, "partial");
    }
  }
});

test("official platform facts stay separate from references and only CI on the observed head is emitted", async () => {
  const events = await verify("pr", (path, query) => {
    if (path === "/pulls/7")
      return {
        ...pull,
        head: { sha: head, ref: "topic" },
        created_at: "2026-11-17T09:12:00Z",
        approval_reviewers: [{ id: 42, login: "reviewer", accept: false, accept_status: "reject" }],
        close_related_issue: false,
        mergeable_state: {
          approval_reviewers_required_passed: false,
          approval_approvers_required_passed: true,
          approval_testers_required_passed: true,
          approval_approvers_result: 2,
        },
      };
    if (path === "/pulls/7/issues" && query.get("page") === "1")
      return [{ number: 6, state: "open", html_url: "https://gitcode.com/Team/Repo/issues/6" }];
    if (path === "/actions/runs") {
      assert.equal(query.get("pull_request_id"), "7");
      return {
        total_count: 2,
        workflow_runs: [
          { workflow_run_id: "201", head_sha: tip, status: "completed", conclusion: "success" },
          {
            workflow_run_id: "202",
            head_sha: head,
            workflow_name: "Build",
            start_time: 1795000000,
            status: "completed",
            conclusion: "failure",
          },
        ],
      };
    }
    if (path === "/actions/runs/202/jobs")
      return {
        total_count: 1,
        jobs: [{ job_run_id: "job-8", name: "build", status: "completed", conclusion: "failure" }],
      };
    return [];
  });
  const object = JSON.parse(events[0].detail);
  assert.equal(object.createdAt, "2026-11-17T09:12:00Z");
  assert.equal(object.headRef, "topic");
  assert.equal(object.closeRelatedIssuesOnMerge, false);
  assert.deepEqual(object.approvalGate, {
    reviewersPassed: false,
    approversPassed: true,
    testersPassed: true,
    approversResult: 2,
    testersResult: null,
  });
  assert.equal(object.currentCi, "observed");
  const [people] = facet(events, "people");
  assert.deepEqual(people.approvalReviewers, [{ id: "42", login: "reviewer", accepted: false, state: "reject" }]);
  const [links] = facet(events, "platform-links");
  assert.deepEqual(
    links.links.map(({ number, relationship }: { number: string; relationship: string }) => [number, relationship]),
    [["6", "platform_related"]],
  );
  const [ci] = facet(events, "current-ci");
  assert.equal(ci.headSha, head);
  assert.deepEqual([ci.rows[0].name, ci.rows[0].startedAt, ci.rows[1].jobId], ["Build", 1795000000, "job-8"]);
  assert.deepEqual(
    ci.rows.map(({ runId, conclusion }: { runId: string; conclusion: string }) => [runId, conclusion]),
    [
      ["202", "failure"],
      ["202", "failure"],
    ],
  );
});

test("typed Issue metadata and native links can be reported without inventing the relationship from text", async () => {
  const events = await verify("issue", (path, query) => {
    if (path === "/issues/7")
      return { number: 7, state: "open", issue_type: "Bug", priority: 2, issue_priority_detail: { title: "High" } };
    if (path === "/issues/7/pull_requests" && query.get("page") === "1")
      return [{ number: 9, state: "opened", html_url: "https://gitcode.com/Team/Repo/merge_requests/9" }];
    return [];
  });
  const { issueType, priority, priorityName } = JSON.parse(events[0].detail);
  assert.deepEqual([issueType, priority, priorityName], ["Bug", 2, "High"]);
  assert.deepEqual(
    facet(events, "platform-links")[0].links.map(({ number }: { number: string }) => number),
    ["9"],
  );
  assert.deepEqual(facet(events, "issue-references")[0].references, []);
});

test("file pagination, compare failure, and a changing HEAD never prove there is no overlap", async () => {
  for (const failure of [
    "pagination_overlap",
    "http_503",
    "compare_truncated",
    "pr_revision_changed",
    "base_ref_changed",
  ]) {
    let reads = 0;
    const events = await verify("pr", (path, params) => {
      if (path === "/pulls/7") {
        if (++reads === 2 && failure === "pr_revision_changed") return { ...pull, head: { sha: tip } };
        if (reads === 2 && failure === "base_ref_changed") return { ...pull, base: { sha: base, ref: "main" } };
        return pull;
      }
      if (path.endsWith("/files"))
        return params.get("page") === "1" || failure === "pagination_overlap" ? [{ filename: "test.py" }] : [];
      if (path.startsWith("/branches/")) return { commit: { id: tip } };
      if (path.startsWith("/compare/"))
        return failure === "http_503"
          ? new Response(null, { status: 503 })
          : { files: [], truncated: failure === "compare_truncated" };
      return [];
    });
    const [overlap] = facet(events, "overlap");
    assert.equal(overlap.reason, failure === "base_ref_changed" ? "pr_revision_changed" : failure);
    assert.notEqual(overlap.coverage, "complete");
    assert.deepEqual(overlap.paths, []);
  }
});

test("a failed recent PR window retains known references without certifying an empty or full result", async () => {
  const events = await verify("issue", (path, query) => {
    if (path === "/issues/7") return { number: "7", state: "open" };
    if (path === "/pulls" && query.get("author") === "me" && query.get("page") === "1")
      return [{ number: 9, title: "Team/Repo#7", body: null, user: { login: "me" } }];
    if (path === "/pulls" && !query.get("author")) return new Response(null, { status: 503 });
    return [];
  });
  const [result] = facet(events, "issue-references");
  assert.equal(result.coverage, "partial");
  assert.equal(result.recentReason, "http_503");
  assert.deepEqual(
    result.references.map(({ number }: { number: string }) => number),
    ["9"],
  );
});

test("absent reference inputs and missing text are not complete lists", async () => {
  for (const [recent, expected] of [
    [new Response(null, { status: 403 }), "failed"],
    [[{ number: 9, title: "mentions #7" }], "partial"],
  ] as const) {
    const events = await verify("issue", (path, query) => {
      if (path === "/issues/7") return { number: "7", state: "closed" };
      if (path === "/pulls") return query.has("author") ? new Response(null, { status: 403 }) : recent;
      return [];
    });
    const [result] = facet(events, "issue-references");
    assert.equal(result.coverage, expected);
    assert.equal(result.references.length, expected === "failed" ? 0 : 1);
  }
});

test("recent PR windows report duplicates and missing reference text while sorting numeric IDs", async () => {
  const row = (number: number) => ({ number, title: "#7", body: null });
  const fifty = [100, 33, 9, 22, ...Array.from({ length: 46 }, (_, index) => index + 200)].map(row);
  for (const [mine, recent, reason, coverage, numbers] of [
    [[], fifty, undefined, "complete", ["9", "22", "33", "100"]],
    [[], [row(9), row(9), {}], "invalid_response", "partial", ["9"]],
    [[], [{ number: 9, title: "#7" }], "reference_text_missing", "partial", ["9"]],
    [[], [{ number: 9, body: "#7" }], "reference_text_missing", "partial", ["9"]],
    [[], new Response(null, { status: 503 }), "http_503", "partial", []],
    [new Response(null, { status: 403 }), [], "http_403", "partial", []],
    [new Response(null, { status: 403 }), [row(9), {}], "http_403", "partial", ["9"]],
  ] as const) {
    const events = await verify("issue", (path, query) => {
      if (path === "/issues/7") return { number: 7, state: "open" };
      if (path === "/pulls") return query.has("author") ? mine : recent;
      return [];
    });
    const parts = facet(events, "issue-references");
    assert.deepEqual([parts[0].reason, parts[0].coverage], [reason, coverage]);
    assert.deepEqual(
      parts
        .flatMap(({ references }) => references)
        .map(({ number }) => number)
        .slice(0, numbers.length),
      numbers,
    );
  }
});

test("unusable branch or file evidence is not treated as absence of overlap", async () => {
  for (const [ref, branch, reason] of [
    ["..", null, "invalid_base_ref"],
    ["release/next", new Response(null, { status: 403 }), "http_403"],
    ["release/next", { commit: { id: "bad" } }, "invalid_branch_response"],
  ] as const) {
    const calls: string[] = [];
    const events = await verify("pr", (path, query) => {
      calls.push(path);
      if (path === "/pulls/7") return { ...pull, state: "opened", base: { sha: base, ref } };
      if (path.endsWith("/files") && query.get("page") === "1")
        return [
          { filename: "kept.ts" },
          { filename: 2 },
          { filename: "" },
          { filename: "nul\0.ts" },
          { filename: `${credential}.ts` },
        ];
      if (path.startsWith("/branches/")) return branch;
      return [];
    });
    const [files] = facet(events, "files");
    assert.deepEqual([files.coverage, files.reason, files.paths], ["partial", "invalid_response", ["kept.ts"]]);
    const [overlap] = facet(events, "overlap");
    assert.deepEqual([overlap.coverage, overlap.reason], ["failed", reason]);
    assert.equal(
      calls.some((path) => path.startsWith("/branches/")),
      reason !== "invalid_base_ref",
    );
    assert.ok(!JSON.stringify(events).includes(credential));
  }
});

test("Issue workflow and local references cover own older PRs and the recent 50 without claiming a platform link", async () => {
  const events = await verify("issue", (path, query) => {
    if (path === "/issues/7")
      return { number: "7", state: "open", issue_state: "ACCEPTED", assignees: [{ login: "me" }] };
    if (path !== "/pulls") return [];
    if (query.get("author") === "me")
      return query.get("page") === "1"
        ? [{ number: 20, title: "Relates #7", state: "merged", body: "", user: { login: "me" } }]
        : [];
    assert.equal(query.get("per_page"), "50");
    assert.equal(query.get("direction"), "desc");
    return [
      { number: 23, title: "fix #7", body: "", state: "open", user: { login: "partner" } },
      { number: 24, title: "other/repo#7", body: "also #70 and https://example.invalid/#7" },
      { number: 20, title: "Relates #7", body: "", state: "merged", user: { login: "me" } },
    ];
  });
  assert.equal(JSON.parse(events[0].detail).issueState, "ACCEPTED");
  const [evidence] = facet(events, "issue-references");
  assert.equal(evidence.coverage, "complete");
  assert.equal(evidence.scope, "own_and_latest_50");
  assert.deepEqual(
    evidence.references.map(({ number, relationship }: { number: string; relationship: string }) => [
      number,
      relationship,
    ]),
    [
      ["20", "text_reference"],
      ["23", "text_reference"],
    ],
  );
  assert.equal(evidence.references[1].link, "https://gitcode.com/Team/Repo/merge_requests/23");
});

test("only configured GitCode ObjectIds contribute structured CI rows or running signals", async () => {
  const body =
    "x".repeat(1150) +
    '<table><tr><th>任务名称</th><th>状态</th></tr><tr><td>lint &amp; test</td><td>❌ FAIL</td><td><a href="https://ci.example/job/1?access_token=secret">log</a></td></tr></table>';
  const events = await verify(
    "pr",
    (path, query) => {
      if (path === "/pulls/7") return { ...pull, state: "merged" };
      if (!path.endsWith("/comments") || query.get("page") !== "1") return [];
      return [
        { id: 1, body, user: { id: bot }, comment_type: "comment" },
        { id: 2, body: "The pipeline(PR) is running", user: { id: bot } },
        { id: 3, body, user: { id: 42, login: "openJiuwen-bot" } },
        {
          id: 4,
          body: "<!-- dev-reviewer:review-summary -->总体判定：PASS\n必须修复（Must Fix）：2",
          user: { id: 43 },
        },
      ];
    },
    [bot],
  );
  const [report, running, spoof, review] = events
    .filter((event) => event.type === "gitcode.comment.observed")
    .map(({ detail }) => JSON.parse(detail));
  assert.equal(report.commentType, "comment");
  assert.equal(report.reportRevision, "unverified");
  assert.equal(report.bodyTruncated, true);
  assert.deepEqual(report.ciReport.checks, [{ name: "lint & test", status: "FAIL", link: "https://ci.example/job/1" }]);
  assert.equal(running.ciReport.signal, "running");
  assert.equal(spoof.ciReport, undefined);
  assert.deepEqual(review.reviewSummary, { verdict: "PASS", mustFix: "2" });
  assert.equal(JSON.parse(events[0].detail).currentCi, "unverified");
  assert.ok(!JSON.stringify(events).includes("access_token=secret"));
});

test("large facets fit a real receipt without silently dropping paths", async () => {
  const events = await verify("pr", (path, query) => {
    if (path === "/pulls/7") return pull;
    if (path.endsWith("/comments"))
      return Array.from({ length: 20 }, (_, index) => ({
        id: Number(query.get("page")) * 20 + index,
        body: '"'.repeat(1300),
      }));
    if (path.endsWith("/files"))
      return query.get("page") === "1"
        ? Array.from({ length: 100 }, (_, index) => ({ filename: `${index}-${'"'.repeat(400)}` }))
        : [];
    if (path.startsWith("/branches/")) return { commit: { sha: tip } };
    return { files: [], truncated: false };
  });
  const output = readMessage(`已记录\n\`\`\`agent-autoloop\n${JSON.stringify({ events })}\n\`\`\``);
  assert.ok(events.length <= 100);
  const files = facet(events, "files");
  assert.ok(files.length > 1);
  assert.equal(files[0].coverage, "partial");
  assert.equal(files[0].reason, "receipt_limit");
  assert.equal(files[0].omitted, 100 - files.flatMap(({ paths }) => paths).length);
  assert.deepEqual(
    files.map(({ part }) => part),
    Array.from({ length: files.length }, (_, index) => index + 1),
  );
  assert.equal(files[0].returned, files.flatMap(({ paths }) => paths).length);
  const receipt = resultFrom(output, {});
  assert.equal(receipt.problem, undefined);
  assert.equal(receipt.result.events?.length, events.length);
});

test("CI overflow is delivered in order without dropping comments or exceeding the receipt limit", async () => {
  const names = Array.from({ length: 10 }, (_, index) => `test-${index}-${"x".repeat(60)}`);
  const body = `<table>${names.map((name) => `<tr><td>${name}</td><td>PASS</td><td><a href="https://ci.example/log?access_token=secret">log</a></td></tr>`).join("")}</table>`;
  for (const commentCount of [10, 80]) {
    const events = await verify(
      "pr",
      (path, query) => {
        if (path === "/pulls/7") return pull;
        if (path.endsWith("/comments")) {
          const first = (Number(query.get("page")) - 1) * 20;
          if (first >= commentCount) return [];
          return Array.from({ length: Math.min(20, commentCount - first) }, (_, index) => ({
            id: first + index + 1,
            user: { id: bot },
            body,
          }));
        }
        const changed = Array.from({ length: 100 }, (_, index) => ({ filename: `${index}-${"x".repeat(500)}` }));
        if (path.endsWith("/files")) return query.get("page") === "1" ? changed : [];
        if (path.startsWith("/branches/")) return { commit: { sha: tip } };
        return { files: changed, truncated: false };
      },
      [bot],
    );
    const parts = facet(events, "ci-checks");
    const overflow = parts.flatMap(({ rows }) => rows);
    assert.ok(overflow.length > 0);
    assert.deepEqual(
      parts.map(({ part }) => part),
      Array.from({ length: parts.length }, (_, index) => index + 1),
    );
    assert.ok(parts.every(({ returned, parts: total }) => returned === overflow.length && total === parts.length));
    const comments = events.filter(({ type }) => type === "gitcode.comment.observed");
    assert.equal(comments.length, commentCount);
    let omitted = 0;
    for (const event of comments) {
      const { id, ciReport: report } = JSON.parse(event.detail);
      const continuation = overflow.filter(({ commentId }) => commentId === id);
      assert.equal(report.continued, continuation.length);
      assert.equal(report.checks.length + report.continued + report.omitted, names.length);
      const checks = [...report.checks, ...continuation];
      assert.deepEqual(
        checks.map(({ name }) => name),
        names.slice(0, checks.length),
      );
      assert.ok(checks.every(({ link }) => link === "https://ci.example/log"));
      assert.deepEqual(
        continuation.map(({ index }) => index),
        continuation.map((_, index) => report.checks.length + index),
      );
      omitted += report.omitted;
    }
    if (commentCount === 10) assert.equal(omitted, 0);
    else assert.ok(omitted > 0);
    assert.equal(parts[0].omitted, omitted);
    assert.ok(events.length <= 100);
    const message = `已记录\n\`\`\`agent-autoloop\n${JSON.stringify({ events })}\n\`\`\``;
    const receipt = resultFrom(readMessage(message), {});
    assert.equal(receipt.problem, undefined);
    assert.equal(receipt.result.events?.length, events.length);
  }
});

test("receipt parts preserve the exact serialized boundary and report a single omitted item", () => {
  assert.deepEqual(pack(['"', "c"], 10, 2), { chunks: [['"'], ["c"]], omitted: 0 });
  assert.deepEqual(pack(['"', "c"], 11, 2), { chunks: [['"', "c"]], omitted: 0 });
  assert.deepEqual(pack(["aaa"], 8, 2), { chunks: [["aaa"]], omitted: 0 });
  assert.deepEqual(pack(["aaa"], 7, 2), { chunks: [[]], omitted: 1 });
  const [part] = evidenceParts({ facet: "files", coverage: "complete" }, "paths", ["a", "x".repeat(4000)], 1);
  assert.deepEqual(
    [part.part, part.parts, part.coverage, part.reason, part.returned, part.omitted],
    [1, 1, "partial", "receipt_limit", 1, 1],
  );
  const [complete] = evidenceParts({ facet: "files", coverage: "complete" }, "paths", ["a"], 1);
  assert.equal(complete.reason, undefined);
});

test("candidate CI rows preserve optional links and safe HTML entity bounds", () => {
  const link = "https://ci.example/".padEnd(360, "x");
  const body = `<table><tr><td>&#0; &#1; &#1114111; &#1114112;</td><td>N/A</td></tr><tr><td>build</td><td>SUCCESS</td><td><a href="${link}">log</a></td></tr></table>`;
  const report = ciReport(body, (value) => ({ text: String(value), truncated: false }));
  assert.deepEqual(report?.checks, [
    { name: `&#0; \x01 ${String.fromCodePoint(0x10ffff)} &#1114112;`, status: "N/A", link: null },
    { name: "build", status: "SUCCESS", link },
  ]);
  assert.equal(report?.inputTruncated, false);
  assert.deepEqual(reviewSummary("<!-- dev-reviewer:review-summary -->总体判定：PASS"), {
    verdict: "PASS",
    mustFix: null,
  });
});

test("long CI reports reserve space for already serialized evidence", async () => {
  const quoted = '"'.repeat(1400);
  const row = (index: number) =>
    `<tr><td>test-${index} &#65; &#x42; &unknown;</td><td>N/A</td><td><a href="https://login:password@example.test/log">log</a></td></tr>`;
  const body = `${quoted}<table>${Array.from({ length: 60 }, (_, index) => row(index)).join("")}</table>`;
  const events = await verify(
    "pr",
    (path, query) => {
      if (path === "/pulls/7") return { ...pull, state: "merged" };
      if (path.endsWith("/comments") && query.get("page") === "1")
        return [
          {
            id: 1,
            body,
            comment_type: quoted,
            created_at: quoted,
            updated_at: quoted,
            user: { id: bot, login: quoted },
          },
        ];
      return [];
    },
    [bot],
  );
  const [comment] = events.filter(({ type }) => type === "gitcode.comment.observed");
  const { ciReport } = JSON.parse(comment.detail);
  assert.ok([...comment.detail].length <= 4000);
  assert.deepEqual(ciReport.checks[0], { name: "test-0 A B &unknown;", status: "N/A", link: null });
  assert.equal(ciReport.omitted, 0);
  assert.equal(ciReport.continued, 60 - ciReport.checks.length);
});
