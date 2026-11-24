import { spawn, execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { readConfig } from "../../../host/config.ts";
import { runningUp } from "../../../host/service.ts";

const cli = resolve(import.meta.dirname, "../../../bin/agent-autoloop.ts");
const exec = promisify(execFile);
let child;
let lastOutput = "";
export const processStatus = () => ({ owned: Boolean(child), output: lastOutput });

export async function command(action) {
  if (action === "start") {
    readConfig();
    if (child || runningUp() !== null) throw new Error("本机已有运行中的 up 进程");
    lastOutput = "";
    const next = spawn(process.execPath, [cli, "up"], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    child = next;
    for (const pipe of [next.stdout, next.stderr]) {
      pipe.setEncoding("utf8");
      pipe.on("data", (chunk) => {
        lastOutput = (lastOutput + chunk).slice(-6000);
      });
    }
    next.once("close", () => {
      child = undefined;
    });
    await new Promise((resolve, reject) => {
      next.once("spawn", resolve);
      next.once("error", reject);
    });
    return { output: "已调用 up，连接状态以 Hub 响应为准。" };
  }
  if (action === "stop") {
    if (!child) throw new Error("只能停止本客户端启动的 up 进程");
    const next = child;
    await new Promise((resolve, reject) => {
      next.once("close", resolve);
      if (!next.kill()) reject(new Error("进程未能停止"));
    });
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

process.on("exit", () => child?.kill());
