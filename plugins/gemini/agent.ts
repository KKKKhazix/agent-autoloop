// Gemini CLI: Google's official command-line agent, installed and signed in by the user.
// Runs the official `gemini` program only.
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
    for (const line of stdout.split("\n").reverse()) {
      let result: any;
      try {
        result = JSON.parse(line);
      } catch {
        continue;
      }
      if (result?.type !== "result") continue;
      const usage = result.usage
        ? {
            input: result.usage.input_token_count ?? 0,
            output: result.usage.output_token_count ?? 0,
            cost: result.usage.total_cost_usd ?? 0,
          }
        : undefined;
      const said = String(result.result ?? "");
      if (result.is_error || result.subtype !== "success") {
        const error = said.split("\n")[0] || result.subtype || "没留下结果";
        return { session: result.session_id, usage, finished: true, error };
      }
      return { text: said, session: result.session_id, usage, finished: true };
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
