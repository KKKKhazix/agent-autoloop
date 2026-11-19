// Built-in Antigravity adapter: runs `agy -p --output-format stream-json` directly as a headless CLI agent.
import { execFileSync, spawnSync } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import { commandLine } from "../../host/command.ts";
import { findProgram, tail, type Access, type Adapter, type Turn } from "../../worker/agents.ts";

const PERMISSIONS: Record<Access, string[]> = {
  read: ["--mode", "plan", "--sandbox"],
  edit: ["--mode", "accept-edits"],
  // Avoid `--mode auto` because accounts without it emit warnings and fall back; skip-permissions grants always-proceed directly.
  full: ["--dangerously-skip-permissions"],
};

const MISSING_CONVERSATION_RE = /^warning:\s*conversation\s+.+\s+not found$/im;

const inTheApp = () => [path.join(homedir(), ".local", "bin", process.platform === "win32" ? "agy.exe" : "agy")];

const pickStderrLine = (text?: string) => {
  const lines = (text ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  // `agy models` prints progress ("Fetching available models...") on line 1 before the actual `Error:` line.
  return lines.find((line) => /^error:/i.test(line)) ?? lines.at(-1);
};

export default {
  command: (turn: Turn) => [
    turn.program ?? findProgram("agy", inTheApp),
    ...(turn.resume ? ["--conversation", turn.resume] : []),
    "--output-format",
    "stream-json",
    ...(turn.model ? ["--model", turn.model] : []),
    ...(turn.effort ? ["--effort", turn.effort] : []),
    ...PERMISSIONS[turn.access],
    "--add-dir",
    turn.folder,
    "-p",
    turn.prompt,
  ],
  read(stdout, code, stderr, context) {
    let sawJson = false;
    let session: string | undefined;
    let sawStep = false;
    let result: any;
    for (const line of stdout.split("\n")) {
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (!msg || typeof msg !== "object" || Array.isArray(msg)) continue;
      sawJson = true;
      const cid = msg.conversation_id ?? msg.step_update?.conversation_id ?? msg.result?.conversation_id;
      if (typeof cid === "string" && cid) session = cid;
      if (msg.event === "step_update" && msg.step_update?.step_type) sawStep = true;
      if (msg.event === "result" && msg.result && typeof msg.result === "object") {
        result = msg.result;
      }
    }
    const resultExecuted = Boolean(result && ((result.num_turns ?? 0) > 0 || result.status === "SUCCESS"));
    const started = Boolean(sawStep || resultExecuted);
    const sessionUsage =
      resultExecuted && result.usage
        ? {
            input: result.usage.input_tokens ?? 0,
            output: result.usage.output_tokens ?? 0,
            cached: result.usage.cache_read_tokens ?? 0,
          }
        : undefined;
    const missingConversation = Boolean(
      (context?.resume && session && session !== context.resume) || MISSING_CONVERSATION_RE.test(stderr),
    );
    if (missingConversation) {
      // agy can execute in its replacement conversation before reporting the missing original.
      // Preserve that execution; a failed receipt would make the Hub run the business prompt again.
      if (context?.repair) {
        // The worker must discard this repair and retain the original business result.
        return code === null && !result
          ? { ...(started && { started }) }
          : { error: "Antigravity 找不到原会话，无法修复原回执", started, finished: true, usage: sessionUsage };
      }
      if (!started) {
        return code === null ? {} : { error: "Antigravity 找不到原会话，无法继续原会话", finished: true };
      }
      const actual = { ...(session && { session }), started: true, sessionUsage };
      if (code === null && !result) return actual;
      return {
        ...actual,
        finished: true,
        text:
          "待你处理：原会话无法续接，CLI已另起会话执行；自动重试已停止，业务结果需核对。\n\n" +
          "```agent-autoloop\n" +
          JSON.stringify({
            ask: [
              {
                title: "原会话恢复失败，请先核对已发生的操作",
                text: "CLI在替身会话中已接受或执行本轮任务。未采用替身业务回执，也不会自动重做。请先核对原始输出和当前文件/平台状态。",
                options: ["仅核对现有结果，不重做操作", "停止此事项"],
                recommend: 0,
                about: "原会话恢复受阻；仅核对本轮已经发生的操作，不重做、不扩大权限。未核实前不确认业务成功。",
                key: "antigravity-session-recovery",
              },
            ],
          }) +
          "\n```",
      };
    }
    const known = { ...(session && { session }), ...(started && { started }) };
    if (!result) {
      return code === null
        ? known
        : { ...known, error: tail(stderr || (sawJson ? "" : stdout)) || "Antigravity 没留下结果" };
    }
    const response = String(result.response ?? "");
    if (Array.isArray(result.denied_actions) && result.denied_actions.length > 0) {
      const actions = result.denied_actions
        .map((item: any) => item?.display_name || item?.action)
        .filter(Boolean)
        .join("、");
      return {
        ...known,
        sessionUsage,
        finished: true,
        error: actions ? `Antigravity 需要权限但未开启（${actions}）` : tail(stderr) || "Antigravity 需要权限但未完成",
      };
    }
    if (result.status !== "SUCCESS" || result.error || (code !== null && code !== 0)) {
      const fromError = typeof result.error === "string" ? result.error : result.error?.message;
      const error =
        fromError ||
        response.trim().split("\n")[0] ||
        tail(stderr) ||
        `Antigravity 没跑完这一轮（${String(result.status ?? code ?? "error")}）`;
      return { ...known, sessionUsage, finished: true, error };
    }
    if (!response.trim()) {
      return { ...known, sessionUsage, finished: true, error: tail(stderr) || "Antigravity 没有留下结果" };
    }
    return { text: response, ...known, sessionUsage, finished: true };
  },
  check(given) {
    try {
      const program = given ?? findProgram("agy", inTheApp);
      // `agy --help` writes usage flags to stderr on current Go CLI builds, so check both streams.
      const helpRun = spawnSync(...commandLine([program, "--help"]), {
        encoding: "utf8",
        timeout: 10_000,
        stdio: ["ignore", "pipe", "pipe"],
      });
      if (helpRun.error) throw helpRun.error;
      if (helpRun.status !== 0) {
        const detail = pickStderrLine(helpRun.stderr) || `exit ${String(helpRun.status)}`;
        return `Antigravity 没有登录或用不了：先运行 agy 登录（${detail}）`;
      }
      const help = `${helpRun.stdout ?? ""}\n${helpRun.stderr ?? ""}`;
      if (!help.includes("--output-format") || !help.includes("--conversation")) {
        return "Antigravity 版本过旧或不支持原生无头模式：先更新 agy";
      }
      execFileSync(...commandLine([program, "models"]), {
        encoding: "utf8",
        timeout: 20_000,
        stdio: ["ignore", "pipe", "pipe"],
      });
      return null;
    } catch (error) {
      const detail = pickStderrLine((error as { stderr?: string }).stderr) || (error as Error).message.split("\n")[0];
      return `Antigravity 没有登录或用不了：先运行 agy 登录（${detail}）`;
    }
  },
} satisfies Adapter;
