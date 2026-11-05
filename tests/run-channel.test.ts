// A request may name the channel it is for. The name is the request's own: it is read from a header, never from the
// event body; a rule that lists channels takes it only if it allows it; a rule that lists none stays broadcast.
// Failure modes: the name is taken from the body; a rule without channels is narrowed by a request it never agreed to;
// a name the rules do not know is taken; a rule that refuses the name is skipped while the others go ahead, so the
// caller believes every handler is at work; a second delivery of the same event re-routes what was already routed; two
// targets on one rule and subject are merged into one run; a derived event inherits the channel of the run that
// produced it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { at, setup } from "./helpers.ts";

setup("run-channel");

const { ingest, claimNext, started, finish, nextCard, getView, execute } = await import("../host/runtime.ts");
const { InputError } = await import("../kernel/errors.ts");
const { all, run } = await import("./storage.ts");

const clean = () => {
  for (const table of ["run_events", "runs", "events", "seen", "cards", "deliveries", "timers"])
    run(`DELETE FROM ${table}`);
};

/** One rule of the fixture, matching every app event. */
const rule = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  when: { source: "app", types: ["feedback.*"] },
  to: "a1",
  cwd: "~/x",
  prompt: "做。",
  group: name,
  ...extra,
});

const use = (rules: unknown[]) =>
  execute("rules", [
    structuredClone({
      timezone: "Asia/Shanghai",
      sources: { app: { name: "应用" } },
      agents: { a1: { name: "甲", worker: "w1", use: "claude", model: "m1" } },
      channels: { chat: { name: "聊天", answerers: ["me"] }, plain: { name: "文字", links: true } },
      rules,
      elsewhere: [],
    }),
  ]);

const note = (id: string, subject = "#1") => ({ id, type: "feedback.new", subject });
const runs = () =>
  all<{ rule: string; target_channel: string | null }>("SELECT rule, target_channel FROM runs ORDER BY id");
const counts = () => ({
  events: all("SELECT id FROM events").length,
  runs: all("SELECT id FROM runs").length,
  links: all("SELECT * FROM run_events").length,
});

test("a named channel a rule allows is the channel its run is for", () => {
  clean();
  use([rule("意见", { channels: ["chat", "plain"] }), rule("记一笔")]);
  assert.deepEqual(ingest("app", note("e1"), at(0), "plain").routed, ["意见", "记一笔"]);
  assert.deepEqual(runs(), [
    { rule: "意见", target_channel: "plain" },
    { rule: "记一笔", target_channel: null },
  ]);
  // The card the run asks with keeps that channel, and only that channel is offered it.
  const job = claimNext("w1", "c1", at(0))!;
  started(job.run, job.token, { session: "s1" }, at(0));
  finish(
    job.run,
    job.token,
    { outcome: "done", summary: "等你决定", ask: [{ title: "要不要", text: "说明", options: ["要", "不要"] }] },
    at(0),
  );
  assert.equal(nextCard("chat", at(1)), null);
  assert.equal(nextCard("plain", at(1))!.title, "要不要");
});

test("a rule that lists no channel is not narrowed by a request that names one", () => {
  clean();
  use([rule("记一笔")]);
  ingest("app", note("e2"), at(0), "plain");
  assert.deepEqual(runs(), [{ rule: "记一笔", target_channel: null }]);
});

test("a name the rules do not know is refused, and nothing is written", () => {
  clean();
  use([rule("意见", { channels: ["chat", "plain"] })]);
  const before = getView().seq;
  for (const bad of ["nowhere", "constructor", "toString"]) {
    assert.throws(() => ingest("app", note("e3"), at(0), bad), InputError, `${bad} is not a channel`);
  }
  assert.equal(getView().seq, before, "no fact was written");
  assert.deepEqual(counts(), { events: 0, runs: 0, links: 0 });
});

test("a rule that does not allow the name refuses the whole request", () => {
  clean();
  use([rule("允许", { channels: ["chat", "plain"] }), rule("只给聊天", { channels: ["chat"] })]);
  const before = getView().seq;
  assert.throws(() => ingest("app", note("e4"), at(0), "plain"), InputError);
  assert.equal(getView().seq, before, "no fact was written, not even for the rule that allows it");
  assert.deepEqual(counts(), { events: 0, runs: 0, links: 0 });
});

test("the same event delivered again keeps the route it first had", () => {
  clean();
  use([rule("意见", { channels: ["chat", "plain"] })]);
  ingest("app", note("e5"), at(0), "plain");
  const before = counts();
  const again = ingest("app", note("e5"), at(1), "chat");
  assert.equal(again.duplicate, true);
  assert.deepEqual(again.routed, ["意见"], "the first delivery's rules are the ones reported");
  assert.deepEqual(counts(), before);
  assert.deepEqual(runs(), [{ rule: "意见", target_channel: "plain" }], "a later name changes nothing");
});

test("the event body still cannot name a channel", () => {
  clean();
  use([rule("意见", { channels: ["chat", "plain"] })]);
  assert.throws(() => ingest("app", { ...note("e6"), target_channel: "plain" }, at(0)), InputError);
  assert.deepEqual(counts(), { events: 0, runs: 0, links: 0 });
});

test("two subjects on one rule and subject are kept apart when their channels differ", () => {
  clean();
  use([rule("归并", { channels: ["chat", "plain"], parallel: 2 })]);
  ingest("app", note("m1", "#1"), at(0), "plain");
  ingest("app", note("m2", "#1"), at(0), "chat");
  assert.deepEqual(runs(), [
    { rule: "归并", target_channel: "plain" },
    { rule: "归并", target_channel: "chat" },
  ]);
  // The same channel again joins the run that is already waiting rather than starting another.
  ingest("app", note("m3", "#1"), at(0), "plain");
  assert.deepEqual(runs(), [
    { rule: "归并", target_channel: "plain" },
    { rule: "归并", target_channel: "chat" },
  ]);
  assert.equal(counts().links, 3);
});

test("a derived event takes the channel its own rule's default gives, not its parent's", () => {
  clean();
  use([
    rule("上游", { channels: ["chat", "plain"], emits: { source: "app", types: ["derived.done"] } }),
    rule("下游", { when: { source: "app", types: ["derived.done"] }, channels: ["chat"] }),
  ]);
  ingest("app", note("u1"), at(0), "plain");
  const parent = claimNext("w1", "c2", at(0))!;
  assert.deepEqual(
    runs(),
    [{ rule: "上游", target_channel: "plain" }],
    "the parent event matches the upstream rule alone",
  );
  started(parent.run, parent.token, { session: "s2" }, at(0));
  finish(
    parent.run,
    parent.token,
    { outcome: "done", summary: "", events: [{ type: "derived.done", id: "d1" }] },
    at(0),
  );
  assert.deepEqual(runs(), [
    { rule: "上游", target_channel: "plain" },
    { rule: "下游", target_channel: "chat" },
  ]);
});
