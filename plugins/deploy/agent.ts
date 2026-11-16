// The deploy as an agent: its process is run.ts, and what it prints is read the way any plain command's output is.
import { join } from "node:path";
import { stablePath } from "../../host/node-path.ts";
import type { Adapter } from "../../worker/agents.ts";

const tail = (text: string, length = 300) => text.trim().slice(-length);

export default {
  command: () => [
    stablePath(process.execPath),
    "--disable-warning=ExperimentalWarning",
    join(import.meta.dirname, "run.ts"),
  ],
  read(stdout, code, stderr) {
    if (code === null) return {};
    if (code !== 0) return { error: `退出码 ${code}：${tail(stderr || stdout) || "没留下原因"}` };
    return { text: stdout };
  },
} satisfies Adapter;
