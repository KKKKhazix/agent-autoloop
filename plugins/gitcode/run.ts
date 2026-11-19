import { readFileSync } from "node:fs";
import { parseConfig, runCollector } from "./collector.ts";
import { record } from "./input.ts";

function credential(path = "") {
  try {
    const token = readFileSync(path, "utf8").trim();
    return /^[\x21-\x7e]{1,4096}$/.test(token) ? token : "";
  } catch {
    return "";
  }
}

function launch(): {
  mode: "schedule" | "collect";
  configPath: string;
  tokenPath?: string;
  run: string;
  context?: string;
} {
  const [mode, configPath = "", tokenPath] = process.argv.slice(2);
  const { AGENT_AUTOLOOP_RUN = "", AGENT_AUTOLOOP_CONTEXT } = process.env;
  if (mode !== "schedule" && mode !== "collect") throw new Error("参数无效");
  return { mode, configPath, tokenPath, run: AGENT_AUTOLOOP_RUN, context: AGENT_AUTOLOOP_CONTEXT };
}

function readEvents(path: string | undefined) {
  if (!path) throw new Error("轮次资料路径无效");
  const input = record(JSON.parse(readFileSync(path, "utf8"))).events;
  if (!Array.isArray(input)) throw new Error("轮次资料无效");
  return input;
}

async function main() {
  const { mode, configPath, context, tokenPath, run } = launch();
  const config = parseConfig(JSON.parse(readFileSync(configPath, "utf8")));
  const input = mode === "collect" ? readEvents(context) : [];
  const token = mode === "collect" ? credential(tokenPath) : "";
  const events = await runCollector(mode, config, input, run, { token });
  const summary = mode === "schedule" ? "已提交 GitCode 采集请求" : "已记录 GitCode 采集结果";
  console.log(`${summary}\n\n\`\`\`agent-autoloop\n${JSON.stringify({ events })}\n\`\`\``);
}

main().catch(() => {
  console.error("GitCode 插件未能读取配置或轮次资料，请检查工作机的文件与命令参数。");
  process.exitCode = 1;
});
