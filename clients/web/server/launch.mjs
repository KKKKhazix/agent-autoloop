// The double-click entry: reuse a console that is already up, install or build only when their inputs changed, make sure
// this machine has a native configuration, then hand over to main.mjs. main.mjs waits for the hub before serving the page.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { readConfig } from "../../../host/config.ts";
import { openBrowser } from "./browser.mjs";
import { runningClient } from "./runtime.mjs";

const web = resolve(import.meta.dirname, "..");
const root = resolve(web, "../..");
const cli = resolve(root, "bin", "agent-autoloop.ts");
const installMarker = join(web, "node_modules", ".agent-autoloop-web.json");
const buildMarker = join(web, "dist", ".agent-autoloop-web.json");
const nodeMajor = Number(process.versions.node.split(".")[0]);

function checkNode() {
  if (nodeMajor >= 24) return;
  throw new Error(
    `需要 Node.js 24 或更高版本，当前是 ${process.versions.node}。` +
      "请从 https://nodejs.org 安装新版 Node.js，重新打开这个窗口后再试。",
  );
}

const digest = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function sourceFiles() {
  const files = ["index.html", "package.json", "package-lock.json", "tsconfig.json"];
  const walk = (folder) => {
    for (const entry of readdirSync(folder, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) files.push(path.slice(web.length + 1).replaceAll("\\", "/"));
    }
  };
  walk(join(web, "src"));
  return files;
}

function inputsDigest() {
  const hash = createHash("sha256");
  for (const file of sourceFiles()) {
    hash.update(file);
    hash.update("\0");
    hash.update(readFileSync(join(web, file)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function dependenciesReady() {
  if (
    !existsSync(join(web, "node_modules", "vite", "package.json")) ||
    !existsSync(join(web, "node_modules", "react", "package.json"))
  )
    return false;
  const marker = readJson(installMarker);
  return Boolean(
    marker &&
      marker.lock === digest(join(web, "package-lock.json")) &&
      marker.package === digest(join(web, "package.json")) &&
      marker.nodeMajor === nodeMajor,
  );
}

function buildReady() {
  if (!existsSync(join(web, "dist", "index.html"))) return false;
  const marker = readJson(buildMarker);
  return Boolean(marker && marker.inputs === inputsDigest() && marker.nodeMajor === nodeMajor);
}

function npmProgram() {
  const candidates = [
    join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
    join(dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ];
  const found = candidates.find((file) => existsSync(file));
  if (found) return [process.execPath, [found]];
  if (process.platform === "win32")
    throw new Error("找不到 npm。请重新安装 Node.js 24 或更高版本（安装包要包含 npm）后再试。");
  return ["npm", []];
}

function runNpm(args) {
  const [program, prefix] = npmProgram();
  return new Promise((resolve, reject) => {
    const next = spawn(program, [...prefix, ...args], { cwd: web, stdio: "inherit", windowsHide: true });
    next.once("error", reject);
    next.once("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`npm ${args.join(" ")} 失败（退出码 ${code}）。`)),
    );
  });
}

async function prepare() {
  if (!dependenciesReady()) {
    console.log("首次启动或依赖有变化，正在安装本地控制台依赖…");
    await runNpm(["ci", "--no-audit", "--no-fund", "--loglevel=error"]);
    writeFileSync(
      installMarker,
      `${JSON.stringify(
        {
          lock: digest(join(web, "package-lock.json")),
          package: digest(join(web, "package.json")),
          nodeMajor,
        },
        null,
        2,
      )}\n`,
    );
    console.log("依赖安装完成。");
  }
  if (!buildReady()) {
    console.log("首次启动或页面源码有更新，正在构建本地控制台…");
    await runNpm(["run", "build"]);
    writeFileSync(buildMarker, `${JSON.stringify({ inputs: inputsDigest(), nodeMajor }, null, 2)}\n`);
    console.log("页面构建完成。");
  }
}

function ensureConfig() {
  try {
    readConfig();
    return;
  } catch (error) {
    if (!/还没装好/.test(error.message)) throw new Error(`读取本机配置失败：${error.message}`);
  }
  console.log("这台电脑还没有配置，正在调用原生 init --no-service 完成首次配置…");
  const result = spawnBlocking(process.execPath, [cli, "init", "--no-service"]);
  if (result !== 0) throw new Error(`原生初始化失败（退出码 ${result ?? "未知"}）。请按上面的提示处理后重试。`);
  try {
    readConfig();
  } catch (error) {
    throw new Error(`初始化后仍读不到本机配置：${error.message}`);
  }
}

function spawnBlocking(program, args) {
  const { status } = spawnSync(program, args, { cwd: root, stdio: "inherit", windowsHide: true });
  return status;
}

async function main() {
  checkNode();
  const running = await runningClient();
  if (running) {
    console.log(`本地控制台已经在运行：${running.url}`);
    openBrowser(running.url);
    return;
  }
  // Web tests start the server without installing dependencies or building: both are checked against markers here only.
  if (process.env.AGENT_AUTOLOOP_WEB_SKIP_PREPARE !== "1") await prepare();
  ensureConfig();
  process.argv.push("--launch");
  await import("./main.mjs");
}

main().catch((error) => {
  console.error(`启动失败：${error.message}`);
  process.exitCode = 1;
});
