// The native process this console started, and nothing else: stopping reaches only the child it owns, so a hub run by the
// login service, another checkout's hub, or a turn already running is left alone.
import { spawn, execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { readConfig } from "../../../host/config.ts";
import { runningUp } from "../../../host/service.ts";

const cli = resolve(import.meta.dirname, "../../../bin/agent-autoloop.ts");
const exec = promisify(execFile);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let child;
let lastOutput = "";
export const processStatus = () => ({ owned: Boolean(child), output: lastOutput });

export async function hubHealthy(url) {
  try {
    const response = await fetch(`${url.replace(/\/$/, "")}/healthz`, {
      signal: AbortSignal.timeout(1500),
      redirect: "error",
    });
    if (!response.ok) return false;
    const body = await response.json().catch(() => null);
    return body?.ok === true;
  } catch {
    return false;
  }
}

function startHub() {
  if (child) return child;
  const next = spawn(process.execPath, [cli, "up"], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  child = next;
  lastOutput = "";
  for (const pipe of [next.stdout, next.stderr]) {
    pipe.setEncoding("utf8");
    pipe.on("data", (chunk) => {
      lastOutput = (lastOutput + chunk).slice(-6000);
    });
  }
  next.once("error", (error) => {
    lastOutput = `${lastOutput}\n无法启动 up：${error.message}`.slice(-6000);
  });
  next.once("close", () => {
    if (child === next) child = undefined;
  });
  return next;
}

async function launchHub() {
  const next = startHub();
  await new Promise((resolve, reject) => {
    if (next.exitCode !== null) return reject(new Error(lastOutput.trim() || "原生 up 进程立即退出了"));
    next.once("spawn", resolve);
    next.once("error", reject);
  });
  return next;
}

/**
 * Connect to a hub that already answers, otherwise start the native up process (hub, worker and channels from
 * config.json) and wait until it answers. A hub started by the login service is waited for, never started twice.
 */
export async function ensureHub({ log = () => {}, timeout = 45_000 } = {}) {
  const config = readConfig();
  let url;
  try {
    url = new URL(config.url).toString();
  } catch {
    throw new Error(`config.json 里的 url 不是有效地址：${config.url}`);
  }
  if (await hubHealthy(url)) {
    log(`Hub 已在运行，直接连接：${url}`);
    return { started: false, url };
  }
  if (!config.hub && !config.worker) {
    throw new Error("config.json 里既没有 hub 也没有 worker，无法启动任何原生进程。请先运行 agent-autoloop init。");
  }
  const running = runningUp();
  let launched = false;
  if (running !== null) {
    log(`检测到 Hub 正在启动（进程 ${running}），等待健康检查…`);
  } else {
    log("没有检测到运行中的 Hub，正在通过原生 CLI 启动 Hub 和 Worker…");
    await launchHub();
    launched = true;
  }
  const end = Date.now() + timeout;
  for (;;) {
    if (await hubHealthy(url)) {
      log("Hub 健康检查通过。");
      return { started: launched, url };
    }
    // up exits when another process already holds the install: that one is still starting, so wait for it instead.
    if (launched && !child) {
      if (runningUp() !== null) {
        launched = false;
      } else {
        await wait(500);
        if (await hubHealthy(url)) continue;
        break;
      }
    }
    if (Date.now() > end) break;
    await wait(300);
  }
  const output = lastOutput.trim();
  throw new Error(
    `Hub 未能通过健康检查（${url}）。` +
      (output ? `\n\n原生进程输出：\n${output}` : "") +
      "\n\n请运行 node bin/agent-autoloop.ts doctor 查看原因，或检查 config.json 里的 url 和 hub.listen。",
  );
}

export async function command(action) {
  if (action === "start") {
    readConfig();
    if (child || runningUp() !== null) throw new Error("本机已有运行中的 up 进程");
    lastOutput = "";
    await launchHub();
    return { output: "已调用 up，连接状态以 Hub 响应为准。" };
  }
  if (action === "stop") {
    if (!(await stopHub())) throw new Error("只能停止本客户端启动的 up 进程");
    return { output: "已停止本客户端启动的 up 进程。" };
  }
  if (!["doctor", "update"].includes(action)) throw new Error("未知的 CLI 操作");
  try {
    const { stdout, stderr } = await exec(process.execPath, [cli, action], { windowsHide: true, maxBuffer: 2 ** 20 });
    return { output: (stdout + stderr).trim() };
  } catch (e) {
    const output = [e.stdout, e.stderr].filter(Boolean).join("\n").trim();
    if (action === "doctor" && output) return { output: "诊断发现问题（退出码 " + e.code + "）\n" + output };
    throw new Error(output || e.message);
  }
}

/** Stops only the up process this console started; false when there is none. */
export async function stopHub() {
  const next = child;
  if (!next) return false;
  await new Promise((resolve) => {
    const done = setTimeout(resolve, 5000);
    next.once("close", () => {
      clearTimeout(done);
      resolve();
    });
    try {
      next.kill();
    } catch {
      clearTimeout(done);
      resolve();
    }
  });
  return true;
}

process.on("exit", () => child?.kill());
