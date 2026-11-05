// What's different about DSH. Failure cases: a level of access maps to the wrong permission mode, a resumed turn starts a
// new session, a turn that's still going is taken for an answer or a failure, a turn that ended in an error or without an
// answer is taken for a result, the token counts of a run's several steps are dropped, and a program that's missing or
// broken doesn't say what to do. The program is looked up through the login shell, so this points the shell and HOME at
// this test's own instead of whatever this machine has installed.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

type Adapter = import("../worker/agents.ts").Adapter;

const scratch = mkdtempSync(join(tmpdir(), "agent-autoloop-dsh-"));
const usual = { SHELL: process.env.SHELL, HOME: process.env.HOME };
const program = join(scratch, "dsh");
const shell = join(scratch, "shell");
writeFileSync(
  program,
  `#!/bin/sh
[ "\${DSH_TEST_USABLE:-}" = 1 ] || { echo "dsh: cannot run" >&2; exit 1; }
echo 0.2.0
`,
  { mode: 0o755 },
);
// What a login shell prints for `command -v dsh`; an empty DSH_TEST_PROGRAM stands in for dsh not being there.
writeFileSync(shell, '#!/bin/sh\nprintf "%s\\n" "$DSH_TEST_PROGRAM"\n', { mode: 0o755 });
process.env.SHELL = shell;
process.env.HOME = scratch;
process.env.DSH_TEST_PROGRAM = program;
after(() => {
  rmSync(scratch, { recursive: true, force: true });
  for (const [name, value] of Object.entries(usual)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  delete process.env.DSH_TEST_PROGRAM;
});
const dsh: Adapter = (await import("../plugins/dsh/agent.ts")).default;
const check = dsh.check!;

const turn = {
  prompt: "做这件事",
  session: "new-id",
  resume: null,
  cwd: "/x",
  access: "edit" as const,
  contextFile: "/ctx.json",
  folder: "/run",
};

test("DSH: access is the permission mode, and a resumed turn goes on in its session", () => {
  const argv = dsh.command(turn);
  assert.equal(argv[0], "/usr/bin/env");
  assert.equal(argv[1], "DSH_PERMISSION_MODE=workspace-write");
  assert.equal(argv[2], program);
  assert.deepEqual(argv.slice(3, 5), ["headless", "--json"]);
  assert.deepEqual(argv.slice(5), ["做这件事"], "a new session takes no id: dsh makes its own and reports it");
  for (const [access, mode] of [
    ["read", "read-only"],
    ["edit", "workspace-write"],
    ["full", "danger-full-access"],
  ] as const) {
    assert.equal(dsh.command({ ...turn, access })[1], `DSH_PERMISSION_MODE=${mode}`);
  }
  const again = dsh.command({ ...turn, resume: "session-1" });
  assert.deepEqual(again.slice(5), ["--session-id", "session-1", "做这件事"]);
});

const lines = (...events: object[]) => events.map((event) => JSON.stringify(event)).join("\n");
const opened = { type: "session", sessionId: "session-1", cwd: "/x" };
const step = (usage: object) => ({ type: "status", phase: "step_end", usage });
const ended = (reason: object) => ({ type: "status", phase: "turn_end", reason });
const final = (text: string) => ({ type: "final", text });

test("DSH: a completed turn's final text is its answer, with every step's tokens added up", () => {
  const reading = dsh.read(
    lines(
      opened,
      { type: "thinking", text: "想一想" },
      { type: "status", phase: "step_start" },
      step({ inputTokens: 7500, outputTokens: 2, cacheReadTokens: 5120, cacheWriteTokens: 0, totalTokens: 12622 }),
      { type: "text", text: "中途" },
      { type: "tool_call", name: "read" },
      { type: "tool_result", text: "资料" },
      step({ inputTokens: 10, outputTokens: 4, cacheReadTokens: 1 }),
      final("好了"),
      ended({ kind: "completed" }),
    ),
    0,
    "",
  );
  assert.deepEqual(reading, {
    session: "session-1",
    usage: { input: 7510, output: 6, cached: 5121 },
    started: true,
    finished: true,
    text: "好了",
  });
});

test("DSH: a turn that's still going has no answer and no error", () => {
  const reading = dsh.read(
    lines(opened, step({ inputTokens: 7, outputTokens: 1, cacheReadTokens: 2 }), { type: "text", text: "中途" }),
    null,
    "",
  );
  assert.equal(reading.text, undefined, "what it said so far isn't its answer");
  assert.equal(reading.error, undefined, "still going isn't a failure");
  assert.deepEqual(reading, {
    session: "session-1",
    usage: { input: 7, output: 1, cached: 2 },
    started: true,
  });
  // The terminal event alone doesn't say the turn completed; turn_end does.
  const unfinished = dsh.read(lines(opened, final("好了")), 0, "");
  assert.equal(unfinished.text, undefined);
  assert.equal(unfinished.error, "DSH 没有完成并留下实际结果");
});

test("DSH: why the turn ended is the reason it failed", () => {
  for (const [reason, error] of [
    [{ kind: "error", error: { message: "额度用完了" } }, "额度用完了"],
    [{ kind: "error" }, "DSH 没跑完这一轮"],
    [{ kind: "aborted" }, "这一轮被中止了"],
    [{ kind: "blocked" }, "这一轮被卡住了，没有完成"],
    [{ kind: "max-tokens" }, "这一轮用完了输出上限"],
    [{ kind: "interrupted" }, "DSH 没跑完这一轮"],
  ] as const) {
    assert.deepEqual(dsh.read(lines(opened, final("好了"), ended(reason)), 1, ""), {
      session: "session-1",
      started: true,
      finished: true,
      error,
    });
  }
  const empty = dsh.read(lines(opened, final("  "), ended({ kind: "completed" })), 0, "");
  assert.equal(empty.finished, true);
  assert.equal(empty.text, undefined, "a blank message isn't an answer");
  assert.equal(empty.error, "DSH 没有完成并留下实际结果");
});

test("DSH: a turn that ended without saying why falls back to its exit", () => {
  assert.equal(dsh.read("", 3, "cannot start").error, "退出码 3：cannot start");
  assert.equal(dsh.read("", 3, "").error, "退出码 3：没留下原因");
  assert.equal(dsh.read("", 0, "boom").error, "boom");
  assert.equal(dsh.read("", 0, "").error, "DSH 没有完成并留下实际结果");
  assert.deepEqual(dsh.read("", null, "still starting"), {}, "running, so nothing to report yet");
});

test("DSH: a line of output that's JSON but no event is noise", () => {
  const noise = 'null\n42\n"words"\n[]\n';
  assert.doesNotThrow(() => dsh.read(noise, null, ""));
  assert.doesNotThrow(() => dsh.read(noise, 0, ""));
});

test("DSH: check passes when the program runs, and says what to do when it doesn't", () => {
  assert.match(check()!, /^DSH 用不了：运行 dsh headless "hi" 看看（/);
  process.env.DSH_TEST_USABLE = "1";
  try {
    assert.equal(check(), null);
  } finally {
    delete process.env.DSH_TEST_USABLE;
  }
});

test("DSH: check says what to do when dsh isn't installed", () => {
  const empty = join(scratch, "empty");
  const script = `const { default: dsh } = await import(${JSON.stringify(
    new URL("../plugins/dsh/agent.ts", import.meta.url).href,
  )}); process.stdout.write(String(dsh.check()));`;
  // A separate process: the program is looked up once per process, and this one has already found the stub.
  const checked = spawnSync(
    process.execPath,
    ["--disable-warning=ExperimentalWarning", "--input-type=module", "-e", script],
    {
      env: { ...process.env, HOME: empty, DSH_TEST_PROGRAM: "" },
      encoding: "utf8",
    },
  );
  assert.equal(checked.status, 0, checked.stderr);
  assert.match(checked.stdout, /^DSH 用不了：.*找不到 dsh/);
});
