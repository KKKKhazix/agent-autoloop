// Failure modes: the running totals behind `status` and `/v1/metrics` drift from the runs or events they count when a
// run changes state, is retried with its usage added up, is merged into another and removed, or is cancelled, or when an
// event is deduplicated, paused and replayed, emitted by a receipt or a card answer, or cleared; a channel's last failure
// reflects an older failed card after a newer card went through, or disappears behind later deliveries on another channel;
// a rebuilt projection counts differently from one kept up commit by commit; adding and taking away leaves a crumb behind;
// "done today" is frozen at whatever day the total was kept on.
import assert from "node:assert/strict";
import { test } from "node:test";
import { at, setup } from "./helpers.ts";

setup("tallies");
const hub = await import("../host/runtime.ts");
const { fixtureClear } = await import("./storage.ts");
const { countsOf } = await import("../host/state.ts");
const { dayStart } = await import("../kernel/cron.ts");
const { rebuild } = await import("../kernel/store.ts");

/** What the totals must equal: every run read one by one, the way `status` used to count them. */
function scanned(since: string) {
  return hub.all<Record<string, string | number>>(
    `SELECT rule, agent, state, COUNT(*) AS count,
      SUM(CASE WHEN state = 'queued' AND attempts > 0 THEN 1 ELSE 0 END) AS retrying,
      SUM(CASE WHEN state = 'done' AND finished_at >= ? THEN 1 ELSE 0 END) AS today,
      COALESCE(SUM(json_extract(usage, '$.input')), 0) AS input,
      COALESCE(SUM(json_extract(usage, '$.output')), 0) AS output,
      COALESCE(SUM(json_extract(usage, '$.cost')), 0) AS cost
     FROM runs GROUP BY rule, agent, state`,
    [since],
  );
}
/** Totals folded to one line per rule, agent and state, and "done today" to one per rule and agent, whatever rows they came in. */
function folded(rows: Record<string, string | number>[]) {
  const lines = new Map<string, Record<string, number>>();
  const add = (key: string, field: string, value: number) => {
    const line = lines.get(key) ?? {};
    line[field] = (line[field] ?? 0) + value;
    lines.set(key, line);
  };
  for (const row of rows) {
    const key = `${row.rule}|${row.agent}|${row.state}`;
    for (const field of ["count", "retrying", "input", "output", "cost"]) add(key, field, Number(row[field] ?? 0));
    add(`${row.rule}|${row.agent}|today`, "today", Number(row.today ?? 0));
  }
  for (const [key, line] of lines) {
    if (Object.values(line).every((value) => value === 0)) lines.delete(key);
    else if (line.cost !== undefined) line.cost = Math.round(line.cost * 1e9) / 1e9;
  }
  return Object.fromEntries([...lines].sort(([a], [b]) => a.localeCompare(b)));
}
const same = (now: number, message: string) => {
  const since = new Date(dayStart(now, hub.rules.timezone)).toISOString();
  assert.deepEqual(folded(countsOf(hub.all, since)), folded(scanned(since)), message);
};

const note = (n: number, step = "new") => ({ id: `t:${n}:${step}`, type: `feedback.${step}`, subject: `#${n}` });
const claim = (minute: number) => hub.claimNext("w1", `c-${minute}-${Math.random()}`, at(minute))!;

test("the totals match the runs one by one through every way a run can go, and again after a rebuild", () => {
  same(at(0), "空的时候也对得上");

  hub.ingest("app", note(1), at(0));
  const first = claim(0);
  hub.finish(first.run, first.token, { outcome: "done", usage: { input: 100, output: 10, cost: 0.1 } }, at(1));
  same(at(1), "做完一轮");

  // A failure with usage goes back to the queue as a retry, and an event for the same thing that came meanwhile is merged
  // into it: that other run is removed.
  hub.ingest("app", note(2), at(2));
  const failing = claim(2);
  hub.ingest("app", note(2, "update"), at(3));
  hub.finish(failing.run, failing.token, { outcome: "failed", error: "超时", usage: { input: 7, cost: 0.2 } }, at(4));
  same(at(4), "失败重排、合并掉另一轮");

  const retry = claim(10);
  hub.finish(retry.run, retry.token, { outcome: "done", usage: { input: 3, output: 1, cost: 0.1 } }, at(11));
  same(at(11), "重试做完，用量加在一起");

  hub.ingest("app", note(3), at(12));
  const stopped = claim(12);
  hub.cancel(stopped.run, at(13));
  hub.finish(stopped.run, stopped.token, { outcome: "cancelled" }, at(14));
  hub.ingest("app", note(4), at(15));
  same(at(15), "停掉一轮，另有一轮在排队");

  // The next day: what was done today is now done before today, and the totals that don't depend on the day stay.
  const tomorrow = at(15) + 86400_000;
  same(tomorrow, "第二天再看");

  const before = folded(countsOf(hub.all, new Date(dayStart(at(15), hub.rules.timezone)).toISOString()));
  rebuild(hub.db, "另一种格式");
  same(at(15), "重建以后也对得上");
  assert.deepEqual(
    folded(countsOf(hub.all, new Date(dayStart(at(15), hub.rules.timezone)).toISOString())),
    before,
    "重建前后说的是同一件事",
  );
  hub.getView();
});

test("costs added and taken away come back to exactly nothing", () => {
  fixtureClear("runs");
  const totals = countsOf(hub.all, new Date(at(0)).toISOString());
  assert.deepEqual(totals, [], "清空以后一行也不剩，没有残留的零头");
});

test("source event totals and channel delivery states match history through pauses, replays, answers and rebuilds", () => {
  const scannedSources = () =>
    Object.fromEntries(
      Object.keys(hub.rules.sources).map((id) => [
        id,
        Number(hub.one<{ n: number }>("SELECT COUNT(*) AS n FROM events WHERE source = ?", [id])!.n),
      ]),
    );
  const stateSources = (now: number) =>
    Object.fromEntries(hub.stateOf(now).sources.map((s: { id: string; events: number }) => [s.id, s.events]));
  // Whatever the tests before this one left behind: the two views of it must already agree.
  assert.deepEqual(stateSources(at(20)), scannedSources(), "两边一开始就一致");

  // Regular ingest + duplicate ingest (must count once).
  hub.ingest("app", { id: "s-1", type: "feedback.new", subject: "#s1" }, at(20));
  hub.ingest("app", { id: "s-1", type: "feedback.new", subject: "#s1" }, at(20));
  assert.deepEqual(stateSources(at(20)), scannedSources(), "重复事件不重算");

  // Paused event + replay (replay links the existing event to a run without adding or double-counting it).
  hub.execute("pauseRule", ["意见", "owner", { reason: "维护" }], at(21));
  const skipped = hub.ingest("app", { id: "s-2", type: "feedback.new", subject: "#s2" }, at(21));
  hub.execute("resumeRule", ["意见"], at(22));
  hub.execute("replayRule", ["意见", [skipped.event]], at(22));
  assert.deepEqual(stateSources(at(22)), scannedSources(), "暂停跳过再补跑还是算一条");

  // Manual run + receipt asking a question + card answer + another source.
  hub.execute("runRule", ["意见", "owner", { subject: "#s3" }], at(23));
  hub.ingest("ops", { id: "o-1", type: "alert.raised", subject: "#o1" }, at(23));
  const job = claim(23);
  hub.finish(
    job.run,
    job.token,
    { outcome: "done", ask: [{ title: "确认一", text: "一", options: ["好", "算了"] }] },
    at(24),
  );
  const firstCard = hub.nextCard("chat", at(24))!;
  hub.failed("chat", firstCard.id, firstCard.version, "网关超时", at(24));
  const opsFirst = hub.nextCard("plain", at(24))!;
  hub.failed("plain", opsFirst.id, opsFirst.version, "通道拒绝", at(24));

  const chatChannel = (now: number) => hub.stateOf(now).channels.find((c: { id: string }) => c.id === "chat")!;
  const plainChannel = (now: number) => hub.stateOf(now).channels.find((c: { id: string }) => c.id === "plain")!;
  assert.equal(chatChannel(at(24)).lastFailure?.error, "网关超时");
  assert.equal(plainChannel(at(24)).lastFailure?.error, "通道拒绝");

  hub.answer(firstCard.id, { choice: 0, by: "owner" }, at(25));
  assert.deepEqual(stateSources(at(25)), scannedSources(), "手动运行、回答派生的事件也严丝合缝");

  // Newer card succeeds on chat while plain never takes it: chat's lastFailure clears, plain's stays.
  hub.tell("notice:later", "新通知", "正文", at(26));
  // Drain older cards on chat so the latest card is delivered cleanly.
  for (let step = 0; step < 5; step++) {
    const next = hub.nextCard("chat", at(26 + step));
    if (!next) break;
    hub.delivered("chat", next.id, next.version, `msg-${next.id}`, at(26 + step));
  }
  assert.equal(chatChannel(at(31)).lastFailure, undefined, "新卡片送达后旧失败不再挂着");
  assert.equal(plainChannel(at(31)).lastFailure?.error, "通道拒绝", "别的通道送达不掩盖这边的失败");

  const beforeSources = stateSources(at(31));
  const beforeChannels = hub.stateOf(at(31)).channels;
  rebuild(hub.db, "重建校验");
  assert.deepEqual(stateSources(at(31)), beforeSources, "重建后来源计数不变");
  assert.deepEqual(hub.stateOf(at(31)).channels, beforeChannels, "重建后各通道最后投递状态不变");
  hub.getView();
});
