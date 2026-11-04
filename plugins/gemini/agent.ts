// Gemini CLI: Google's official command-line agent, installed and signed in by the user.
// Runs the official `gemini` program only.
// Output format: --output-format json returns {response, stats, error}, not {type: "result"}.
import { execFileSync } from "node:child_process";
import { findProgram, tail, type Adapter } from "../../worker/agents.ts";

export default {
  command: (turn) => [
    findProgram("gemini"),
    "--prompt",
    turn.prompt,
    ...(turn.resume ? ["--resume", turn.resume] : []),
    ...(turn.model ? ["--model", turn.model] : []),
    "--output-format",
    "json",
  ],
  read(stdout, code, stderr) {
    // Gemini CLI writes one JSON object per line: {response, stats, error}
    for (const line of stdout.split("\n").reverse()) {
      let result: any;
      try {
        result = JSON.parse(line);
      } catch {
        continue;
      }
      if (result?.error) {
        return { session: result.session_id, usage: result.stats?.usage, finished: true, error: String(result.error) };
      }
      if (result?.response) {
        const usage = result.stats?.usage
          ? {
              input: result.stats.usage.input_token_count ?? 0,
              output: result.stats.usage.output_token_count ?? 0,
              cost: result.stats.usage.total_cost_usd ?? 0,
            }
          : undefined;
        return { text: String(result.response), session: result.session_id, usage, finished: true };
      }
    }
    return code === null ? {} : { error: tail(stderr || stdout) || "没留下结果" };
  },
  link: (session) => `gemini://resume?session=${session}`,
  check() {
    try {
      const program = findProgram("gemini");
      const status = execFileSync(program, ["auth", "status"], { encoding: "utf8", timeout: 20_000 });
      return status.includes("signed in") ? null : "Gemini CLI 没有登录：运行 gemini auth login";
    } catch (error) {
      return `Gemini CLI 用不了：${(error as Error).message.split("\n")[0]}`;
    }
  },
} satisfies Adapter;
