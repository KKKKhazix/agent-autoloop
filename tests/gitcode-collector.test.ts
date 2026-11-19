// A filtered list can include someone else's work or stop midway; neither an unfinished page walk nor a bot comment is proof of coverage or CI.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { parseConfig, runCollector } from "../plugins/gitcode/collector.ts";

const repo = "Team/Repo";
const own = { login: "me" };
const token = "test-token-not-for-output";
const now = () => "2026-11-19T09:00:00.000Z";
const target = (suffix: string) => `gitcode:team/repo:${suffix}`;
const request = (suffix: string, type = "gitcode.verify.requested") => ({
  source: "gitcode-request",
  type,
  subject: target(suffix),
});
const data = (number: string | number, user = own) => ({ number, title: `Item ${number}`, state: "open", user });
const settings = { account: "me", repositories: [repo], targets: [target("pr:7")], botIds: ["42"] };

function fake(reply: (path: string, query: URLSearchParams) => unknown) {
  const calls: URL[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    calls.push(url);
    assert.equal(url.origin, "https://api.gitcode.com");
    assert.equal(init?.method, "GET");
    assert.equal(init.redirect, "error");
    assert.equal(new Headers(init.headers).get("private-token"), token);
    assert.ok(!url.href.includes(token));
    const path = url.pathname.replace(/^\/api\/v5/, "");
    const result = path === "/user" ? own : reply(path, url.searchParams);
    return result instanceof Response ? result : Response.json(result);
  };
  return { fetcher, calls };
}

const run = (fetcher: typeof fetch, events: unknown[], credential = token, mode: "schedule" | "collect" = "collect") =>
  runCollector(mode, parseConfig(settings), events, "17", { token: credential, fetcher, now });

test("configuration admits only bounded, local GitCode coordinates", () => {
  for (const invalid of [
    null,
    { ...settings, account: "wrong&account" },
    { ...settings, repositories: [] },
    { ...settings, repositories: ["Team/../Repo"], targets: [] },
    { ...settings, repositories: ["not-a-repository"], targets: [] },
    { ...settings, repositories: [`Team/${"r".repeat(80)}`], targets: [] },
    { ...settings, repositories: ["Team/Repo", null] },
    { ...settings, targets: [target("pr:90071992547409999"), "gitcode:evil/repo:pr:7"] },
    { ...settings, botIds: ["0"] },
    { ...settings, targets: false },
    { ...settings, botIds: false },
  ])
    assert.throws(() => parseConfig(invalid), /GitCode/);
  assert.equal(
    parseConfig({ ...settings, targets: [target("issue:90071992547409999")] }).targets[0].number,
    "90071992547409999",
  );
  assert.throws(
    () => parseConfig({ ...settings, targets: Array.from({ length: 51 }, () => target("pr:7")) }),
    /targets/,
  );
  const longRepo = `team/${"r".repeat(60)}`;
  const longSubject = `gitcode:${longRepo}:issue:${"9".repeat(20)}`;
  assert.equal(longSubject.length, 100);
  assert.equal(
    parseConfig({ ...settings, repositories: [longRepo], targets: Array.from({ length: 50 }, () => longSubject) })
      .targets[0].subject,
    longSubject,
  );
});

test("cron produces discovery and verification requests but does not read GitCode", async () => {
  const { calls, fetcher } = fake(() => assert.fail("schedule must not fetch"));
  const events = await run(fetcher, [], "", "schedule");
  assert.deepEqual(
    events.map(({ type, subject, summary }) => [type, subject, summary]),
    [
      ["gitcode.sweep.requested", target("pr:own"), "发现本人事项"],
      ["gitcode.sweep.requested", target("issue:own"), "发现本人事项"],
      ["gitcode.verify.requested", target("pr:7"), "核实 GitCode 事项"],
    ],
  );
  assert.deepEqual(await run(fetcher, [], "", "schedule"), events);
  assert.equal(calls.length, 0);
});

test("discover keeps only the verified account's work and does not stop at a short nonempty page", async () => {
  const { fetcher } = fake((path, query) => {
    assert.equal(path, "/repos/Team/Repo/issues");
    assert.equal(query.get("creator"), "me");
    assert.equal(query.get("state"), "all");
    assert.equal(query.get("per_page"), "20");
    if (query.get("page") === "1")
      return Array.from({ length: 20 }, (_, index) => data(String(index + 7), index === 0 ? own : { login: "other" }));
    if (query.get("page") === "2") return [{ ...data("27", { login: "" }), author: own }];
    if (query.get("page") === "3") return [data("28")];
    return [];
  });
  const [event] = await run(fetcher, [request("issue:own", "gitcode.discover.requested")]);
  assert.equal(event.type, "gitcode.discovery.observed");
  assert.deepEqual(JSON.parse(event.detail), {
    version: 1,
    observedAt: now(),
    account: "me",
    coverage: "complete",
    numbers: ["7", "27", "28"],
  });
});

test("malformed, repeated, and capped pages keep known results without claiming complete coverage", async () => {
  for (const [reason, reply] of [
    ["invalid_response", (page: number) => (page === 1 ? [data(7)] : { message: token })],
    ["pagination_overlap", () => [data(7)]],
    ["page_limit", (page: number) => [data(6 + page)]],
    ["page_size_exceeded", () => Array.from({ length: 21 }, (_, index) => data(index + 7))],
    ["invalid_response", () => [data(7), { number: 9, user: {} }]],
    ["invalid_response", () => [data(7), data(Number.MAX_SAFE_INTEGER + 1)]],
    ["http_429", (page: number) => (page === 1 ? [data(7)] : new Response(token, { status: 429 }))],
  ] as const) {
    const { fetcher } = fake((path, query) => {
      assert.equal(path, "/repos/Team/Repo/pulls");
      assert.equal(query.get("author"), "me");
      return reply(Number(query.get("page")));
    });
    const [event] = await run(fetcher, [request("pr:own", "gitcode.discover.requested")]);
    const result = JSON.parse(event.detail);
    assert.equal(result.coverage, "partial");
    assert.equal(result.reason, reason);
    assert.equal(result.numbers[0], "7");
    if (reason === "page_limit") assert.deepEqual(result.numbers, ["7", "8", "9", "10"]);
    if (reason === "invalid_response") assert.deepEqual(result.numbers, ["7"]);
    assert.ok(!JSON.stringify(event).includes(token));
  }
});

test("explicit sweeps queue verified owners and resume at the advertised next page", async () => {
  const { fetcher } = fake((path, query) => {
    assert.equal(path, "/repos/Team/Repo/pulls");
    const page = Number(query.get("page"));
    return page <= 5 ? [data(page + 20), data(100 + page, { login: "other" })] : [];
  });
  const [observed, ...follow] = await run(fetcher, [request("pr:own", "gitcode.sweep.requested")]);
  const { nextRequest, numbers } = JSON.parse(observed.detail);
  assert.deepEqual(numbers, ["21", "22", "23", "24"]);
  assert.deepEqual(
    follow.filter(({ type }) => type === "gitcode.verify.discovered").map(({ subject }) => subject),
    numbers.map((number: string) => target(`pr:${number}`)),
  );
  const next = follow.find(({ type }) => type === "gitcode.sweep.requested");
  assert.ok(next);
  assert.equal(nextRequest.subject, next.subject);
  const [resumed, ...additional] = await run(fetcher, [{ ...next, source: "gitcode-observation", hops: 1 }]);
  assert.deepEqual(JSON.parse(resumed.detail).numbers, ["25"]);
  assert.deepEqual(JSON.parse(resumed.detail).startPage, 5);
  assert.equal(additional[0].subject, target("pr:25"));
  assert.equal(additional.length, 1);
});

test("a manual long discussion can be read on the next page without claiming an exhaustive snapshot", async () => {
  const { fetcher, calls } = fake((path, query) => {
    if (path.endsWith("/issues/7")) return data(7);
    const page = Number(query.get("page"));
    if (path.endsWith("/issues/7/comments") && page <= 5) return [{ id: page, body: `page ${page}` }];
    return [];
  });
  const [first] = await run(fetcher, [request("issue:7")]);
  const {
    comments: { nextRequest },
  } = JSON.parse(first.detail);
  assert.ok(nextRequest?.subject);
  calls.length = 0;
  const [later, ...evidence] = await run(fetcher, [{ ...nextRequest, source: "gitcode-request" }]);
  assert.equal(JSON.parse(later.detail).comments.startPage, 5);
  assert.equal(JSON.parse(later.detail).scope, "comment-page");
  assert.deepEqual(
    evidence.map(({ detail }) => JSON.parse(detail).id),
    ["5"],
  );
  assert.deepEqual(
    calls.filter((url) => url.pathname.endsWith("/comments")).map((url) => url.searchParams.get("page")),
    ["5", "6"],
  );
});

test("same-run verification coalesces the same object; PR facts and comments are not a current CI result", async () => {
  const { fetcher, calls } = fake((path, query) => {
    if (path.endsWith("/pulls/7")) {
      return {
        ...data(7),
        head: { sha: "a".repeat(40) },
        labels: [{ name: "ci-failed" }],
        mergeable_state: { ci_state_passed: false, conflict_passed: true },
      };
    }
    if (path.endsWith("/files")) return [];
    if (path.endsWith("/pulls/7/issues")) return [];
    if (path.endsWith("/actions/runs")) return { total_count: 0, workflow_runs: [] };
    assert.equal(path, "/repos/Team/Repo/pulls/7/comments");
    return query.get("page") === "1"
      ? [
          { id: 100, user: { id: 42, login: "ci-bot" }, body: "| test | failed |" },
          { id: "101", user: { id: 99, login: "ci-bot" }, body: "| test | passed |" },
        ]
      : [];
  });
  const [object, bot, human] = await run(fetcher, [request("pr:7"), request("pr:7")]);
  assert.equal(calls.filter((url) => url.pathname.endsWith("/pulls/7/comments")).length, 2);
  assert.equal(calls.filter((url) => url.pathname.endsWith("/actions/runs")).length, 1);
  const detail = JSON.parse(object.detail);
  assert.equal(detail.coverage, "complete");
  assert.equal(detail.headSha, "a".repeat(40));
  assert.deepEqual(detail.labels, ["ci-failed"]);
  assert.equal(detail.labelsTruncated, false);
  assert.equal(detail.mergeGate.ciStatePassed, false);
  assert.equal(detail.mergeGate.state, null);
  assert.equal(detail.currentCi, "unverified");
  assert.equal(JSON.parse(bot.detail).reportRevision, "unverified");
  assert.equal(JSON.parse(human.detail).reportRevision, undefined);
  assert.equal(bot.subject, object.subject);
  assert.equal(bot.type, "gitcode.comment.observed");
});

test("an Issue with the same number has separate identity and does not acquire PR fields", async () => {
  const { fetcher } = fake((path) => (path.endsWith("/issues/7") ? data("7") : []));
  const [event] = await run(fetcher, [request("issue:7")]);
  assert.equal(event.subject, target("issue:7"));
  assert.match(event.link, /\/issues\/7$/);
  const detail = JSON.parse(event.detail);
  assert.equal(detail.currentCi, undefined);
  assert.equal(detail.labels, null);
  assert.equal(detail.labelsTruncated, false);
});

test("an invalid source, noncanonical subject or unauthorized repository cannot trigger an API call", async () => {
  const { fetcher, calls } = fake(() => assert.fail("no requests"));
  for (const invalid of [
    { ...request("pr:7"), source: "other" },
    { ...request("pr:7"), subject: "gitcode:team/other:pr:7" },
    { ...request("pr:7"), subject: "gitcode:Team/Repo:pr:7" },
    request("pr:own"),
    { ...request("pr:7"), subject: [target("pr:7")] },
  ]) {
    const [event] = await run(fetcher, [invalid]);
    assert.equal(JSON.parse(event.detail).reason, "invalid_request");
  }
  const [mixed] = await run(fetcher, [request("pr:7"), request("issue:7")]);
  assert.equal(JSON.parse(mixed.detail).reason, "invalid_request");
  assert.equal(calls.length, 0);
});

test("missing credentials, incorrect account and repository denial stop before comments without leaking credentials", async () => {
  const forbidden = fake(() => new Response(token, { status: 403 }));
  const wrong: typeof fetch = async () => Response.json({ login: "other" });
  const malformed: typeof fetch = async () => Response.json({ login: 42 });
  const noBody: typeof fetch = async () => new Response(null, { status: 401 });
  for (const [fetcher, credential, reason] of [
    [forbidden.fetcher, "", "missing_token"],
    [wrong, token, "account_mismatch"],
    [malformed, token, "account_mismatch"],
    [noBody, token, "http_401"],
    [forbidden.fetcher, token, "http_403"],
  ] as const) {
    const events = await run(fetcher, [request("pr:7")], credential);
    assert.equal(events.length, 1);
    assert.equal(JSON.parse(events[0].detail).coverage, "failed");
    assert.equal(JSON.parse(events[0].detail).reason, reason);
    assert.ok(!JSON.stringify(events).includes(token));
  }
  assert.equal(forbidden.calls.length, 2);
  const [discovery] = await run(noBody, [request("pr:own", "gitcode.discover.requested")]);
  assert.equal(discovery.type, "gitcode.discovery.observed");
  assert.equal(JSON.parse(discovery.detail).numbers, undefined);
});

test("a bad comment collection does not erase detail, and evidence excerpts are safe and bounded", async () => {
  const { fetcher } = fake((path, query) => {
    if (path.endsWith("/issues/7")) return { ...data(7), body: `example ${token}`, labels: [] };
    if (query.get("page") === "1") return [{ id: 100, body: `${token}\n| row | ${'"🙂'.repeat(3000)}` }];
    return new Response("not json");
  });
  const [object, comment] = await run(fetcher, [request("issue:7")]);
  assert.equal(JSON.parse(object.detail).coverage, "partial");
  assert.equal(JSON.parse(object.detail).comments.coverage, "partial");
  assert.equal(JSON.parse(comment.detail).bodyTruncated, true);
  assert.match(JSON.parse(comment.detail).body, /^\[redacted\]\n\| row \|/);
  assert.ok([...comment.detail].length <= 4000);
  assert.ok(!JSON.stringify([object, comment]).includes(token));
});

test("wrong detail identity and upstream connection failures remain failed observations", async () => {
  const wrong = fake(() => data(8));
  const failure = fake(() => {
    throw new Error(token);
  });
  for (const [source, reason] of [
    [wrong, "invalid_response"],
    [fake(() => ({ ...data(7), number: [7] })), "invalid_response"],
    [fake(() => ({ ...data(7), state: "" })), "invalid_response"],
    [failure, "network_error"],
  ] as const) {
    const [event] = await run(source.fetcher, [request("pr:7")]);
    assert.equal(JSON.parse(event.detail).reason, reason);
    assert.equal(JSON.parse(event.detail).coverage, "failed");
    assert.equal(source.calls.length, 2);
    assert.ok(!JSON.stringify(event).includes(token));
  }
});

test("field omissions and truncation do not invent labels or comment evidence", async () => {
  for (const [labels, expected] of [
    [Array(13).fill("known"), Array(12).fill("known")],
    [
      ["x".repeat(51), "known"],
      ["x".repeat(50), "known"],
    ],
    [[null], []],
  ]) {
    const { fetcher } = fake((path, query) => {
      if (path.endsWith("/pulls/7"))
        return { ...data(7), head: { sha: "a".repeat(12) }, body: "x".repeat(400), labels };
      return query.get("page") === "1" ? [{ id: 1, body: 123 }] : [];
    });
    const [object, ...comments] = await run(fetcher, [request("pr:7")]);
    const detail = JSON.parse(object.detail);
    assert.equal(detail.bodyTruncated, false);
    assert.equal(detail.headSha, null);
    assert.equal(detail.labelsTruncated, true);
    assert.deepEqual(detail.labels, expected);
    assert.equal(detail.comments.reason, "invalid_response");
    assert.equal(comments.filter(({ type }) => type === "gitcode.comment.observed").length, 0);
  }
});

test("the command returns a Hub receipt when credentials are unusable without printing them", () => {
  const directory = mkdtempSync(join(tmpdir(), "gitcode-command-"));
  try {
    const entry = resolve("plugins/gitcode/run.ts");
    const config = join(directory, "config.json");
    const context = join(directory, "context.json");
    const credential = join(directory, "token");
    writeFileSync(config, JSON.stringify(settings));
    writeFileSync(context, JSON.stringify({ events: [request("pr:7")] }));
    writeFileSync(credential, `${token}\ninvalid header`);
    const env = { ...process.env, AGENT_AUTOLOOP_RUN: "17", AGENT_AUTOLOOP_CONTEXT: context };
    const invoke = (args: string[], override: NodeJS.ProcessEnv = {}) =>
      spawnSync(process.execPath, [entry, ...args], { encoding: "utf8", env: { ...env, ...override } });
    const launch = invoke(["collect", config, credential]);
    assert.equal(launch.status, 0, launch.stderr);
    const { events } = JSON.parse(launch.stdout.split("\n")[3]);
    assert.equal(JSON.parse(events[0].detail).reason, "missing_token");
    assert.ok(!`${launch.stdout}${launch.stderr}`.includes(token));
    assert.match(invoke(["collect", config]).stdout, /missing_token/);
    assert.match(invoke(["collect", config, join(directory, "missing")]).stdout, /missing_token/);
    const scheduled = invoke(["schedule", config], { AGENT_AUTOLOOP_CONTEXT: "" });
    assert.equal(scheduled.status, 0, scheduled.stderr);
    assert.match(scheduled.stdout, /^已提交 GitCode 采集请求/);
    assert.match(launch.stdout, /^已记录 GitCode 采集结果/);
    assert.equal(invoke(["unknown", config]).status, 1);
    assert.equal(invoke(["schedule"]).status, 1);
    assert.equal(invoke(["schedule", config], { AGENT_AUTOLOOP_RUN: "" }).status, 1);
    assert.equal(invoke(["collect", config], { AGENT_AUTOLOOP_CONTEXT: "" }).status, 1);
    const fakeApi = join(directory, "fake-api.mjs");
    writeFileSync(
      fakeApi,
      `globalThis.fetch = async (url, request) => new Response(null, {
      status: request.headers['private-token'] === ${JSON.stringify(token)} ? 403 : 500
    });`,
    );
    writeFileSync(credential, `${token}\n`);
    const checked = spawnSync(
      process.execPath,
      ["--import", pathToFileURL(fakeApi).href, entry, "collect", config, credential],
      {
        encoding: "utf8",
        env,
      },
    );
    assert.equal(checked.status, 0, checked.stderr);
    assert.match(checked.stdout, /http_403/);
    assert.ok(!checked.stdout.includes(token));
    writeFileSync(context, "{}");
    assert.equal(invoke(["collect", config]).status, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
