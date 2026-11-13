// Failure cases: authority is mixed, write errors are retried, old connections overwrite new state, or unrelated facts appear.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHub } from "../src/service/hub.ts";
import { mergeRuns, safeLink, timeline, time, runFromFacts } from "../src/model.ts";
import { useConsole } from "../src/hooks/useConsole.ts";

test("owner and source credentials stay on their respective endpoints; writes are not retried", async () => {
  const calls: { path: string; key: string }[] = [];
  const hub = createHub("owner", async (url, init) => {
    calls.push({ path: String(url), key: new Headers(init?.headers).get("authorization")! });
    return new Response(JSON.stringify({ error: "拒绝" }), { status: 403 });
  });
  await assert.rejects(hub.answer(1, { choice: 0 }), /拒绝/);
  await assert.rejects(hub.emit("source", { id: "stable", type: "test" }), /拒绝/);
  assert.deepEqual(calls, [
    { path: "/v1/cards/1/answer", key: "Bearer owner" },
    { path: "/v1/events", key: "Bearer source" },
  ]);
});
test("refresh merges history and accepts latest active state without duplicate rows", () => {
  assert.deepEqual(
    mergeRuns(
      [
        { id: 2, state: "done" },
        { id: 1, state: "claimed" },
      ] as never,
      [
        { id: 1, state: "done" },
        { id: 3, state: "queued" },
      ] as never,
    ).map((r) => [r.id, r.state]),
    [
      [3, "queued"],
      [2, "done"],
      [1, "done"],
    ],
  );
});
test("links cannot execute external text and timeline excludes unrelated rows", () => {
  assert.equal(safeLink("javascript:alert(1)"), "");
  assert.equal(safeLink("https://example.org"), "https://example.org");
  const facts = [
    {
      seq: 1,
      at: 1794384000000,
      type: "result",
      changes: [
        { table: "runs", key: "2", row: { id: 2 } },
        { table: "runs", key: "1", row: { id: 1 } },
      ],
    },
  ];
  assert.equal(timeline(facts as never, 1)[0]?.changes.length, 1);
  assert.ok(!time(1794384000000).includes("Invalid Date"));
});
test("an obsolete connection cannot overwrite the newly connected state", async () => {
  const pending: ((r: Response) => void)[] = [];
  const consoleState = useConsole({
    realtime: false,
    fetcher: () => new Promise((resolve) => pending.push(resolve)),
    interval: 100000,
  });
  const first = consoleState.connect("old");
  const second = consoleState.connect("new");
  pending[1]!(Response.json({ runs: [], cards: [], now: "new", nextBefore: null, hasMore: false }));
  await second;
  pending[0]!(Response.json({ runs: [], cards: [], now: "old", nextBefore: null, hasMore: false }));
  await first;
  assert.equal(consoleState.state.value?.now, "new");
  consoleState.disconnect();
});

test("pagination finishing after a timer deadline preserves automatic refresh", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let count = 0;
  let finishPage: ((response: Response) => void) | undefined;
  const app = useConsole({
    realtime: false,
    interval: 10,
    fetcher: async (url) => {
      count++;
      if (String(url).includes("before=")) return new Promise((resolve) => (finishPage = resolve));
      return Response.json({ runs: [], cards: [], now: String(count), nextBefore: 5, hasMore: true });
    },
  });
  await app.connect("test-owner");
  const page = app.more();
  t.mock.timers.tick(20);
  finishPage!(Response.json({ runs: [], cards: [], nextBefore: null, hasMore: false }));
  await page;
  t.mock.timers.tick(11);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(count, 3);
  assert.equal(app.hasMore.value, false);
  app.disconnect();
});

test("changing selected run rejects obsolete detail results", async () => {
  const details: ((r: Response) => void)[] = [];
  const app = useConsole({
    realtime: false,
    fetcher: async (url) =>
      String(url).endsWith("/why")
        ? new Promise((resolve) => details.push(resolve))
        : Response.json({ runs: [], cards: [], nextBefore: null, hasMore: false }),
  });
  await app.connect("owner");
  const first = app.select(1),
    second = app.select(2);
  details[1]!(Response.json([{ seq: 2 }]));
  await second;
  details[0]!(Response.json([{ seq: 1 }]));
  await first;
  assert.equal(app.facts.value[0]?.seq, 2);
  app.disconnect();
});

test("external card changes refresh the selected finished run detail", async () => {
  let cards: unknown[] = [];
  let reads = 0;
  const app = useConsole({
    realtime: false,
    fetcher: async (url) =>
      String(url).endsWith("/why")
        ? (reads++, Response.json([]))
        : Response.json({ runs: [], cards, recentCards: [], nextBefore: null, hasMore: false }),
  });
  await app.connect("owner");
  await app.select(7);
  cards = [{ id: 1, state: "closed" }];
  await app.refresh();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reads, 2);
  app.disconnect();
});

test("an older active run missing from the first page gets its exact terminal state", async () => {
  let first = true;
  const app = useConsole({
    realtime: false,
    fetcher: async (url) => {
      if (String(url).endsWith("/why"))
        return Response.json([
          {
            seq: 10,
            at: 1794384000000,
            type: "finish",
            changes: [
              {
                table: "runs",
                key: "1",
                row: {
                  id: 1,
                  state: "cancelled",
                  summary: "stopped correctly",
                  error: "",
                  finished_at: "2026-11-11T10:00:00Z",
                  cancel_at: "2026-11-11T09:59:00Z",
                  attempts: 1,
                },
              },
            ],
          },
        ]);
      const runs = first ? [{ id: 1, state: "claimed", summary: "", stopping: false }] : [{ id: 70, state: "done" }];
      first = false;
      return Response.json({ runs, cards: [], recentCards: [], nextBefore: null, hasMore: false });
    },
  });
  await app.connect("owner");
  await app.refresh();
  const run = app.runs.value.find((r) => r.id === 1)!;
  assert.equal(run.state, "cancelled");
  assert.equal(run.summary, "stopped correctly");
  assert.equal(run.finishedAt, "2026-11-11T10:00:00Z");
  assert.equal(run.stopping, true);
  app.disconnect();
});

test("continuation timeline includes the earlier card whose answer event belongs to this run", () => {
  const facts = [
    {
      seq: 1,
      at: 1,
      type: "finish",
      changes: [
        { table: "cards", key: "4", row: { id: 4, run_id: 1, title: "question" } },
        { table: "cards", key: "5", row: { id: 5, run_id: 9, title: "unrelated" } },
      ],
    },
    {
      seq: 2,
      at: 2,
      type: "answer",
      changes: [
        { table: "cards", key: "4", row: { id: 4, run_id: 1, answer_event: 20, answer: "continue" } },
        { table: "run_events", key: "2:20", row: { run_id: 2, event_id: 20 } },
      ],
    },
  ];
  const continued = timeline(facts, 2).flatMap((f) => f.changes.filter((c) => c.table === "cards"));
  assert.equal(continued.length, 2);
  assert.ok(continued.every((c) => c.row?.id === 4));
  assert.equal(timeline(facts, 1).flatMap((f) => f.changes.filter((c) => c.table === "cards")).length, 2);
});

test("the last projection change within the latest finish fact wins", () => {
  const previous = { id: 1, state: "claimed", summary: "old" };
  const facts = [
    {
      seq: 4,
      at: 1794384000000,
      type: "finish",
      changes: [
        { table: "runs", key: "1", row: { id: 1, state: "claimed", summary: "initial", cancel_at: null } },
        { table: "runs", key: "1", row: { id: 1, state: "cancelled", summary: "intermediate", cancel_at: "now" } },
        { table: "runs", key: "1", row: { id: 1, state: "cancelled", summary: "final result", cancel_at: "now" } },
      ],
    },
  ];
  const run = runFromFacts(previous as never, facts);
  assert.equal(run.state, "cancelled");
  assert.equal(run.summary, "final result");
});
