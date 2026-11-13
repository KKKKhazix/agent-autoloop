// Browser fixture: isolated real hub, no agent process or external messages.
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const home = mkdtempSync(join(tmpdir(), "autoloop-browser-"));
process.env.AGENT_AUTOLOOP_HOME = home;
process.env.AGENT_AUTOLOOP_RULES = join(home, "rules.json");
writeFileSync(
  process.env.AGENT_AUTOLOOP_RULES,
  JSON.stringify({
    timezone: "Asia/Shanghai",
    sources: { demo: { name: "演示来源" } },
    agents: { assistant: { name: "测试助手", worker: "browser-worker", use: "command", command: ["echo"] } },
    channels: {},
    rules: [
      {
        name: "跟进反馈",
        when: { source: "demo", types: ["feedback.*"] },
        to: "assistant",
        cwd: "~/fixture",
        prompt: "Handle this fixture",
        parallel: 2,
      },
    ],
  }),
);
const { serve } = await import("../../host/http.ts");
const hub = await import("../../host/runtime.ts");
const owner = hub.addKey("owner", "browser-owner"),
  source = hub.addKey("source", "demo"),
  worker = hub.addKey("worker", "browser-worker");
const server = serve(0);
await new Promise<void>((resolve) => server.once("listening", resolve));
const port = (server.address() as { port: number }).port;
const url = "http://127.0.0.1:" + port;
async function call(path: string, key: string, body?: unknown) {
  const r = await fetch(url + path, {
    method: body ? "POST" : "GET",
    headers: { authorization: "Bearer " + key, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}
for (const [id, subject, summary] of [
  ["browser-ask", "#42", "需要确认的客户反馈"],
  ["browser-run", "#43", "正在处理的巡检任务"],
]) {
  await call("/v1/events", source, { id, type: "feedback.new", subject, summary });
  const { job } = await call("/v1/work?claim=" + id + "&wait=0", worker);
  if (id === "browser-ask")
    await call("/v1/runs/" + job.run + "/result", job.token, {
      outcome: "done",
      summary: "已完成分析，等待你的判断",
      ask: [
        {
          title: "是否继续修复？",
          text: "测试资料：<script>window.fixtureXss=true</script>",
          options: ["继续修复", "暂不处理"],
          key: "decision",
        },
      ],
      notice: [{ title: "巡检发现需要处理的情况", text: "核对后可以结案", key: "notice" }],
    });
}
console.log(JSON.stringify({ url, owner, source, worker, home }));
let closing = false;
function close() {
  if (closing) return;
  closing = true;
  server.closeAllConnections();
  server.close(() => {
    hub.db.close();
    rmSync(home, { recursive: true, force: true });
    process.exit(0);
  });
}
process.on("SIGINT", close);
process.on("SIGTERM", close);
