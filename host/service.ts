// Keeping it running: launchd on a Mac, systemd on Linux, a logon task on Windows. All start it at login and start it
// again if it stops.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { HOME } from "./home.ts";
import { WINDOWS } from "./platform.ts";

const PROGRAM = path.join(import.meta.dirname, "..", "bin", "agent-autoloop.ts");
/** Another install on this machine (another AGENT_AUTOLOOP_HOME) has a service of its own. */
const label = () =>
  HOME === path.join(homedir(), ".agent-autoloop")
    ? "agent-autoloop"
    : `agent-autoloop-${createHash("sha256").update(HOME).digest("hex").slice(0, 8)}`;
const plistFile = () => path.join(homedir(), "Library/LaunchAgents", `${label()}.plist`);
const unitFile = () => path.join(homedir(), ".config/systemd/user", `${label()}.service`);
/** The task's own definition, kept so it can be read back and removed like the other two. */
const taskFile = () => path.join(HOME, "service.xml");
/** What the task actually starts. The scheduler can't set an environment variable, and this install's folder is one. */
const launcherFile = () => path.join(HOME, "service.mjs");
const xml = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

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

/** Windows quotes an argument only when it needs to; the task scheduler parses them like CommandLineToArgvW. */
const quoted = (part: string) => (/[\s"]/.test(part) ? `"${part.replaceAll('"', '\\"')}"` : part);

/** Whose task it is: a logon trigger with no user would belong to whoever made it, which is the same person here. */
const userId = () => [process.env.USERDOMAIN, process.env.USERNAME].filter(Boolean).join("\\");

/**
 * Started by the task. It exists because the scheduler's action has no place to say AGENT_AUTOLOOP_HOME, and the file
 * it reads has to be the one this install owns. A `.mjs` holds the folder as a string literal, so a folder whose name
 * is Chinese needs no code page to be read in.
 */
function launcher() {
  return `// Written by \`agent-autoloop service install\`; removed with \`service remove\`.
import { spawn } from "node:child_process";
const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", ${JSON.stringify(PROGRAM)}, "up"], {
  env: { ...process.env, AGENT_AUTOLOOP_HOME: ${JSON.stringify(HOME)} },
  stdio: "ignore",
});
child.on("exit", (code) => process.exit(code ?? 0));
`;
}

/**
 * What launchd's KeepAlive and systemd's Restart are, written the way the task scheduler reads it. Two settings matter:
 * `ExecutionTimeLimit` of PT0S (a task is otherwise killed after three days) and `RestartOnFailure`, which is the one
 * thing the logon trigger alone doesn't do. `IgnoreNew` is the single-instance rule the up.pid lock also enforces.
 */
export function taskXml() {
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Agent 自动化中台</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${xml(userId())}</UserId>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${xml(userId())}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>999</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xml(process.execPath)}</Command>
      <Arguments>${xml(quoted(launcherFile()))}</Arguments>
      <WorkingDirectory>${xml(HOME)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`;
}

const domain = () => `gui/${process.getuid!()}`;
const launchdHasIt = () =>
  spawnSync("launchctl", ["print", `${domain()}/${label()}`], { stdio: "ignore" }).status === 0;
const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Whether a pid is alive. Latin-1 keeps the ASCII we match on, whatever the console code page is. */
function pidRunning(pid: number) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    const out = execFileSync("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], {
      timeout: 15_000,
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    return out.toString("latin1").includes(`"${pid}"`);
  } catch {
    return false;
  }
}

export function installService() {
  mkdirSync(path.join(HOME, "logs"), { recursive: true, mode: 0o700 });
  if (WINDOWS) {
    // The scheduler reads its definition as UTF-16; the paths in it are the user's, and may not be Latin-1.
    writeFileSync(launcherFile(), launcher());
    writeFileSync(taskFile(), `\ufeff${taskXml()}`, "utf16le");
    execFileSync("schtasks", ["/Create", "/TN", label(), "/XML", taskFile(), "/F"], {
      stdio: "inherit",
      windowsHide: true,
    });
    // Created is not started: a person who just ran init wants the hub up before they run `try`.
    spawnSync("schtasks", ["/Run", "/TN", label()], { stdio: "ignore", windowsHide: true });
    return;
  }
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
  if (WINDOWS) {
    if (!existsSync(taskFile())) return;
    spawnSync("schtasks", ["/Delete", "/TN", label(), "/F"], { stdio: "ignore", windowsHide: true });
    rmSync(taskFile(), { force: true });
    rmSync(launcherFile(), { force: true });
    return;
  }
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

/** The process that left its number in up.pid, if it still is that process: the number may be someone else's by now. */
export function runningUp() {
  const file = path.join(HOME, "up.pid");
  if (!existsSync(file)) return null;
  const pid = readFileSync(file, "utf8").trim();
  if (WINDOWS) return pidRunning(Number(pid)) ? Number(pid) : null;
  let command = "";
  try {
    command = execFileSync("ps", ["-p", pid, "-o", "command="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {}
  return /agent-autoloop(\.ts)? up\b/.test(command) ? Number(pid) : null;
}

/** Stopping a service returns before its process is gone, and one started by hand has no service to stop it. */
export function stopUp() {
  if (WINDOWS) {
    // The task's process is what up.pid names; /T also takes whatever it started, as a process group would.
    spawnSync("schtasks", ["/End", "/TN", label()], { stdio: "ignore", windowsHide: true });
    const pid = runningUp();
    if (pid !== null) spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    for (let tries = 0; tries < 50 && runningUp() !== null; tries++) pause(100);
    return;
  }
  const pid = runningUp();
  if (pid === null) return;
  try {
    process.kill(pid, "SIGTERM");
  } catch {}
  for (let tries = 0; tries < 50 && runningUp() !== null; tries++) pause(100);
}

export function serviceRunning() {
  if (WINDOWS) {
    return spawnSync("schtasks", ["/Query", "/TN", label()], { stdio: "ignore", windowsHide: true }).status === 0;
  }
  if (process.platform === "darwin") return existsSync(plistFile()) && launchdHasIt();
  return spawnSync("systemctl", ["--user", "is-active", "--quiet", label()], { stdio: "ignore" }).status === 0;
}
