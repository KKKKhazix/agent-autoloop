// Closing the console this install started. The request carries the session so another program on the port cannot be
// shut down by guessing, and the hub is only stopped when this console started it.
import { readRuntime, clearRuntime } from "./runtime.mjs";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  if (Number(process.versions.node.split(".")[0]) < 24) {
    console.error(`需要 Node.js 24 或更高版本，当前是 ${process.versions.node}。`);
    process.exitCode = 1;
    return;
  }
  const value = readRuntime();
  if (!value) {
    console.log("当前没有正在运行的本地控制台。");
    return;
  }
  let url;
  try {
    url = new URL(value.url);
  } catch {
    clearRuntime(value.pid);
    console.log("本地控制台的记录已损坏，已清理。当前没有正在运行的控制台。");
    return;
  }
  let data;
  try {
    const response = await fetch(new URL("/api/shutdown", url), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: url.origin,
        "x-autoloop-session": value.session,
      },
      body: "{}",
      signal: AbortSignal.timeout(5000),
    });
    data = await response.json().catch(() => ({}));
    if (!response.ok) {
      console.error(`停止失败：${data.error ?? `控制台返回 ${response.status}`}`);
      console.error("当前运行的可能是旧版本控制台。请关闭它的窗口后重新双击 start.cmd。");
      process.exitCode = 1;
      return;
    }
  } catch {
    clearRuntime(value.pid);
    console.log("本地控制台没有在运行（可能上次异常退出），已清理残留记录。");
    return;
  }
  for (let i = 0; i < 50 && readRuntime(); i++) await wait(100);
  console.log("已停止本地控制台。");
  if (data.hubOwned)
    console.log("本次启动的中台和接单进程也已停止；已经接下的任务会自己跑完，不受影响。");
  else console.log("中台和接单进程不是本次启动的，继续保持运行。");
}

main().catch((error) => {
  console.error(`停止失败：${error.message}`);
  process.exitCode = 1;
});
