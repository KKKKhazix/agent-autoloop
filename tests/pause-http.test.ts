// Rule control over HTTP and from the command line. Failure cases: someone other than the owner pauses, resumes or runs a
// rule; an unknown rule or capability gets a 200 or a 500 instead of saying it isn't there; a misspelt field is ignored;
// running a paused rule is accepted; the state doesn't show who paused what, why and until when, or which rules require
// what; a task that runs elsewhere, even one that can ask and go on in its cwd, is paused or run as if it were a rule; the
// command line doesn't reach these doors or says nothing useful.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { setup } from "./helpers.ts";

const home = setup("pause-http");
const rulesFile = join(home, "rules.json");
const fixture = JSON.parse(readFileSync(process.env.AGENT_AUTOLOOP_RULES!, "utf8"));
for (const rule of fixture.rules) if (["意见", "巡检"].includes(rule.name)) rule.requires = ["egress"];
fixture.elsewhere.push({ ...fixture.elsewhere[0], name: "会问的清理", cwd: "/tmp", prompt: "接着清理。" });
writeFileSync(rulesFile, JSON.stringify(fixture));
process.env.AGENT_AUTOLOOP_RULES = rulesFile;
const { serve } = await import("../host/http.ts");
const { addKey } = await import("../host/runtime.ts");

const owner = addKey("owner", "owner");
const worker = addKey("worker", "w1");
const server = serve(0, "127.0.0.1");
let base = "";
before(async () => {
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  writeFileSync(join(home, "config.json"), JSON.stringify({ url: base, owner }));
});
after(() => {
  server.closeAllConnections();
  server.close();
});

async function post(path: string, body?: unknown, key = owner) {
  const response = await fetch(base + path, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, json: await response.json() };
}
const state = async () => (await fetch(`${base}/v1/state`, { headers: { authorization: `Bearer ${owner}` } })).json();
const lineOf = async (name: string) => (await state()).lines.find((line: { name: string }) => line.name === name);
const rule = (name: string, action: string) => `/v1/rules/${encodeURIComponent(name)}/${action}`;

test("only the owner controls rules", async () => {
  for (const path of [
    rule("巡检", "pause"),
    rule("巡检", "resume"),
    rule("巡检", "run"),
    "/v1/requires/egress/pause",
  ]) {
    assert.equal((await post(path, {}, worker)).status, 401, path);
    assert.equal((await post(path, {}, "made-up")).status, 401, path);
  }
  assert.equal((await post("/v1/requires/egress/run", {})).status, 404, "a capability isn't run, only its rules");
});

test("pause, see it in the state, refuse a run, resume, run", async () => {
  const until = new Date(Date.now() + 3600_000).toISOString();
  const paused = await post(rule("巡检", "pause"), { reason: "上游在修", until });
  assert.equal(paused.status, 200);
  assert.equal(paused.json.changed, true);
  const shown = await lineOf("巡检");
  assert.deepEqual(
    shown.paused.map((p: any) => [p.kind, p.by, p.reason, p.until]),
    [["rule", "owner", "上游在修", until]],
  );
  assert.ok(shown.paused[0].since);
  assert.deepEqual(shown.requires, ["egress"]);
  assert.equal((await post(rule("巡检", "pause"), { reason: "上游在修", until })).json.changed, false);
  const refused = await post(rule("巡检", "run"));
  assert.equal(refused.status, 409);
  assert.match(refused.json.error, /暂停中/);
  assert.equal((await post(rule("巡检", "resume"))).json.changed, true);
  assert.deepEqual((await lineOf("巡检")).paused, []);
  const ran = await post(rule("巡检", "run"), { reason: "看一眼" });
  assert.equal(ran.status, 200);
  const run = (await state()).runs.find((r: any) => r.id === ran.json.run);
  assert.deepEqual([run.rule, run.state, run.manual, run.events[0].type], ["巡检", "queued", true, "run.manual"]);
});

test("a wrong name or body says what is wrong", async () => {
  const unknown = await post(rule("没有的", "pause"), {});
  assert.equal(unknown.status, 404);
  assert.match(unknown.json.error, /没有这条规则：没有的/);
  assert.equal((await post(rule("没有的", "run"))).status, 404);
  assert.equal((await post("/v1/requires/nothing/pause", {})).status, 404);
  for (const task of ["每周清理", "会问的清理"]) {
    for (const action of ["pause", "run"]) {
      const elsewhere = await post(rule(task, action), {});
      assert.equal(elsewhere.status, 400, `${task} ${action}`);
      assert.match(elsewhere.json.error, /在别处跑的定时任务/);
    }
  }
  const misspelt = await post(rule("巡检", "pause"), { reson: "x" });
  assert.equal(misspelt.status, 400);
  assert.match(misspelt.json.error, /reson/);
  assert.equal((await post(rule("巡检", "pause"), { until: "明天" })).status, 400);
  assert.equal((await post(rule("巡检", "pause"), [])).status, 400);
});

test("a capability pause and resume, and the state lists it with its rules", async () => {
  const paused = await post("/v1/requires/egress/pause", { reason: "出口断了" });
  assert.deepEqual(paused.json.rules.sort(), ["巡检", "意见"].sort());
  const listed = (await state()).pauses.find((p: any) => p.kind === "requires");
  assert.deepEqual([listed.name, listed.reason, listed.rules.sort()], ["egress", "出口断了", ["巡检", "意见"].sort()]);
  assert.deepEqual(
    (await lineOf("意见")).paused.map((p: any) => p.name),
    ["egress"],
  );
  const lifted = await post("/v1/requires/egress/resume");
  assert.deepEqual([lifted.json.changed, lifted.json.stillPaused], [true, []]);
});

test("the command line pauses, resumes and runs", async () => {
  // Not spawnSync: the hub answering it runs in this process.
  const cli = (...args: string[]) =>
    new Promise<{ status: number; stdout: string; stderr: string }>((resolve) => {
      const program = ["--disable-warning=ExperimentalWarning", "bin/agent-autoloop.ts", ...args];
      execFile(process.execPath, program, { cwd: join(import.meta.dirname, "..") }, (error, stdout, stderr) =>
        resolve({ status: error ? Number(error.code ?? 1) : 0, stdout, stderr }),
      );
    });
  let done = await cli("pause", "早报", "--reason", "放假");
  assert.equal(done.status, 0, done.stderr);
  assert.match(done.stdout, /暂停了「早报」/);
  done = await cli("pause", "--requires", "egress", "--reason", "出口断了");
  assert.match(done.stdout, /暂停了/);
  done = await cli("resume", "--requires", "egress");
  assert.match(done.stdout, /恢复了能力 egress/);
  done = await cli("run", "早报");
  assert.equal(done.status, 1);
  assert.match(done.stderr, /暂停中/);
  done = await cli("resume", "早报");
  assert.match(done.stdout, /恢复了「早报」/);
  done = await cli("run", "早报");
  assert.equal(done.status, 0, done.stderr);
  assert.match(done.stdout, /排上了：第 \d+ 轮/);
  done = await cli("pause", "没有的");
  assert.equal(done.status, 1);
  assert.match(done.stderr, /没有这条规则/);
});
