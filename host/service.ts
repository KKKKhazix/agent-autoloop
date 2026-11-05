// Keeping it running: launchd on a Mac, systemd on Linux. Both start it at login and restart it if it stops.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { HOME } from "./home.ts";

const PROGRAM = path.join(import.meta.dirname, "..", "bin", "agent-autoloop.ts");
/** Another install on this machine (another AGENT_AUTOLOOP_HOME) has a service of its own. */
const label = () =>
  HOME === path.join(homedir(), ".agent-autoloop")
    ? "agent-autoloop"
    : `agent-autoloop-${createHash("sha256").update(HOME).digest("hex").slice(0, 8)}`;
const plistFile = () => path.join(homedir(), "Library/LaunchAgents", `${label()}.plist`);
const unitFile = () => path.join(homedir(), ".config/systemd/user", `${label()}.service`);
const xml = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

export type UpIdentity = {
  pid: number;
  started: string;
  command: string;
};

const psField = (pid: number, field: "lstart" | "command") => {
  const value = execFileSync("ps", ["-ww", "-p", String(pid), "-o", `${field}=`], {
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C" },
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
  if (!value) throw new Error(`读不到进程 ${pid} 的 ${field}`);
  return value;
};

export function upIdentity(pid = process.pid): UpIdentity {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error(`无效的进程号：${pid}`);
  return { pid, started: psField(pid, "lstart"), command: psField(pid, "command") };
}

export function plist() {
  const logs = path.join(HOME, "logs");
  const systemPaths = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"];
  const searchPath = [path.dirname(process.execPath), ...systemPaths].join(":");
  const program = [process.execPath, "--disable-warning=ExperimentalWarning", PROGRAM, "up"];
  const programArguments = program.map((part) => `<string>${xml(part)}</string>`).join("");
  const homeEntry = `<key>AGENT_AUTOLOOP_HOME</key><string>${xml(HOME)}</string>`;
  const pathEntry = `<key>PATH</key><string>${xml(searchPath)}</string>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${label()}</string>
  <key>ProgramArguments</key><array>${programArguments}</array>
  <key>EnvironmentVariables</key><dict>${homeEntry}${pathEntry}</dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${xml(logs)}/up.log</string>
  <key>StandardErrorPath</key><string>${xml(logs)}/up.log</string>
</dict></plist>
`;
}

export function unit() {
  return `[Unit]
Description=Agent 自动化中台

[Service]
Environment=AGENT_AUTOLOOP_HOME=${HOME}
ExecStart=${process.execPath} --disable-warning=ExperimentalWarning ${PROGRAM} up
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
`;
}

const domain = () => `gui/${process.getuid!()}`;
const launchdHasIt = () =>
  spawnSync("launchctl", ["print", `${domain()}/${label()}`], { stdio: "ignore" }).status === 0;
const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export function installService() {
  mkdirSync(path.join(HOME, "logs"), { recursive: true, mode: 0o700 });
  if (process.platform === "darwin") {
    mkdirSync(path.dirname(plistFile()), { recursive: true });
    writeFileSync(plistFile(), plist());
    spawnSync("launchctl", ["bootout", `${domain()}/${label()}`], { stdio: "ignore" });
    // bootout returns before the old one is gone; loading before that fails and leaves none.
    for (let tries = 0; tries < 100 && launchdHasIt(); tries++) pause(100);
    execFileSync("launchctl", ["bootstrap", domain(), plistFile()]);
  } else {
    mkdirSync(path.dirname(unitFile()), { recursive: true });
    writeFileSync(unitFile(), unit());
    execFileSync("systemctl", ["--user", "daemon-reload"]);
    execFileSync("systemctl", ["--user", "enable", "--now", label()]);
    execFileSync("systemctl", ["--user", "restart", label()]);
  }
}

export function removeService() {
  const file = process.platform === "darwin" ? plistFile() : unitFile();
  if (!existsSync(file) || !readFileSync(file, "utf8").includes(xml(PROGRAM))) return;
  if (process.platform === "darwin") {
    spawnSync("launchctl", ["bootout", `${domain()}/${label()}`], { stdio: "ignore" });
    rmSync(plistFile(), { force: true });
  } else {
    spawnSync("systemctl", ["--user", "disable", "--now", label()], { stdio: "ignore" });
    rmSync(unitFile(), { force: true });
  }
}

type RunningUp = { identity: UpIdentity; verified: boolean };
const isUp = ({ command }: UpIdentity) => /agent-autoloop(\.ts)? up\b/.test(command);
const sameIdentity = (left: UpIdentity, right: UpIdentity) =>
  left.pid === right.pid && left.started === right.started && left.command === right.command;

function runningUpProcess(): RunningUp | null {
  const file = path.join(HOME, "up.pid");
  if (!existsSync(file)) return null;
  const saved = readFileSync(file, "utf8").trim();
  const legacy = /^[1-9]\d*$/.test(saved);
  let expected: UpIdentity | null = null;
  let pid = legacy ? Number(saved) : 0;
  if (!legacy) {
    try {
      const parsed: unknown = JSON.parse(saved);
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        !Number.isSafeInteger((parsed as UpIdentity).pid) ||
        (parsed as UpIdentity).pid <= 0 ||
        typeof (parsed as UpIdentity).started !== "string" ||
        !(parsed as UpIdentity).started ||
        typeof (parsed as UpIdentity).command !== "string" ||
        !(parsed as UpIdentity).command
      )
        return null;
      expected = parsed as UpIdentity;
      pid = expected.pid;
    } catch {
      return null;
    }
  }
  let current: UpIdentity;
  try {
    current = upIdentity(pid);
  } catch {
    return null;
  }
  if (!isUp(current)) return null;
  if (expected && !sameIdentity(current, expected)) return null;
  return { identity: current, verified: expected !== null };
}

/** The process recorded in up.pid, if that number still belongs to the same Agent Autoloop process. */
export function runningUp() {
  return runningUpProcess()?.identity.pid ?? null;
}

/** Stopping a service returns before its process is gone, and one started by hand has no service to stop it. */
export function stopUp() {
  const running = runningUpProcess();
  if (!running?.verified) return;
  const { identity } = running;
  try {
    process.kill(identity.pid, "SIGTERM");
  } catch {}
  for (let tries = 0; tries < 50; tries++) {
    const current = runningUpProcess();
    if (!current?.verified || !sameIdentity(current.identity, identity)) break;
    pause(100);
  }
}

export function serviceRunning() {
  if (process.platform === "darwin") return existsSync(plistFile()) && launchdHasIt();
  return spawnSync("systemctl", ["--user", "is-active", "--quiet", label()], { stdio: "ignore" }).status === 0;
}
