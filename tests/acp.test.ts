// Failure modes: loading history becomes this turn's answer; a restarted bridge forgets the agent's session; thought/tool
// output becomes a receipt; unknown permissions are approved; paths escape through symlinks; an RPC error looks successful;
// a turn the agent took and then lost isn't marked as started, so the worker runs its prompt again; a session that couldn't
// be loaded is marked as started, so the worker never starts a new one; an agent is told a version number left behind by a
// release. Going on in a session, a failure before the prompt (the program exits at once, initialize fails, loading breaks
// off) is taken for a session that can't be gone on in, so the work is done again in a new one; an agent that refuses the
// session or can't go on in any isn't let go to a new one; an agent that only has session/resume is told session/load.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import acp from "../plugins/acp/agent.ts";
import { permission } from "../plugins/acp/bridge.ts";
import { versionName } from "../host/version.ts";
import { acpAgent } from "./helpers.ts";
const home = mkdtempSync(join(tmpdir(), "agent-autoloop-acp-"));
after(() => rmSync(home, { recursive: true, force: true }));
const fake = join(home, "fake.mjs");
writeFileSync(
  fake,
  `
import readline from 'node:readline';
import { writeFileSync } from 'node:fs';
const send=x=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...x})+'\\n');
const update=(sessionUpdate,text)=>send({method:'session/update',params:{sessionId:'agent-session',update:{sessionUpdate,content:{type:'text',text}}}});
readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;
if(m.method==='initialize'){writeFileSync(${JSON.stringify(join(home, "client-version"))},m.params.clientInfo.version);send({id:m.id,result:{protocolVersion:1,agentCapabilities:{loadSession:true}}});}
if(m.method==='session/new')send({id:m.id,result:{sessionId:'agent-session'}});
if(m.method==='session/load'){if(m.params.sessionId!=='agent-session')return send({id:m.id,error:{code:-1,message:'bad session'}});update('agent_message_chunk','旧历史');send({id:m.id,result:{}});}
if(m.method==='session/prompt'){if(m.params.prompt[0].text==='中途断了'){update('tool_call','');process.exit(9);}update('agent_thought_chunk','思考');update('agent_message_chunk','中间消息');update('tool_call','');update('agent_message_chunk',m.params.prompt[0].text);send({id:m.id,result:{stopReason:'end_turn'}});}
});`,
);
const bridged = (command: string[], resume: string | null, prompt = "完成了", access = "read") =>
  new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
    const child = spawn(
      process.execPath,
      [
        "--disable-warning=ExperimentalWarning",
        join(import.meta.dirname, "../plugins/acp/bridge.ts"),
        JSON.stringify({ command, cwd: home, prompt, access, resume }),
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let out = "";
    let err = "";
    child.stdout.on("data", (b) => (out += b));
    child.stderr.on("data", (b) => (err += b));
    child.on("close", (code) => resolve({ code, out, err }));
  });
const run = (resume: string | null, prompt = "完成了") => bridged([process.execPath, fake], resume, prompt);
/** One launch of a stand-in agent. */
const launch = (name: string, script: string, resume: string | null = null, prompt?: string, access?: string) =>
  bridged([process.execPath, acpAgent(home, name, script)], resume, prompt, access);
const refusing = (message: string) =>
  `(m) => send({ id: m.id, error: { code: -32000, message: ${JSON.stringify(message)} } })`;
const declaring = (capabilities: object) =>
  `on.initialize = (m) => send({ id: m.id, result: { protocolVersion: 1, agentCapabilities: ${JSON.stringify(capabilities)} } });`;
test("ACP speaks v1, resumes across processes, discards history and returns only the final answer", async () => {
  for (const resume of [null, "agent-session"]) {
    const r = await run(resume);
    assert.equal(r.code, 0, r.err);
    const lines = r.out
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    assert.equal(lines.at(-1).text, "完成了");
    assert.equal(lines.at(-1).session, "agent-session");
    assert.ok(!r.out.includes("旧历史"));
    assert.ok(!r.out.includes("思考"));
  }
  const bad = await run("missing-session");
  assert.notEqual(bad.code, 0);
  assert.match(bad.err, /bad session/);
});
test("ACP says a turn started once the agent has the prompt, and never for a session it couldn't load", async () => {
  for (const resume of [null, "agent-session"]) {
    const ok = await run(resume);
    assert.equal(
      JSON.parse(ok.out.split("\n")[0]).started,
      true,
      "printed before the prompt goes, so it survives a kill",
    );
    assert.equal(acp.read(ok.out, null, "").started, true);
    assert.equal(acp.read(ok.out, ok.code, ok.err).text, "完成了");
    const lost = await run(resume, "中途断了");
    assert.notEqual(lost.code, 0);
    const reading = acp.read(lost.out, lost.code, lost.err);
    assert.deepEqual(
      [reading.started, reading.session, reading.text],
      [true, "agent-session", undefined],
      "a broken turn keeps its session and doesn't count as an answer",
    );
    assert.match(reading.error!, /ACP/);
  }
  const missing = await run("missing-session");
  const reading = acp.read(missing.out, missing.code, missing.err);
  assert.equal(reading.started, undefined);
  assert.match(reading.error!, /bad session/);
});
for (const [what, script] of [
  ["exits as soon as it starts", "process.exit(3);"],
  ["fails to initialize", `on.initialize = ${refusing("初始化坏了")};`],
  ["speaks another version", "on.initialize = (m) => send({ id: m.id, result: { protocolVersion: 99 } });"],
  ["exits while loading the session", "on['session/load'] = () => process.exit(4);"],
  [
    "exits while resuming the session",
    `${declaring({ sessionCapabilities: { resume: {} } })} on['session/resume'] = () => process.exit(4);`,
  ],
] as const) {
  test(`ACP going on in a session stays there when the agent ${what}`, async () => {
    const result = await launch(what.replaceAll(" ", "-"), script, "agent-session");
    assert.notEqual(result.code, 0);
    const reading = acp.read(result.out, result.code, result.err);
    assert.deepEqual([reading.started, reading.session], [true, "agent-session"]);
    assert.ok(reading.error);
    assert.equal(acp.read(result.out, null, "").started, true, "and it reads that way while it's going");
  });
}

test("ACP going on in a session stays there when the program can't be started at all", async () => {
  const result = await bridged([join(home, "not-there")], "agent-session");
  assert.notEqual(result.code, 0);
  const reading = acp.read(result.out, result.code, result.err);
  assert.deepEqual([reading.started, reading.session], [true, "agent-session"]);
});

test("ACP lets a new session start only when the agent says no to this one", async () => {
  for (const [name, script, why] of [
    ["refuses-load", `on['session/load'] = ${refusing("没有这个会话")};`, /没有这个会话/],
    [
      "refuses-resume",
      `${declaring({ sessionCapabilities: { resume: {} } })} on['session/resume'] = ${refusing("没有这个会话")};`,
      /没有这个会话/,
    ],
    ["cannot-resume", declaring({}), /不支持恢复/],
  ] as const) {
    const result = await launch(name, script, "agent-session");
    assert.notEqual(result.code, 0);
    const reading = acp.read(result.out, result.code, result.err);
    assert.equal(reading.started, undefined, name);
    assert.match(reading.error!, why);
    assert.equal(acp.read(result.out, null, "").started, undefined, `${name}: and it reads that way while it's going`);
  }
  const fresh = await launch("fresh-breaks", `on.initialize = ${refusing("初始化坏了")};`);
  assert.equal(acp.read(fresh.out, fresh.code, fresh.err).started, undefined, "a new session has nothing to stay in");
});

test("ACP uses session/resume for an agent that only has that, and session/load for one that has both", async () => {
  const called = join(home, "resume-method");
  const record = `(m) => { appendFileSync(${JSON.stringify(called)}, JSON.stringify([m.method, m.params.sessionId, m.params.cwd, m.params.mcpServers])); send({ id: m.id, result: {} }); }`;
  const both = `on['session/load'] = ${record}; on['session/resume'] = ${record};`;
  const onlyResume = await launch(
    "only-resume",
    `${declaring({ sessionCapabilities: { resume: {} } })} ${both}`,
    "agent-session",
  );
  assert.equal(onlyResume.code, 0, onlyResume.err);
  assert.equal(acp.read(onlyResume.out, onlyResume.code, onlyResume.err).text, "做完了");
  assert.deepEqual(JSON.parse(readFileSync(called, "utf8")), ["session/resume", "agent-session", home, []]);
  rmSync(called);
  const hasBoth = await launch(
    "has-both",
    `${declaring({ loadSession: true, sessionCapabilities: { resume: {} } })} ${both}`,
    "agent-session",
  );
  assert.equal(hasBoth.code, 0, hasBoth.err);
  assert.deepEqual(JSON.parse(readFileSync(called, "utf8")), ["session/load", "agent-session", home, []]);
});

test("ACP chooses only a one-time permission and respects structured kinds and resolved paths", () => {
  const options = [
    { optionId: "always", kind: "allow_always" },
    { optionId: "once", kind: "allow_once" },
    { optionId: "no", kind: "reject_once" },
  ];
  const ask = (access: string, toolCall: any) => permission({ access, cwd: home } as any, { options, toolCall });
  assert.equal(ask("read", { kind: "read" }).outcome, "selected");
  assert.equal(ask("read", { kind: "execute", title: "read file" }).optionId, "no");
  assert.equal(ask("edit", { kind: "edit", locations: [{ path: join(home, "new.txt") }] }).optionId, "once");
  mkdirSync(join(home, "work"));
  symlinkSync(tmpdir(), join(home, "work", "escape"));
  assert.equal(
    ask("edit", { kind: "edit", locations: [{ path: join(home, "work", "escape", "outside") }] }).optionId,
    "no",
  );
  assert.equal(ask("edit", { kind: "other" }).optionId, "no");
  assert.equal(ask("full", { kind: "other" }).optionId, "once");
});
test("ACP refuses incompatible versions and premature process exit", async () => {
  const original = await import("node:fs").then((fs) => fs.readFileSync(fake, "utf8"));
  try {
    writeFileSync(fake, original.replace("protocolVersion:1", "protocolVersion:99"));
    assert.notEqual((await run(null)).code, 0);
    writeFileSync(fake, "process.exit(0)");
    assert.notEqual((await run(null)).code, 0);
  } finally {
    writeFileSync(fake, original);
  }
});

test("the agent is told which version this is", async () => {
  await run(null);
  assert.equal(readFileSync(join(home, "client-version"), "utf8"), versionName());
});
