// A self-reported success, skipped review, fabricated evidence, or cross-project result must not dispatch or close a goal.
import assert from "node:assert/strict";
import { test } from "node:test";
import { next, rulesFor } from "../examples/recipes/goal-loop/loop.ts";

const project = { id: "demo", goal: "写一份升级说明", acceptance: "覆盖回退", maxRounds: 2 };
const event = (type: string, source: string, detail = "") => ({ type, source, subject: "release", detail });
const plan = { decision: "task", capability: "draft", task: "写升级说明", acceptance: "包含回退步骤" };
const review = { ...plan, capability: "review", task: "检查回退步骤" };

test("completion requires review of the actual artifact and deterministic acceptance", () => {
  const policy = { ...project, maxRounds: 4, requiredText: ["回退"] };
  const start = next(policy, "plan", [event("run.manual", "goal-demo-results")]);
  assert.throws(() => start.accept({ decision: "complete", reason: "自认为完成" }));
  assert.throws(() => start.accept(review));
  const send = (reply: ReturnType<typeof start.accept>, role: "draft" | "review" | "plan") =>
    next(policy, role, [{ ...reply.events![0], source: "goal-demo-" + (role === "plan" ? "results" : "tasks") }]);
  const draft = send(start.accept(plan), "draft");
  const planner = send(draft.accept({ status: "done", output: "升级说明", evidence: "自己检查过" }), "plan");
  assert.throws(() => planner.accept({ decision: "complete", reason: "执行结束" }));
  assert.throws(() => planner.accept(plan));
  const reviewer = send(planner.accept(review), "review");
  assert.throws(() => reviewer.accept({ status: "done", output: "通过", evidence: "升级说明", verdict: "pass" }));
  const fixing = send(
    reviewer.accept({ status: "done", output: "缺少回退", evidence: "升级说明", verdict: "revise" }),
    "plan",
  );
  assert.throws(() => fixing.accept({ decision: "complete", reason: "忽略问题" }));
  const repair = send(fixing.accept(plan), "draft");
  assert.equal(JSON.parse(repair.input).previousResult.artifact, "升级说明");
  const checking = send(repair.accept({ status: "done", output: "升级说明与回退", evidence: "已修改" }), "plan");
  const recheck = send(checking.accept(review), "review");
  assert.throws(() => recheck.accept({ status: "done", output: "通过", evidence: "不存在的证据", verdict: "pass" }));
  assert.throws(() =>
    recheck.accept({
      status: "done",
      output: "通过",
      evidence: "升级说明与回退",
      verdict: "pass",
      artifact: "别的草稿",
    }),
  );
  const exhausted = send(
    recheck.accept({ status: "done", output: "仍需修正", evidence: "回退", verdict: "revise" }),
    "plan",
  );
  assert.match(exhausted.accept(plan).summary, /已达到项目轮数上限/);
  assert.match(exhausted.accept({ decision: "complete", reason: "轮数用完" }).summary, /已达到项目轮数上限/);
  const closing = send(
    recheck.accept({ status: "done", output: "通过", evidence: "升级说明与回退", verdict: "pass" }),
    "plan",
  );
  assert.match(closing.accept({ decision: "complete", reason: "验收通过" }).summary, /验收通过，已结项/);
});

test("blocked work cannot complete or dispatch another task", () => {
  const task = next(project, "plan", [event("run.manual", "goal-demo-results")]).accept(plan).events![0];
  const result = next(project, "draft", [{ ...task, source: "goal-demo-tasks" }]).accept({
    status: "blocked",
    output: "缺资料",
    evidence: "没有输入",
  }).events![0];
  const planner = next(project, "plan", [{ ...result, source: "goal-demo-results" }]);
  assert.throws(() => planner.accept({ decision: "complete", reason: "完成" }));
  assert.throws(() => planner.accept(review));
  assert.match(planner.accept({ decision: "stop", reason: "需要资料" }).summary, /规划停止/);
});

test("a passing review returns the bound artifact to the same planner and closes the goal", () => {
  const planner = next(project, "plan", [event("run.manual", "goal-demo-results")]);
  const task = planner.accept(plan).events![0];
  const execution = next(project, "draft", [{ ...task, source: "goal-demo-tasks" }]);
  const result = execution.accept({ status: "done", output: "升级和回退说明", evidence: "覆盖了回退步骤" }).events![0];
  const followup = next(project, "plan", [{ ...result, source: "goal-demo-results" }]);
  assert.equal(JSON.parse(followup.input).result.output, "升级和回退说明");
  const second = followup.accept(review).events![0];
  const final = next(project, "review", [{ ...second, source: "goal-demo-tasks" }]).accept({
    status: "done",
    output: "回退步骤完整",
    evidence: "升级和回退说明",
    verdict: "pass",
  }).events![0];
  const last = next(project, "plan", [{ ...final, source: "goal-demo-results" }]);
  assert.equal(last.accept({ decision: "complete", reason: "两项证据均已收到" }).events, undefined);
  assert.throws(() => last.accept(plan));
  assert.equal(
    rulesFor(project, "worker", "/tmp/demo.json").rules.filter((rule) => rule.name.endsWith("规划")).length,
    1,
  );
});

test("cross-project events, wrong capabilities and extra permission fields cannot dispatch", () => {
  assert.throws(() => next(project, "plan", [event("run.manual", "goal-other-results")]));
  const planner = next(project, "plan", [event("run.manual", "goal-demo-results")]);
  assert.throws(() => planner.accept({ ...plan, capability: "push" }));
  assert.throws(() => planner.accept({ ...plan, cwd: "/another/project", access: "full" }));
  const task = planner.accept(plan).events![0];
  assert.throws(() => next(project, "review", [{ ...task, source: "goal-demo-tasks" }]));
});

test("the hub journals each handoff once and rejects a result token from another project", async () => {
  const { setup, beforeCleanup } = await import("./helpers.ts");
  const { writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const home = setup("goal-loop");
  const path = join(home, "rules.json");
  const a = rulesFor(project, "worker", join(home, "a.json"));
  const b = rulesFor({ ...project, id: "other" }, "other-worker", join(home, "b.json"));
  writeFileSync(
    path,
    JSON.stringify({
      agents: { ...a.agents, ...b.agents },
      sources: { ...a.sources, ...b.sources },
      rules: [...a.rules, ...b.rules],
    }),
  );
  process.env.AGENT_AUTOLOOP_RULES = path;
  const { serve } = await import("../host/http.ts");
  const { addKey, db } = await import("../host/runtime.ts");
  const { hubClient, HubError } = await import("../protocol/client.ts");
  const { once } = await import("node:events");
  beforeCleanup.push(() => db.close());
  const server = serve(0, "127.0.0.1");
  beforeCleanup.push(() => {
    server.closeAllConnections();
    server.close();
  });
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = "http://127.0.0.1:" + address.port;
  const owner = hubClient(url, addKey("owner", "owner"));
  const worker = hubClient(url, addKey("worker", "worker"));
  const otherWorker = hubClient(url, addKey("worker", "other-worker"));
  await owner.run("demo 目标规划", { subject: "release" });
  await owner.run("other 目标规划", { subject: "release" });
  const work = async (client: typeof worker, n: number) => {
    const { job } = await client.work({ claim: "claim-" + n, wait: 0, running: [], capacity: true });
    assert.ok(job);
    await client.started(job.run, job.token, {});
    return job;
  };
  const first = await work(worker, 1);
  const other = await work(otherWorker, 1);
  const proposal = { outcome: "done", ...next(project, "plan", first.context.events).accept(plan) };
  await assert.rejects(worker.result(other.run, first.token, proposal), (error) => error instanceof HubError);
  assert.deepEqual((await worker.result(first.run, first.token, proposal)).rejected, []);
  await worker.result(first.run, first.token, proposal);
  const draft = await work(worker, 2);
  assert.equal(draft.rule.name, "demo 起草");
  await worker.result(draft.run, draft.token, {
    outcome: "done",
    ...next(project, "draft", draft.context.events).accept({ status: "done", output: "回退步骤", evidence: "已列出" }),
  });
  const second = await work(worker, 3);
  assert.equal(second.agent.id, first.agent.id);
  assert.equal(JSON.parse(next(project, "plan", second.context.events).input).result.output, "回退步骤");
  await worker.result(second.run, second.token, {
    outcome: "done",
    ...next(project, "plan", second.context.events).accept(review),
  });
  const check = await work(worker, 4);
  assert.equal(check.rule.name, "demo 审查");
  await worker.result(check.run, check.token, {
    outcome: "done",
    ...next(project, "review", check.context.events).accept({
      status: "done",
      output: "回退完整",
      evidence: "回退步骤",
      verdict: "pass",
    }),
  });
  const closing = await work(worker, 5);
  assert.equal(closing.agent.id, first.agent.id);
  await worker.result(closing.run, closing.token, {
    outcome: "done",
    ...next(project, "plan", closing.context.events).accept({ decision: "complete", reason: "证据齐全" }),
  });
  assert.equal((await worker.work({ claim: "no-more", wait: 0, running: [], capacity: true })).job, null);
  assert.equal((await owner.state()).runs.filter((run: { rule: string }) => run.rule === "demo 起草").length, 1);
});

test("exhaustion is terminal before a planner model response is needed", () => {
  const policy = { ...project, maxRounds: 1 };
  const task = next(policy, "plan", [event("run.manual", "goal-demo-results")]).accept(plan).events![0];
  const result = next(policy, "draft", [{ ...task, source: "goal-demo-tasks" }]).accept({
    status: "done",
    output: "草稿",
    evidence: "写好了",
  }).events![0];
  const terminal = next(policy, "plan", [{ ...result, source: "goal-demo-results" }]);
  assert.match(terminal.automatic!.summary, /已达到项目轮数上限/);
  assert.equal(terminal.accept({ decision: "complete", reason: "错误的模型建议" }), terminal.automatic);
});

test("escaped text stays within the shared protocol handoff budget", () => {
  const planner = next(project, "plan", [event("run.manual", "goal-demo-results")]);
  const proposal = { ...plan, task: '"'.repeat(350), acceptance: "\\".repeat(200) };
  const task = planner.accept(proposal).events![0];
  const draft = next(project, "draft", [{ ...task, source: "goal-demo-tasks" }]);
  assert.throws(() => draft.accept({ status: "done", output: '"'.repeat(1000), evidence: "写好了" }));
  const result = draft.accept({ status: "done", output: '"'.repeat(500), evidence: "\\".repeat(175) }).events![0];
  const followup = next(project, "plan", [{ ...result, source: "goal-demo-results" }]).accept({
    ...proposal,
    capability: "review",
  }).events![0];
  const reviewed = next(project, "review", [{ ...followup, source: "goal-demo-tasks" }]).accept({
    status: "done",
    output: '"'.repeat(500),
    evidence: '"'.repeat(175),
    verdict: "revise",
  }).events![0];
  assert.ok([...reviewed.detail].length <= 4000);
});

test("each review retains its draft acceptance criteria without reusing obsolete task constraints", () => {
  const policy = { ...project, maxRounds: 4 };
  const first = next(policy, "plan", [event("run.manual", "goal-demo-results")]).accept({
    ...plan,
    acceptance: "说明何时触发回退及回退步骤",
  }).events![0];
  const result = next(policy, "draft", [{ ...first, source: "goal-demo-tasks" }]).accept({
    status: "done",
    output: "回退步骤",
    evidence: "写好了",
  }).events![0];
  const inspection = next(policy, "plan", [{ ...result, source: "goal-demo-results" }]).accept(review).events![0];
  assert.equal(JSON.parse(inspection.detail).task.acceptance, "说明何时触发回退及回退步骤");
  const rejected = next(policy, "review", [{ ...inspection, source: "goal-demo-tasks" }]).accept({
    status: "done",
    output: "缺少触发条件",
    evidence: "回退步骤",
    verdict: "revise",
  }).events![0];
  const repair = next(policy, "plan", [{ ...rejected, source: "goal-demo-results" }]).accept({
    ...plan,
    acceptance: "补齐触发条件并保留回退步骤",
  }).events![0];
  const fixed = next(policy, "draft", [{ ...repair, source: "goal-demo-tasks" }]).accept({
    status: "done",
    output: "触发条件与回退步骤",
    evidence: "已补齐",
  }).events![0];
  const recheck = next(policy, "plan", [{ ...fixed, source: "goal-demo-results" }]).accept(review).events![0];
  assert.equal(JSON.parse(recheck.detail).task.acceptance, "补齐触发条件并保留回退步骤");
});
