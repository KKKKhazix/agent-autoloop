// A stale console retry must never create a fresh run after a worker already claimed/completed it, nor retry a different
// task or newly selected Agent. The guard and queue update must be one decision, including pauses and unanswered asks.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { at, setup } from "./helpers.ts";

const home = setup("guarded-retry");
const rulesFile = join(home, "rules.json");
const initial = JSON.parse(readFileSync(process.env.AGENT_AUTOLOOP_RULES!, "utf8"));
initial.rules.push({
  ...initial.rules.find((rule: any) => rule.name === "意见"),
  name: "另一条意见",
  when: { source: "app", types: ["other.new"] },
});
initial.rules.push({
  ...initial.rules.find((rule: any) => rule.name === "意见"),
  name: "后续步骤",
  group: "later",
  when: { source: "app", types: ["step.new"] },
});
writeFileSync(rulesFile, JSON.stringify(initial));
process.env.AGENT_AUTOLOOP_RULES = rulesFile;
const hub = await import("./hub.ts");
const { rows } = await import("../kernel/evolve.ts");
const { makeHandler } = await import("../host/server.ts");
const owner = hub.addKey("owner", "owner");
const worker = hub.addKey("worker", "w1");
const runtime = makeHandler("test");
const { after } = await import("node:test");
after(runtime.close);

function clean() {
  for (const table of ["run_events", "runs", "events", "seen", "cards", "deliveries", "timers", "pauses"] as const)
    hub.fixtureClear(table);
  writeFileSync(rulesFile, JSON.stringify(initial));
  hub.reloadRules(rulesFile);
}
function retrying(now = at(0), subject = "#1") {
  hub.heartbeat("w1", [], now);
  hub.ingest("app", { id: `item-${subject}`, type: "feedback.new", subject }, now);
  const job = hub.claimNext("w1", `first-${subject}`, now)!;
  hub.finish(job.run, job.token, { outcome: "failed", error: "额度不足" }, now);
  return job.run;
}
const retry = (run: number, now: number, extra = {}) => {
  const expected = hub.getView().get("runs", run)!;
  return hub.execute(
    "runRule",
    [
      "意见",
      "owner",
      {
        subject: "#1",
        expectedRun: run,
        expectedAgent: "a1",
        expectedAttempts: expected?.attempts ?? 1,
        expectedNotBefore: expected?.not_before ?? new Date(at(5)).toISOString(),
        ...extra,
      },
    ],
    now,
  );
};
const runs = () => rows(hub.getView(), "runs");
const events = () => rows(hub.getView(), "events");

test("guarded retry advances exactly the waiting run once and preserves its original events and failure", () => {
  clean();
  const id = retrying();
  const original = hub.getView().get("runs", id)!;
  const done = retry(id, at(1));
  assert.equal(done.run, id);
  assert.equal(runs().length, 1);
  const waiting = hub.getView().get("runs", id)!;
  assert.deepEqual(
    [waiting.error, waiting.attempts, waiting.manual, waiting.not_before],
    [original.error, 1, 1, new Date(at(1)).toISOString()],
  );
  const count = events().length;
  assert.throws(() => retry(id, at(1)), /状态已变化/);
  assert.equal(events().length, count, "a double-click leaves no extra event");
  const job = hub.claimNext("w1", "retry", at(1))!;
  assert.equal(job.run, id);
  assert.equal(job.context.events.length, 2);
});

test("a stale retry cannot bypass the new backoff after the same run is claimed and fails again", () => {
  clean();
  const id = retrying();
  const before = hub.getView().get("runs", id)!;
  const stale = {
    subject: "#1",
    expectedRun: id,
    expectedAgent: "a1",
    expectedAttempts: before.attempts,
    expectedNotBefore: before.not_before,
  };
  hub.execute("runRule", ["意见", "owner", stale], at(1));
  const job = hub.claimNext("w1", "second-attempt", at(1))!;
  hub.finish(id, job.token, { outcome: "failed", error: "仍然额度不足" }, at(1));
  const count = events().length;
  const next = hub.getView().get("runs", id)!;
  assert.equal(next.attempts, 2);
  assert.throws(() => hub.execute("runRule", ["意见", "owner", stale], at(2)), /状态已变化/);
  assert.equal(events().length, count);
  assert.equal(hub.getView().get("runs", id)!.not_before, next.not_before);
});

test("a worker claim or completion winning the race cannot produce a second run", () => {
  for (const completed of [false, true]) {
    clean();
    const id = retrying();
    const job = hub.claimNext("w1", "worker-won", at(6))!;
    if (completed) hub.finish(id, job.token, { outcome: "done", summary: "做完了" }, at(6));
    const count = events().length;
    assert.throws(() => retry(id, at(6)), /状态已变化/);
    assert.equal(runs().length, 1);
    assert.equal(events().length, count);
  }
});

test("a different run, subject, rule target, or not-yet-failed task is rejected without queue mutation", () => {
  clean();
  const id = retrying();
  const count = events().length;
  assert.throws(() => retry(id + 100, at(1)), /状态已变化/);
  assert.throws(() => retry(id, at(1), { subject: "#2" }), /状态已变化/);
  assert.throws(() => retry(id, at(1), { expectedAgent: "a2" }), /状态已变化/);
  assert.throws(
    () =>
      hub.execute(
        "runRule",
        [
          "另一条意见",
          "owner",
          {
            subject: "#1",
            expectedRun: id,
            expectedAgent: "a1",
            expectedAttempts: hub.getView().get("runs", id)!.attempts,
            expectedNotBefore: hub.getView().get("runs", id)!.not_before,
          },
        ],
        at(1),
      ),
    /状态已变化/,
  );
  hub.ingest("app", { id: "unstarted", type: "feedback.new", subject: "#2" }, at(1));
  const unstarted = runs().find((run) => run.lane === "#2")!;
  assert.throws(() => retry(unstarted.id, at(1), { subject: "#2" }), /状态已变化/);
  assert.equal(events().length, count + 1);
});

test("rule reload invalidates the expected Agent but allows an explicit retry with the new one", () => {
  clean();
  const id = retrying();
  const changed = structuredClone(initial);
  changed.rules.find((rule: any) => rule.name === "意见").to = "a2";
  writeFileSync(rulesFile, JSON.stringify(changed));
  hub.reloadRules(rulesFile);
  assert.throws(() => retry(id, at(1)), /状态已变化/);
  assert.equal(retry(id, at(1), { expectedAgent: "a2" }).run, id);
});

test("a pause or unanswered task question blocks the guarded retry", () => {
  clean();
  const id = retrying();
  hub.execute("pauseRule", ["意见", "owner", {}], at(1));
  assert.throws(() => retry(id, at(1)), /暂停中/);
  hub.execute("resumeRule", ["意见"], at(1));
  hub.createCard(
    { key: "ask", rule: "意见", grp: "notes", lane: "#1", kind: "ask", title: "需要补充", text: "请确认" },
    at(1),
  );
  assert.throws(() => retry(id, at(1)), /状态已变化/);
  assert.equal(runs().length, 1);
});

test("unknown work in the same group and task cannot be duplicated by a guarded retry", () => {
  clean();
  const id = retrying();
  for (const minute of [1, 2]) {
    hub.execute("runRule", ["意见", "owner", { subject: "#1" }], at(minute));
    const job = hub.claimNext("w1", `failure-${minute}`, at(minute))!;
    hub.finish(id, job.token, { outcome: "failed", error: "额度不足" }, at(minute));
  }
  hub.ingest("app", { id: "other", type: "other.new", subject: "#1" }, at(3));
  const held = hub.claimNext("w1", "sibling", at(3))!;
  assert.equal(held.rule.name, "另一条意见");
  hub.heartbeat("w1", [], at(9));
  hub.sweep(at(9));
  assert.equal(hub.getView().get("runs", held.run)!.state, "unknown");
  assert.throws(() => retry(id, at(9)), /状态已变化/);
  assert.equal(runs().length, 2);
});

test("an explicit related-rule scope rejects another step's running work and unanswered question", () => {
  clean();
  const id = retrying();
  hub.ingest("app", { id: "step", type: "step.new", subject: "#1" }, at(1));
  const job = hub.claimNext("w1", "next-step", at(1))!;
  assert.equal(job.rule.name, "后续步骤");
  const relatedRules = ["意见", "后续步骤"];
  const count = events().length;
  assert.throws(() => retry(id, at(1), { relatedRules }), /状态已变化/);
  assert.equal(events().length, count);
  hub.finish(
    job.run,
    job.token,
    { outcome: "done", ask: [{ title: "确认下一步", text: "还要继续吗", options: ["继续", "不继续"] }] },
    at(1),
  );
  assert.throws(() => retry(id, at(1), { relatedRules }), /状态已变化/);
  assert.equal(events().length, count);
  assert.throws(() => retry(id, at(1), { relatedRules: ["不存在"] }), /relatedRules/);
});

test("HTTP guard fields are paired, owner-only and return conflict after the guarded task changes", async () => {
  clean();
  const now = Date.now();
  const id = retrying(now);
  const post = async (body: object, key = owner) =>
    runtime.handle(
      new Request("http://hub.test/v1/rules/" + encodeURIComponent("意见") + "/run", {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  const waiting = hub.getView().get("runs", id)!;
  const valid = {
    subject: "#1",
    expectedRun: id,
    expectedAgent: "a1",
    expectedAttempts: waiting.attempts,
    expectedNotBefore: waiting.not_before,
    relatedRules: ["意见"],
  };
  assert.equal((await post(valid, worker)).status, 401);
  for (const body of [
    { expectedRun: id },
    { expectedAgent: "a1" },
    { expectedAttempts: 1 },
    { expectedNotBefore: waiting.not_before },
    { relatedRules: ["意见"] },
    { ...valid, expectedRun: "1" },
    { ...valid, expectedAgent: "" },
  ])
    assert.equal((await post(body)).status, 400);
  const accepted = await post(valid);
  assert.equal(accepted.status, 200);
  assert.equal((await accepted.json()).run, id);
  assert.equal((await post(valid)).status, 409);
  assert.equal(runs().length, 1);
});
