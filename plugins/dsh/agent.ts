// DSH (DeepSeek Harness): `dsh headless` answers one task and exits. With --json it prints one projected event per line —
// the opening `session` carries the id a later turn goes on in, `step_end` carries the run's usage, `turn_end` says why
// the turn ended and the terminal `final` carries the answer. Sessions are persisted, so a retry or an answer goes on in
// the same one with --session-id. The sandbox mode comes from DSH_PERMISSION_MODE, so this passes the turn's access
// through the environment. It has no desktop session to open.
import { execFileSync } from "node:child_process";
import { findProgram, tail, type Adapter, type Reading, type Usage } from "../../worker/agents.ts";

const SANDBOX = { read: "read-only", edit: "workspace-write", full: "danger-full-access" };
const INSTALLED_AT = () => [`${process.env.HOME ?? ""}/.local/bin/dsh`];

/** dsh reports each step's tokens as inputTokens / outputTokens / cacheReadTokens. */
function stepUsage(reported: any): Usage | undefined {
  if (!reported || typeof reported !== "object") return undefined;
  const step: Usage = {};
  if (typeof reported.inputTokens === "number") step.input = reported.inputTokens;
  if (typeof reported.outputTokens === "number") step.output = reported.outputTokens;
  if (typeof reported.cacheReadTokens === "number") step.cached = reported.cacheReadTokens;
  return Object.keys(step).length ? step : undefined;
}

/** A run makes several steps, and their token counts together are what it used. */
function addUsage(total: Usage | undefined, step: Usage | undefined): Usage | undefined {
  if (!step) return total;
  const sum: Usage = { ...total };
  for (const field of ["input", "output", "cached"] as const) {
    const value = step[field];
    if (value !== undefined) sum[field] = (sum[field] ?? 0) + value;
  }
  return sum;
}

export default {
  command: (turn) => [
    "/usr/bin/env",
    `DSH_PERMISSION_MODE=${SANDBOX[turn.access]}`,
    findProgram("dsh", INSTALLED_AT),
    "headless",
    "--json",
    ...(turn.resume ? ["--session-id", turn.resume] : []),
    turn.prompt,
  ],
  read(stdout, code, stderr) {
    let session: string | undefined;
    let end: { kind?: string; error?: { message?: string } } | undefined;
    let text: string | undefined;
    let usage: Usage | undefined;
    for (const line of stdout.split("\n")) {
      let event: any;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      // A login shell's profile prints here too, and `null` is valid JSON.
      if (!event || typeof event !== "object") continue;
      if (event.type === "session" && typeof event.sessionId === "string") session = event.sessionId;
      else if (event.type === "status" && event.phase === "step_end") usage = addUsage(usage, stepUsage(event.usage));
      else if (event.type === "status" && event.phase === "turn_end") end = event.reason ?? { kind: "completed" };
      else if (event.type === "final" && typeof event.text === "string") text = event.text;
    }
    const reading: Reading = { ...(session && { session }), ...(usage && { usage }) };
    // It has this turn's prompt in a Session that's there. From here on the work may be half done, so a later turn goes
    // on in the same Session instead of starting over.
    if (session) reading.started = true;
    if (end) {
      reading.finished = true;
      // Only a finished turn's last message is its answer; before that it's only as far as it had got.
      if (end.kind === "completed") {
        if (text?.trim()) reading.text = text;
        else reading.error = "DSH 没有完成并留下实际结果";
      } else if (end.kind === "error") reading.error = end.error?.message || "DSH 没跑完这一轮";
      else if (end.kind === "aborted") reading.error = "这一轮被中止了";
      else if (end.kind === "blocked") reading.error = "这一轮被卡住了，没有完成";
      else if (end.kind === "max-tokens") reading.error = "这一轮用完了输出上限";
      else reading.error = "DSH 没跑完这一轮";
    } else if (code !== null) {
      if (code !== 0) reading.error = `退出码 ${code}：${tail(stderr) || "没留下原因"}`;
      else reading.error = tail(stderr) || "DSH 没有完成并留下实际结果";
    }
    return reading;
  },
  check() {
    try {
      execFileSync(findProgram("dsh", INSTALLED_AT), ["--version"], {
        encoding: "utf8",
        timeout: 20_000,
        stdio: ["ignore", "pipe", "pipe"],
      });
      return null;
    } catch (error) {
      return `DSH 用不了：运行 dsh headless "hi" 看看（${(error as Error).message.split("\n")[0]}）`;
    }
  },
} satisfies Adapter;
