// Failure modes: default PATH / ~/.local/bin lookup or explicit program override picks the wrong binary; model, effort,
// access preset (--mode/--dangerously-skip-permissions/--sandbox), or --add-dir folder is dropped or mis-mapped; prompt
// characters trigger shell interpolation; link claims to open a desktop chat that CLI sessions do not share; Turn 1 drops
// conversation_id or Turn 2 fails to pass --conversation; stream-json step_update/result parsing loses started state,
// mistakes empty denied_actions responses for success, drops cumulative sessionUsage deltas, or turns noise/crash errors
// into answers; worker silently re-runs a crashed active turn; doctor misses unauthenticated `agy models`, outdated
// binaries without stream-json, missing/non-executable files, or leaks env credentials into child env or diagnostics.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { setup } from "./helpers.ts";
import { readMessage, resultFrom } from "../worker/contract.ts";

type Adapter = import("../worker/agents.ts").Adapter;

const scratch = mkdtempSync(join(tmpdir(), "agent-autoloop-agy-native-"));
const rulesFile = join(scratch, "rules.json");
const workdir = join(scratch, "project");
mkdirSync(workdir, { recursive: true });
const bin = join(import.meta.dirname, "../bin/agent-autoloop.ts");

const baseRules = (agent: Record<string, unknown>, ruleExtras: Record<string, unknown> = {}) => ({
  timezone: "Asia/Shanghai",
  sources: { manual: { name: "Manual" } },
  channels: { chat: { name: "桌面", answerers: ["me"] } },
  agents: { antigravity: agent },
  rules: [
    {
      name: "check",
      when: { source: "manual", types: ["check.*"] },
      to: "antigravity",
      group: "check-grp",
      cwd: workdir,
      prompt: "只读检查并返回结果",
      ...ruleExtras,
    },
  ],
});

const defaultFake = join(scratch, "agy");
const scriptFake = join(scratch, "agy-fake.mjs");
writeFileSync(
  scriptFake,
  `
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "--help") {
  if (process.env.AGY_FAKE_OLD === "1") {
    process.stderr.write("Usage of agy:\\n  -p  Run prompt\\n");
    process.exit(0);
  }
  process.stderr.write("Usage of agy:\\n  --output-format\\n  --conversation\\n  --mode\\n");
  process.exit(0);
}
if (args[0] === "models") {
  if (process.env.AGY_FAKE_UNAUTH === "1") {
    process.stderr.write(
      "Fetching available models...\\nError: Please sign in to view available models. Launch the CLI without arguments to sign in.\\n",
    );
    process.exit(1);
  }
  process.stderr.write("Fetching available models...\\n");
  process.stdout.write("gemini-3.8-flash-medium\\tGemini 3.8 Flash (Medium)\\n");
  process.exit(0);
}
const mode = process.env.AGY_FAKE_MODE || "normal";
const logFile = process.env.AGY_FAKE_LOG;
if (logFile) {
  appendFileSync(
    logFile,
    JSON.stringify({
      args,
      secret: process.env.AGENT_AUTOLOOP_SECRET_UNIT ?? null,
      agyToken: process.env.ANTIGRAVITY_CSRF_TOKEN ?? null,
    }) + "\\n",
  );
}
if (mode === "early-fail") {
  process.stderr.write("error: conversation missing-id not found\\n");
  process.exit(1);
}
const requestedPrompt = args[args.indexOf("-p") + 1] || "";
const repairTurn = requestedPrompt.startsWith("你上一条消息的回执读不懂");
const convIdx = args.indexOf("--conversation");
const resumeId = convIdx >= 0 ? args[convIdx + 1] : null;
let convId = resumeId || "agy-conv-1";
if ((mode === "missing-conv-fallback" || (mode === "bad-receipt-missing-conv" && repairTurn)) && resumeId) {
  process.stderr.write(\`warning: conversation "\${resumeId}" not found\\n\`);
  convId = "agy-conv-substituted";
}
const write = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");
write({ event: "init", conversation_id: convId, init: { cwd: process.cwd() } });
write({ event: "step_update", step_update: { conversation_id: convId, step_index: 0, state: "DONE", step_type: "user_input" } });
if (mode === "mid-crash") {
  write({ event: "step_update", step_update: { conversation_id: convId, step_index: 1, state: "ACTIVE", step_type: "agent_response", text_delta: "半截" } });
  process.stderr.write("stream disconnected\\n");
  process.exit(9);
}
if (mode === "hang") {
  setInterval(() => {}, 10_000);
} else {
  const promptIdx = args.indexOf("-p");
  const prompt = promptIdx >= 0 ? args[promptIdx + 1] : "";
  const stateFile = process.env.AGY_FAKE_STATE;
  let turn = 1;
  if (stateFile) {
    let cur = { turns: 0 };
    try { cur = JSON.parse(readFileSync(stateFile, "utf8")); } catch {}
    cur.turns += 1;
    turn = cur.turns;
    writeFileSync(stateFile, JSON.stringify(cur));
  }
  const usage = turn === 1
    ? { input_tokens: 100, output_tokens: 10, thinking_tokens: 4, cache_read_tokens: 5, total_tokens: 110 }
    : { input_tokens: 180, output_tokens: 22, thinking_tokens: 8, cache_read_tokens: 50, total_tokens: 202 };
  const text =
    mode === "bad-receipt-missing-conv"
      ? repairTurn
        ? "REPLACEMENT_RECEIPT"
        : "ORIGINAL_FIRST_LINE\\n" + String.fromCharCode(96).repeat(3) + "agent-autoloop\\n" + JSON.stringify({ ask: "invalid-receipt-shape" }) + "\\n" + String.fromCharCode(96).repeat(3)
      : "TURN_" + turn + ":" + prompt.slice(0, 40);
  write({ event: "step_update", step_update: { conversation_id: convId, step_index: 1, state: "ACTIVE", step_type: "agent_response", text_delta: text } });
  write({ event: "step_update", step_update: { conversation_id: convId, step_index: 1, state: "DONE", step_type: "agent_response", text_delta: "\\n", usage } });
  write({ event: "result", result: { conversation_id: convId, status: "SUCCESS", response: text + "\\n", num_turns: turn, usage } });
}
`,
);
writeFileSync(defaultFake, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(scriptFake)} "$@"\n`, {
  mode: 0o755,
});

const shell = join(scratch, "shell");
writeFileSync(
  shell,
  `#!/bin/sh
if [ "$1" = "-lc" ] && [ "$2" = "command -v agy" ]; then
  printf "%s\\n" "$AGY_TEST_PROGRAM"
  exit 0
fi
[ "$1" = "-lc" ] && exec /bin/sh -c "$2"
exec /bin/sh "$@"
`,
  { mode: 0o755 },
);

const usual = {
  SHELL: process.env.SHELL,
  HOME: process.env.HOME,
  AGY_TEST_PROGRAM: process.env.AGY_TEST_PROGRAM,
  AGENT_AUTOLOOP_SECRET_UNIT: process.env.AGENT_AUTOLOOP_SECRET_UNIT,
  ANTIGRAVITY_CSRF_TOKEN: process.env.ANTIGRAVITY_CSRF_TOKEN,
};
process.env.SHELL = shell;
process.env.HOME = scratch;
process.env.AGY_TEST_PROGRAM = defaultFake;
process.env.AGENT_AUTOLOOP_SECRET_UNIT = "top-secret-must-not-leak";
process.env.ANTIGRAVITY_CSRF_TOKEN = "csrf-must-not-leak";

writeFileSync(
  rulesFile,
  JSON.stringify(
    baseRules({
      name: "Antigravity",
      worker: "local",
      use: "antigravity",
      program: defaultFake,
      access: "read",
    }),
  ),
);

setup("antigravity", rulesFile);
after(() => {
  rmSync(scratch, { recursive: true, force: true });
  for (const [k, v] of Object.entries(usual)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const antigravity: Adapter = (await import("../plugins/antigravity/agent.ts")).default;
const { serve } = await import("../host/http.ts");
const hub = await import("./hub.ts");
const { hubClient } = await import("../protocol/client.ts");
const { createWorker } = await import("../worker/worker.ts");

const folder = join(scratch, "run-folder");
mkdirSync(folder, { recursive: true });

const turn = {
  prompt: "检查项目 ; $(id) `whoami` $HOME",
  session: "internal-fallback-id",
  resume: null,
  cwd: workdir,
  access: "read" as const,
  contextFile: join(folder, "context.json"),
  folder,
};

const runCommand = (argv: string[], extraEnv: Record<string, string | undefined> = {}) =>
  new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
    const child = spawn(argv[0], argv.slice(1), {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...extraEnv },
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (b) => (out += b));
    child.stderr.on("data", (b) => (err += b));
    child.on("close", (code) => resolve({ code, out, err }));
  });

const hasPair = (argv: string[], flag: string, value: string) => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] === value;
};

test("Antigravity: builds native agy CLI flags (program/PATH, -p, --conversation, --model, --effort, --mode/--sandbox/--dangerously-skip-permissions, --add-dir)", () => {
  assert.equal(antigravity.link, undefined, "CLI sessions are not claimed to share desktop links");

  const byPath = antigravity.command({ ...turn, model: "gemini-3.8-flash-medium", effort: "high" });
  assert.equal(byPath[0], defaultFake);
  assert.ok(hasPair(byPath, "-p", turn.prompt), "prompt must pass as -p value");
  assert.ok(hasPair(byPath, "--output-format", "stream-json"));
  assert.ok(hasPair(byPath, "--model", "gemini-3.8-flash-medium"));
  assert.ok(hasPair(byPath, "--effort", "high"));
  assert.ok(hasPair(byPath, "--mode", "plan"));
  assert.ok(byPath.includes("--sandbox"), "read access adds terminal --sandbox");
  assert.ok(hasPair(byPath, "--add-dir", folder));
  assert.equal(byPath.includes("--conversation"), false, "first turn lets agy create a new conversation UUID");

  const custom = "/opt/custom/bin/agy";
  const editTurn = antigravity.command({ ...turn, program: custom, access: "edit", resume: "conv-42" });
  assert.equal(editTurn[0], custom);
  assert.ok(hasPair(editTurn, "--conversation", "conv-42"));
  assert.ok(hasPair(editTurn, "--mode", "accept-edits"));
  assert.equal(editTurn.includes("--sandbox"), false);
  assert.equal(editTurn.includes("--dangerously-skip-permissions"), false);

  const fullTurn = antigravity.command({ ...turn, program: custom, access: "full" });
  assert.ok(fullTurn.includes("--dangerously-skip-permissions"));
  assert.equal(fullTurn.includes("--mode"), false, "avoid unavailable --mode auto warning");
});

test("Antigravity: parses stream-json init/step_update/result, mid-run poll vs final reading, cumulative usage, denied_actions, noise, and crash failures", () => {
  const runningOut = [
    "shell profile banner line",
    JSON.stringify({ event: "init", conversation_id: "conv-run-1", init: { cwd: workdir } }),
    JSON.stringify({
      event: "step_update",
      step_update: { conversation_id: "conv-run-1", step_index: 0, state: "DONE", step_type: "user_input" },
    }),
  ].join("\n");
  assert.deepEqual(antigravity.read(runningOut, null, ""), { session: "conv-run-1", started: true });

  const doneOut = [
    runningOut,
    JSON.stringify({
      event: "step_update",
      step_update: {
        conversation_id: "conv-run-1",
        step_index: 1,
        state: "DONE",
        step_type: "agent_response",
        text_delta: "结果文本\n",
      },
    }),
    JSON.stringify({
      event: "result",
      result: {
        conversation_id: "conv-run-1",
        status: "SUCCESS",
        response: "结果文本\n",
        num_turns: 2,
        usage: { input_tokens: 300, output_tokens: 45, thinking_tokens: 12, cache_read_tokens: 150, total_tokens: 345 },
      },
    }),
  ].join("\n");
  assert.deepEqual(antigravity.read(doneOut, 0, ""), {
    session: "conv-run-1",
    started: true,
    finished: true,
    text: "结果文本\n",
    sessionUsage: { input: 300, output: 45, cached: 150 },
  });

  // Auto-denied tool in headless mode returns SUCCESS + denied_actions (even if model apologizes in text) and jetski: on stderr
  const deniedOut = [
    JSON.stringify({ event: "init", conversation_id: "conv-denied" }),
    JSON.stringify({
      event: "step_update",
      step_update: { conversation_id: "conv-denied", step_index: 0, state: "DONE", step_type: "user_input" },
    }),
    JSON.stringify({
      event: "result",
      result: {
        conversation_id: "conv-denied",
        status: "SUCCESS",
        response: "Permission was denied for bash.",
        num_turns: 1,
        usage: { input_tokens: 100, output_tokens: 10, cache_read_tokens: 0 },
        denied_actions: [{ action: "command", display_name: "Bash" }],
      },
    }),
  ].join("\n");
  const deniedReading = antigravity.read(
    deniedOut,
    0,
    'jetski: no output produced — a tool required the "command" permission',
  );
  assert.equal(deniedReading.started, true);
  assert.equal(deniedReading.finished, true);
  assert.match(deniedReading.error ?? "", /Bash|权限/);
  assert.equal(deniedReading.text, undefined);

  // Pre-start error result (num_turns: 0, e.g. invalid --model/--effort) must not mark started or zero usage baseline
  const preStartErr = JSON.stringify({
    event: "result",
    result: {
      conversation_id: "conv-err",
      status: "ERROR",
      error: "invalid model selection",
      response: "",
      num_turns: 0,
      usage: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 0 },
    },
  });
  const errReading = antigravity.read(preStartErr, 1, "");
  assert.equal(errReading.started, undefined);
  assert.equal(errReading.sessionUsage, undefined);
  assert.equal(errReading.finished, true);
  assert.match(errReading.error ?? "", /invalid model selection/);

  // Real agy missing --conversation writes warning to stderr and silently creates a substitute conversation_id:
  // Init alone is not execution; an executed substitute must be tracked and paused for review, never replayed fresh.
  const subInit = JSON.stringify({ event: "init", conversation_id: "conv-substitute" });
  const subMid = antigravity.read(subInit, null, "", { resume: "conv-original" });
  assert.equal(subMid.session, undefined);
  assert.equal(subMid.started, undefined);
  const subDone = [
    subInit,
    JSON.stringify({
      event: "step_update",
      step_update: { conversation_id: "conv-substitute", step_index: 0, state: "DONE", step_type: "user_input" },
    }),
    JSON.stringify({
      event: "result",
      result: { conversation_id: "conv-substitute", status: "SUCCESS", response: "hallucinated", num_turns: 1 },
    }),
  ].join("\n");
  const subFinal = antigravity.read(subDone, 0, 'warning: conversation "conv-original" not found\n', {
    resume: "conv-original",
  });
  assert.equal(subFinal.started, true);
  assert.equal(subFinal.session, "conv-substitute");
  assert.equal(subFinal.error, undefined);
  assert.match(subFinal.text ?? "", /待你处理.*原会话/);
  assert.doesNotMatch(subFinal.text ?? "", /hallucinated/);
  const blocked = resultFrom(readMessage(subFinal.text!), {});
  assert.equal(blocked.problem, undefined);
  assert.equal(blocked.result.outcome, "done");
  assert.equal(blocked.result.ask?.length, 1);
  const repairing = antigravity.read(subDone, 0, 'warning: conversation "conv-original" not found\n', {
    resume: "conv-original",
    repair: true,
  });
  assert.equal(
    repairing.text,
    undefined,
    "receipt repair must preserve the original business result via discardReceipt",
  );
  assert.match(repairing.error ?? "", /原会话/);

  // Mid-turn crash keeps started:true and extracts stderr without returning half response
  const midCrash = antigravity.read(
    [
      JSON.stringify({ event: "init", conversation_id: "conv-crash" }),
      JSON.stringify({
        event: "step_update",
        step_update: { conversation_id: "conv-crash", step_index: 0, state: "DONE", step_type: "user_input" },
      }),
      JSON.stringify({
        event: "step_update",
        step_update: {
          conversation_id: "conv-crash",
          step_index: 1,
          state: "ACTIVE",
          step_type: "agent_response",
          text_delta: "半截回答",
        },
      }),
    ].join("\n"),
    9,
    "stream disconnected",
  );
  assert.equal(midCrash.started, true);
  assert.equal(midCrash.session, "conv-crash");
  assert.equal(midCrash.text, undefined);
  assert.match(midCrash.error ?? "", /stream disconnected/);

  // Pre-start exit leaves started undefined
  const earlyFail = antigravity.read("", 1, "conversation missing not found");
  assert.equal(earlyFail.started, undefined);
  assert.match(earlyFail.error ?? "", /conversation missing not found/);

  // Invalid / noise JSON lines never throw
  const noise = 'null\n42\n"words"\n[]\n{broken\nplain line\n';
  assert.doesNotThrow(() => antigravity.read(noise, null, ""));
  assert.doesNotThrow(() => antigravity.read(noise, 0, ""));
});

test("Antigravity: executes fake native binary end-to-end across two turns and extracts per-run results", async () => {
  const stateFile = join(scratch, "cli-state.json");
  const logFile = join(scratch, "cli-calls.jsonl");
  const env = { AGY_FAKE_STATE: stateFile, AGY_FAKE_LOG: logFile };

  const r1 = await runCommand(antigravity.command({ ...turn, model: "gemini-3.8-flash-medium", effort: "low" }), env);
  assert.equal(r1.code, 0, r1.err);
  const read1 = antigravity.read(r1.out, r1.code, r1.err);
  assert.equal(read1.started, true);
  assert.equal(read1.finished, true);
  assert.equal(read1.session, "agy-conv-1");
  assert.match(read1.text ?? "", /^TURN_1:/);
  assert.deepEqual(read1.sessionUsage, { input: 100, output: 10, cached: 5 });

  const r2 = await runCommand(
    antigravity.command({ ...turn, resume: read1.session!, prompt: "第二轮任务", access: "edit" }),
    env,
  );
  assert.equal(r2.code, 0, r2.err);
  const read2 = antigravity.read(r2.out, r2.code, r2.err);
  assert.equal(read2.session, "agy-conv-1");
  assert.match(read2.text ?? "", /^TURN_2:第二轮任务/);
  assert.deepEqual(read2.sessionUsage, { input: 180, output: 22, cached: 50 });

  const logged = readFileSync(logFile, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  assert.equal(logged.length, 2);
  assert.equal(logged[0].args.includes("--conversation"), false);
  assert.ok(hasPair(logged[1].args, "--conversation", "agy-conv-1"));
});

test("Antigravity: full worker + temp SQLite hub covers two turns with delta usage, mid-turn crash preservation, cancel, and credential stripping", async () => {
  const workerSecret = hub.addKey("worker", "local");
  const ownerKey = hub.addKey("owner", "me");
  const workerState = join(scratch, "worker-state.json");
  const workerLog = join(scratch, "worker-calls.jsonl");
  const workerBin = join(scratch, "agy-worker-bin");
  writeFileSync(
    workerBin,
    `#!/bin/sh
export AGY_FAKE_STATE=${JSON.stringify(workerState)}
export AGY_FAKE_LOG=${JSON.stringify(workerLog)}
if [ -f ${JSON.stringify(join(scratch, "worker.mode"))} ]; then
  export AGY_FAKE_MODE="$(cat ${JSON.stringify(join(scratch, "worker.mode"))})"
fi
exec ${JSON.stringify(process.execPath)} ${JSON.stringify(scriptFake)} "$@"
`,
    { mode: 0o755 },
  );

  writeFileSync(
    rulesFile,
    JSON.stringify(
      baseRules(
        {
          name: "Antigravity",
          worker: "local",
          use: "antigravity",
          program: workerBin,
          model: "gemini-3.8-flash-medium",
          effort: "medium",
          access: "read",
        },
        { resume: true },
      ),
    ),
  );
  assert.deepEqual(hub.reloadRules(rulesFile), {});

  const server = serve(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const port = (server.address() as AddressInfo).port;
  const workerHub = hubClient(`http://127.0.0.1:${port}`, workerSecret);
  const owner = hubClient(`http://127.0.0.1:${port}`, ownerKey);
  const worker = createWorker({ name: "local", wait: 0, hub: workerHub });

  try {
    const waitUntil = async (fn: () => Promise<boolean>, ms = 6000) => {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) {
        await worker.tick();
        if (await fn()) return;
        await new Promise((r) => setTimeout(r, 40));
      }
      const snapshot = await owner.state();
      throw new Error(`timed out waiting for hub state: ${JSON.stringify(snapshot.runs)}`);
    };

    // Turn 1
    hub.ingest("manual", { id: "ev-1", type: "check.run", subject: "same-thread", detail: "first" });
    await waitUntil(async () => (await owner.state()).runs.some((r: any) => r.state === "done"));
    const run1 = (await owner.state()).runs.find((r: any) => r.state === "done");
    assert.equal(run1.session, "agy-conv-1");
    assert.deepEqual(run1.usage, { input: 100, output: 10, cached: 5 });

    // Turn 2: resumes agy-conv-1 and computes per-run delta (180-100=80, 22-10=12, 50-5=45)
    hub.ingest("manual", { id: "ev-2", type: "check.run", subject: "same-thread", detail: "second" });
    await waitUntil(async () => (await owner.state()).runs.filter((r: any) => r.state === "done").length === 2);
    const run2 = (await owner.state()).runs[0];
    assert.equal(run2.session, "agy-conv-1");
    assert.deepEqual(run2.usage, { input: 80, output: 12, cached: 45 });

    const logged = readFileSync(workerLog, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    assert.equal(logged[0].secret, null, "AGENT_AUTOLOOP_SECRET_* must be stripped from child env");
    assert.equal(logged[0].agyToken, null, "ANTIGRAVITY_* host session env must be stripped from child env");
    assert.equal(logged[1].secret, null);
    assert.equal(logged[1].agyToken, null);
    assert.ok(hasPair(logged[1].args, "--conversation", "agy-conv-1"));

    // Missing conversation has already executed in a substitute: record it once and ask, never fresh replay.
    writeFileSync(join(scratch, "worker.mode"), "missing-conv-fallback");
    hub.ingest("manual", { id: "ev-missing", type: "check.run", subject: "same-thread", detail: "recover-missing" });
    await waitUntil(async () => (await owner.state()).runs.filter((r: any) => r.state === "done").length === 3);
    const runRecovered = (await owner.state()).runs[0];
    assert.equal(runRecovered.session, "agy-conv-substituted");
    assert.match(runRecovered.summary ?? "", /待你处理.*原会话/);
    const recoveryCard = (await owner.state()).cards.find((c: any) => c.kind === "ask");
    assert.ok(recoveryCard, "executed substitute must pause for an owner decision");
    const afterMissingLog = readFileSync(workerLog, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    assert.equal(
      afterMissingLog.length,
      3,
      "ev-missing executes only once; worker and Hub must not retry the completed substitute",
    );
    assert.ok(hasPair(afterMissingLog[2].args, "--conversation", "agy-conv-1"));
    await worker.tick();
    assert.equal(readFileSync(workerLog, "utf8").trim().split("\n").length, 3);
    await owner.resolve(recoveryCard.id, "隔离测试已核对；结束该阻塞，不继续执行");

    // Receipt repair must reject a substituted blank session and preserve original Turn 1 business result (discardReceipt)
    writeFileSync(join(scratch, "worker.mode"), "bad-receipt-missing-conv");
    hub.ingest("manual", { id: "ev-repair", type: "check.run", subject: "repair-thread", detail: "repair" });
    await waitUntil(async () => (await owner.state()).runs.filter((r: any) => r.state === "done").length === 4);
    const runRepaired = (await owner.state()).runs.find((r: any) =>
      r.events?.some((e: any) => e.subject === "repair-thread"),
    );
    assert.equal(runRepaired.summary, "ORIGINAL_FIRST_LINE");

    // Cancellation while running (run before queued retry backoff absorbs subsequent events in the same group)
    writeFileSync(join(scratch, "worker.mode"), "hang");
    hub.ingest("manual", { id: "ev-3", type: "check.run", subject: "cancel-thread", detail: "hang" });
    await waitUntil(async () => (await owner.state()).runs.some((r: any) => r.state === "claimed"));
    const runningId = (await owner.state()).runs.find((r: any) => r.state === "claimed").id;
    await owner.cancel(runningId);
    await waitUntil(async () =>
      (await owner.state()).runs.some((r: any) => r.id === runningId && r.state === "cancelled"),
    );

    // Mid-turn crash stays on agy-conv-1 without silently starting a new session
    writeFileSync(join(scratch, "worker.mode"), "mid-crash");
    hub.ingest("manual", { id: "ev-4", type: "check.run", subject: "same-thread", detail: "crash" });
    await waitUntil(async () => (await owner.state()).runs.some((r: any) => r.attempts >= 1 && r.error));
    const runCrash = (await owner.state()).runs.find((r: any) => r.attempts >= 1 && r.error);
    assert.equal(runCrash.session, "agy-conv-1");
    assert.match(runCrash.error, /stream disconnected/);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test("Antigravity: doctor detects missing binary, non-executable file, outdated CLI, unauthenticated models, ~/.local/bin fallback, and valid CLI without leaking secrets", async () => {
  const doctorHome = mkdtempSync(join(tmpdir(), "agent-autoloop-agy-doc-"));
  const doctorRules = join(doctorHome, "rules.json");
  const server = serve(0);
  await new Promise((r) => server.once("listening", r));
  const port = (server.address() as AddressInfo).port;
  const owner = hub.addKey("owner", "doc-owner");
  const workerKey = hub.addKey("worker", "doc-worker");
  writeFileSync(
    join(doctorHome, "config.json"),
    JSON.stringify({
      url: `http://127.0.0.1:${port}`,
      owner,
      worker: { name: "local", token: workerKey },
      hub: { listen: "127.0.0.1:0" },
    }),
  );

  const runDoctor = (agent: Record<string, unknown>, extraEnv: Record<string, string>) =>
    new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
      writeFileSync(doctorRules, JSON.stringify(baseRules(agent)));
      hub.reloadRules(doctorRules);
      execFile(
        process.execPath,
        ["--disable-warning=ExperimentalWarning", bin, "doctor"],
        {
          env: {
            ...process.env,
            AGENT_AUTOLOOP_HOME: doctorHome,
            AGENT_AUTOLOOP_RULES: doctorRules,
            AGENT_AUTOLOOP_SECRET_DOCTOR: "doctor-secret-value",
            ...extraEnv,
          },
          encoding: "utf8",
        },
        (err, stdout, stderr) => {
          const code = err && typeof (err as any).code === "number" ? (err as any).code : 0;
          resolve({ code, stdout: stdout ?? "", stderr: stderr ?? "" });
        },
      );
    });

  try {
    const emptyHome = join(doctorHome, "empty-home");
    mkdirSync(emptyHome, { recursive: true });

    // 1. Not installed anywhere. The inert SHELL keeps the worker's terminal-PATH lookup from
    //    finding a real agy this machine happens to have installed outside the test's empty home.
    const notInstalled = await runDoctor(
      { name: "Antigravity", worker: "local", use: "antigravity", access: "read" },
      { AGY_TEST_PROGRAM: "", HOME: emptyHome, SHELL: "/bin/false" },
    );
    assert.notEqual(notInstalled.code, 0);
    assert.match(notInstalled.stdout, /找不到 agy/);
    assert.doesNotMatch(notInstalled.stdout + notInstalled.stderr, /doctor-secret-value/);

    // 2. Fallback to ~/.local/bin/agy works when login shell returns nothing
    const localBin = join(emptyHome, ".local", "bin");
    mkdirSync(localBin, { recursive: true });
    const fallbackAgy = join(localBin, "agy");
    writeFileSync(
      fallbackAgy,
      `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(scriptFake)} "$@"\n`,
      {
        mode: 0o755,
      },
    );
    const fallbackOk = await runDoctor(
      { name: "Antigravity", worker: "local", use: "antigravity", access: "read" },
      { AGY_TEST_PROGRAM: "", HOME: emptyHome, SHELL: "/bin/false" },
    );
    assert.match(fallbackOk.stdout, /● Antigravity 可以用/);

    // 3. Explicit missing program
    const missingExplicit = await runDoctor(
      {
        name: "Antigravity",
        worker: "local",
        use: "antigravity",
        program: join(doctorHome, "no-such-agy"),
        access: "read",
      },
      { HOME: emptyHome },
    );
    assert.notEqual(missingExplicit.code, 0);
    assert.match(missingExplicit.stdout, /○ Antigravity/);

    // 4. Non-executable program
    const nonExec = join(doctorHome, "agy-noexec");
    writeFileSync(nonExec, "#!/bin/sh\nexit 0\n", { mode: 0o644 });
    chmodSync(nonExec, 0o644);
    const notExecRes = await runDoctor(
      { name: "Antigravity", worker: "local", use: "antigravity", program: nonExec, access: "read" },
      { HOME: emptyHome },
    );
    assert.notEqual(notExecRes.code, 0);
    assert.match(notExecRes.stdout, /○ Antigravity/);

    // 5. Outdated binary lacking --output-format / --conversation
    const oldRes = await runDoctor(
      { name: "Antigravity", worker: "local", use: "antigravity", program: defaultFake, access: "read" },
      { HOME: emptyHome, AGY_FAKE_OLD: "1" },
    );
    assert.notEqual(oldRes.code, 0);
    assert.match(oldRes.stdout, /○ Antigravity.*更新 agy/);

    // 6. Unauthenticated CLI (`agy models` exits 1 with two-line stderr)
    const unauthRes = await runDoctor(
      { name: "Antigravity", worker: "local", use: "antigravity", program: defaultFake, access: "read" },
      { HOME: emptyHome, AGY_FAKE_UNAUTH: "1" },
    );
    assert.notEqual(unauthRes.code, 0);
    assert.match(unauthRes.stdout, /○ Antigravity.*Please sign in/);
    assert.doesNotMatch(unauthRes.stdout + unauthRes.stderr, /doctor-secret-value/);

    // 7. Valid explicit program
    const okRes = await runDoctor(
      { name: "Antigravity", worker: "local", use: "antigravity", program: defaultFake, access: "read" },
      { HOME: emptyHome },
    );
    assert.match(okRes.stdout, /● Antigravity 可以用/);
  } finally {
    server.closeAllConnections();
    server.close();
    rmSync(doctorHome, { recursive: true, force: true });
  }
});
