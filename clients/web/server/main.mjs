import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { hubClient } from "../../../protocol/client.ts";
import { readConfig } from "../../../host/config.ts";
import { readRuns } from "../../../cli/runs.ts";
import { formatWhy } from "../../../cli/why.ts";
import { checkRules, localSettings, ruleFile, saveConnection, saveRules, saveWorker } from "./settings.mjs";
import { deliveryView } from "./delivery.mjs";
import { command, ensureHub, processStatus, stopHub } from "./process.mjs";
import { openBrowser } from "./browser.mjs";
import { clearRuntime, runningClient, writeRuntime } from "./runtime.mjs";

const launching = process.argv.includes("--launch");
const port = Number(process.env.AGENT_AUTOLOOP_WEB_PORT ?? 4317);
const session = randomBytes(32).toString("hex");
const dist = resolve(import.meta.dirname, "../dist");
const fail = (status, message) => {
  throw Object.assign(new Error(message), { status });
};
const json = (res, value) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(value));
};

async function bodyOf(req) {
  if (req.headers["content-type"]?.split(";")[0] !== "application/json") fail(415, "需要 JSON 请求");
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 2 ** 21) fail(413, "配置超过 2 MiB");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString());
}

async function api(req, res, path, query) {
  const post = req.method === "POST";
  const body = post ? await bodyOf(req) : {};
  if (!post && path === "/local") return localSettings();
  if (!post && path === "/process") return processStatus();
  if (post && path === "/shutdown") {
    const hubOwned = processStatus().owned;
    setTimeout(shutdown, 50);
    return { ok: true, hubOwned };
  }
  if (post && path.startsWith("/cli/")) return command(path.slice(5));
  if (post && path === "/connection") return saveConnection(body);
  if (post && path === "/worker") return saveWorker(body);
  const config = readConfig();
  if (!post && path === "/health") {
    const response = await fetch(config.url.replace(/\/$/, "") + "/healthz", { signal: AbortSignal.timeout(4000) });
    if (!response.ok) fail(response.status, "Hub 健康检查失败");
    return response.json();
  }
  if (path === "/rules" || path === "/rules/check") {
    if (!config.hub) fail(403, "请在保存中台规则的 Hub 主机上编辑");
    if (!post && path === "/rules") return ruleFile();
    if (post && path === "/rules/check") {
      checkRules(body.text);
      return { ok: true };
    }
    if (post) return saveRules(body);
  }
  if (!config.owner) fail(403, "本机没有本人密钥，请在 Hub 主机上打开客户端");
  if (!post && path === "/delivery" && config.hub) return deliveryView(query);
  const hub = hubClient(config.url, config.owner);
  if (!post && path === "/state") return hub.state();
  if (!post && path === "/history") {
    const before = query.has("before") ? Number(query.get("before")) : undefined;
    const found = await readRuns(hub, query.get("rule") || undefined, before);
    return { runs: found.runs, nextBefore: found.more };
  }
  if (!post && path === "/stream") {
    const after = req.headers["last-event-id"] || query.get("after") || "0";
    if (!/^\d+$/.test(after)) fail(400, "日志序号无效");
    const controller = new AbortController();
    res.once("close", () => controller.abort());
    const upstream = await fetch(config.url.replace(/\/$/, "") + "/v1/stream?after=" + after, {
      headers: { Authorization: "Bearer " + config.owner },
      signal: controller.signal,
      redirect: "error",
    });
    if (!upstream.ok) fail(upstream.status, "事件流连接失败");
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store" });
    res.flushHeaders();
    await pipeline(Readable.fromWeb(upstream.body), res, { signal: controller.signal });
    return;
  }
  const run = /^\/runs\/(\d+)\/(why|cancel)$/.exec(path);
  if (run) {
    const id = Number(run[1]);
    if (post && run[2] === "cancel") return hub.cancel(id);
    if (!post && run[2] === "why") {
      const facts = await hub.why(id);
      return { facts, timeline: formatWhy(id, facts) };
    }
  }
  const card = /^\/cards\/(\d+)\/(answer|resolve)$/.exec(path);
  if (post && card)
    return card[2] === "answer" ? hub.answer(Number(card[1]), body) : hub.resolve(Number(card[1]), body.reason);
  const rule = /^\/rules\/([^/]+)\/(run|pause|resume|replay)$/.exec(path);
  if (post && rule) return hub[rule[2]](decodeURIComponent(rule[1]), body);
  fail(404, "没有此接口");
}

const server = createServer(async (req, res) => {
  try {
    const host = "127.0.0.1:" + server.address().port;
    if (
      req.headers.host !== host ||
      req.headers["sec-fetch-site"] === "cross-site" ||
      (req.headers.origin && req.headers.origin !== "http://" + host)
    )
      fail(403, "只允许本机控制台访问");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    const url = new URL(req.url, "http://" + host);
    const path = url.pathname;
    if (path.startsWith("/api/")) {
      const key = path === "/api/stream" ? url.searchParams.get("session") : req.headers["x-autoloop-session"];
      if (key !== session) fail(401, "请使用本次启动窗口中的完整链接打开控制台。");
      if (!["GET", "POST"].includes(req.method)) fail(405, "请求方法无效");
      if (req.method === "POST" && req.headers.origin !== "http://" + host) fail(403, "操作必须来自本机控制台");
      const data = await api(req, res, path.slice(4), url.searchParams);
      if (!res.headersSent && !res.destroyed) json(res, data);
      return;
    }
    if (req.method !== "GET" || (path !== "/" && !/^\/assets\/[\w.-]+\.(js|css)$/.test(path))) fail(404, "页面不存在");
    const file = resolve(dist, path === "/" ? "index.html" : path.slice(1));
    const content = await readFile(file);
    res.setHeader(
      "Content-Type",
      { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript" }[extname(file)],
    );
    res.end(content);
  } catch (e) {
    if (res.destroyed || res.headersSent) return;
    res.statusCode = e.status ?? (e.code === "ENOENT" ? 404 : 400);
    json(res, { error: e.message === "fetch failed" ? "无法连接 Hub，请检查系统设置中的地址和进程。" : e.message });
  }
});
function shutdown() {
  stopHub().finally(() => {
    clearRuntime(process.pid);
    server.close();
    process.exit(0);
  });
}

async function listen() {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  const address = server.address();
  const url = "http://127.0.0.1:" + address.port + "/#connect=" + session;
  writeRuntime({ pid: process.pid, url, session, startedAt: new Date().toISOString() });
  console.log("Agent Autoloop 本地控制台  " + url);
  if (launching || process.argv.includes("--open")) openBrowser(url);
}

async function start() {
  if (launching) {
    try {
      await ensureHub({ log: (line) => console.log(line) });
    } catch (error) {
      console.error("启动失败：" + error.message);
      process.exit(1);
    }
  }
  try {
    await listen();
  } catch (error) {
    if (error.code === "EADDRINUSE") {
      const running = await runningClient();
      if (running) {
        console.log("本地控制台已经在运行：" + running.url);
        openBrowser(running.url);
        process.exit(0);
      }
      console.error(
        `启动失败：端口 ${port} 已被其他程序占用。` +
          "请关闭占用该端口的程序，或设置环境变量 AGENT_AUTOLOOP_WEB_PORT 换一个端口后重试。",
      );
    } else {
      console.error("启动失败：" + error.message);
    }
    process.exit(1);
  }
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.once(signal, shutdown);
if (process.platform === "win32") process.once("SIGBREAK", shutdown);
start();
