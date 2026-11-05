// Failure modes: a lost dispatch reply starts two runs; changed retries silently reuse an id;
// resuming another profile steals a session; retry merges separately acknowledged batches;
// rule reload changes a pinned dispatch; ordinary ingress can inject execution controls.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { empty, evolve, rows, snapshot, type Fact } from "../kernel/evolve.ts";
import { decide } from "../kernel/decide.ts";
import { parseRules } from "../protocol/rules.ts";
const env = { secret: "dispatch-test", publicUrl: "https://hub.test" };
const rules = parseRules(readFileSync(new URL("./rules.fixture.json", import.meta.url), "utf8"), 0, "UTC");
function fixture() {
  let view = empty(),
    now = 1000;
  const log: Fact[] = [];
  const act = (type: string, ...args: any[]) => {
    const d = decide(view, { type, args }, now++, env);
    log.push(...d.facts);
    view = evolve(view, d.facts);
    return d.value;
  };
  act("rules", rules);
  const event = (id: string) => act("ingest", "app", { id, type: "manual.unrouted", subject: id }).event;
  const request = (id: string) => ({ id, rule: "意见", lane: "task:one", eventIds: [event(id)] });
  return { act, event, request, view: () => view, log };
}
test("dispatch is atomic, idempotent and replayable; changed payload conflicts", () => {
  const f = fixture(),
    q = f.request("one"),
    r = f.act("dispatch", q);
  assert.equal(f.act("dispatch", q).run, r.run);
  assert.equal(rows(f.view(), "runs").length, 1);
  assert.throws(() => f.act("dispatch", { ...q, lane: "other" }), /相同/);
  assert.deepEqual(snapshot(evolve(empty(), f.log)), snapshot(f.view()));
  assert.throws(() => f.act("dispatch", { ...q, id: "bad", eventIds: [999999] }), /事件/);
  assert.equal(rows(f.view(), "runs").length, 1);
});
test("dispatch batches stay separate, lane serializes and resumed session comes from completed compatible run", () => {
  const f = fixture(),
    a = f.act("dispatch", f.request("a"));
  const first = f.act("claimNext", "w1", "first");
  assert.equal(first.run, a.run);
  f.act("started", first.run, first.token, { session: "session-one" });
  assert.throws(() => f.act("dispatch", { ...f.request("early"), resumeFrom: a.run }), /结束/);
  f.act("finish", first.run, first.token, { outcome: "done", summary: "done", session: "session-one" });
  const b = f.act("dispatch", { ...f.request("b"), resumeFrom: a.run, context: { replyTo: "message-b" } });
  f.act("dispatch", f.request("c"));
  const next = f.act("claimNext", "w1", "second");
  assert.equal(next.run, b.run);
  assert.equal(next.session, "session-one");
  assert.deepEqual(next.context.dispatch.context, { replyTo: "message-b" });
  assert.equal(f.act("claimNext", "w1", "third"), null);
  f.act("finish", next.run, next.token, { outcome: "failed", error: "temporary" });
  assert.equal(rows(f.view(), "runs").length, 3);
});
test("explicit dispatch pins rule version; profile mismatch and unknown fields are rejected", () => {
  const f = fixture(),
    a = f.act("dispatch", f.request("a"));
  const j = f.act("claimNext", "w1", "a");
  f.act("finish", j.run, j.token, { outcome: "done", summary: "done", session: "s" });
  const changed = structuredClone(rules);
  changed.agents[changed.rules.find((r) => r.name === "意见")!.to].model = "different";
  f.act("rules", changed);
  assert.throws(() => f.act("dispatch", { ...f.request("b"), resumeFrom: a.run }), /配置/);
  assert.throws(() => f.act("dispatch", { ...f.request("c"), session: "injected" }), /字段/);
});

test("queued dispatch keeps its validated model after a rules reload", () => {
  const f = fixture(),
    request = f.request("pinned");
  f.act("dispatch", request);
  const changed = structuredClone(rules);
  changed.agents[changed.rules.find((r) => r.name === "意见")!.to].model = "changed";
  f.act("rules", changed);
  const job = f.act("claimNext", "w1", "pinned");
  assert.notEqual(job.agent.model, "changed");
});
test("context key ordering does not create a conflicting retry", () => {
  const f = fixture(),
    request = { ...f.request("ordered"), context: { a: 1, b: { x: 1, y: 2 } } };
  const first = f.act("dispatch", request);
  assert.equal(f.act("dispatch", { ...request, context: { b: { y: 2, x: 1 }, a: 1 } }).run, first.run);
});

test("resumed sessions cannot run concurrently even across different lanes", () => {
  const f = fixture(),
    a = f.act("dispatch", f.request("first"));
  const job = f.act("claimNext", "w1", "first");
  f.act("finish", job.run, job.token, { outcome: "done", summary: "done", session: "same-session" });
  const changed = structuredClone(rules);
  changed.rules.find((r) => r.name === "意见")!.parallel = 10;
  f.act("rules", changed);
  f.act("dispatch", { ...f.request("second"), lane: "task:second", resumeFrom: a.run });
  f.act("dispatch", { ...f.request("third"), lane: "task:third", resumeFrom: a.run });
  assert.ok(f.act("claimNext", "w1", "second"));
  assert.equal(f.act("claimNext", "w1", "third"), null);
});

test("cancel by dispatch id wins against delayed submission and stops queued work", () => {
  const f = fixture(),
    request = f.request("late");
  assert.deepEqual(f.act("cancelDispatch", "late"), { run: null, state: "cancelled" });
  assert.throws(() => f.act("dispatch", request), /取消/);
  assert.equal(rows(f.view(), "runs").length, 0);
  const next = f.act("dispatch", f.request("queued"));
  assert.equal(f.act("cancelDispatch", "queued").run, next.run);
  assert.equal(f.act("claimNext", "w1", "after-stop"), null);
  assert.equal(f.act("cancelDispatch", "queued").state, "cancelled");
});

// A worker may finish with failure just before learning about the owner's cancellation.
test("cancelled dispatch never retries a late failed receipt, including duplicate receipt replay", () => {
  const f = fixture();
  f.act("dispatch", f.request("cancel-race"));
  const job = f.act("claimNext", "w1", "claim");
  f.act("cancelDispatch", "cancel-race");
  const failure = { outcome: "failed", error: "connection closed", session: "original" };
  f.act("finish", job.run, job.token, failure);
  assert.equal(f.view().get("runs", job.run)!.state, "cancelled");
  assert.equal(f.act("finish", job.run, job.token, failure).duplicate, true);
  assert.equal(f.act("claimNext", "w1", "again"), null);
  assert.deepEqual(snapshot(evolve(empty(), f.log)), snapshot(f.view()));
});

// The opt-in dispatch guarantee must not silently change ordinary queue semantics.
test("ordinary runs retain upstream claim behavior when their session strings match", () => {
  const f = fixture();
  for (const subject of ["ordinary:a", "ordinary:b"]) {
    f.act("ingest", "app", { id: subject, type: "feedback.new", subject });
    const job = f.act("claimNext", "w1", subject);
    f.act("finish", job.run, job.token, {
      outcome: "done",
      session: "shared",
      ask: [{ title: subject, text: "continue", options: ["yes", "no"] }],
    });
  }
  for (const card of rows(f.view(), "cards")) f.act("answer", card.id, { choice: 0 });
  assert.equal(f.act("claimNext", "w1", "ordinary:first").session, "shared");
  assert.equal(f.act("claimNext", "w1", "ordinary:second")?.session, "shared");
});

for (const explicitFirst of [true, false])
  test(`explicit dispatch excludes an ordinary claimant of its session (explicit first: ${explicitFirst})`, () => {
    const f = fixture();
    f.act("ingest", "app", { id: "ordinary", type: "feedback.new", subject: "ordinary" });
    const job = f.act("claimNext", "w1", "initial");
    f.act("finish", job.run, job.token, {
      outcome: "done",
      session: "shared",
      ask: [{ title: "continue", text: "continue", options: ["yes", "no"] }],
    });
    const answer = () => f.act("answer", rows(f.view(), "cards")[0].id, { choice: 0 });
    const dispatch = () => f.act("dispatch", { ...f.request("explicit"), resumeFrom: job.run });
    if (explicitFirst) {
      dispatch();
      answer();
    } else {
      answer();
      dispatch();
    }
    assert.equal(f.act("claimNext", "w1", "first").session, "shared");
    assert.equal(f.act("claimNext", "w1", "second"), null);
  });
