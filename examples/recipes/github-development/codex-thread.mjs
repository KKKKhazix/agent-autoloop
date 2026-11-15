// Create a named desktop thread before running the model through the isolated CLI.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;

export async function createCodexThread(program, cwd, env, name) {
  const child = spawn(program, ["app-server", "-c", "mcp_servers={}", "--disable", "plugins", "--disable", "hooks"], {
    cwd,
    env,
    stdio: ["pipe", "pipe", "ignore"],
  });
  const lines = createInterface({ input: child.stdout });
  const stop = () => lines.close();
  const timer = setTimeout(stop, 15_000);
  child.once("error", stop);
  child.stdin.on("error", stop);
  const send = (method, params, id) => child.stdin.write(JSON.stringify({ method, params, ...(id && { id }) }) + "\n");
  let threadId;
  try {
    send("initialize", { clientInfo: { name: "agent-autoloop", version: "1" } }, 1);
    for await (const line of lines) {
      const reply = JSON.parse(line);
      if (reply.id && reply.error) break;
      if (reply.id === 1) {
        send("initialized", {});
        send("thread/start", { cwd, sandbox: "read-only", approvalPolicy: "never", ephemeral: false }, 2);
      } else if (reply.id === 2) {
        threadId = reply.result?.thread?.id;
        if (!uuid.test(threadId ?? "")) break;
        send("thread/name/set", { threadId, name }, 3);
      } else if (reply.id === 3 && threadId) {
        return threadId;
      }
    }
    throw new Error("Codex 会话未创建");
  } finally {
    clearTimeout(timer);
    lines.close();
    child.stdin.end();
    child.kill();
  }
}
