// What one machine differs from another in: starting a detached agent with its output in files, stopping a whole tree of
// processes, and finding a program. The POSIX branch is exactly what the program did before; the Windows branch is new.
//
// Why Windows needs its own branch at all, in one place:
//   - There is no /bin/sh, so output redirection and the exit-code file can't be done by a shell. worker/runner.mjs is a
//     Node program that spawns the agent and does both. It is the equivalent of `sh -c '<cmd> >out 2>err; echo $? >exit'`.
//   - There are no process groups and no signals: `process.kill(-pid)` throws on Windows. `taskkill /T` is the
//     equivalent of signalling a whole process group, and it's what a stop has to use.
//   - There is no `ps`, so "is it still running" is answered by the pid plus a heartbeat the runner rewrites every
//     second. A pid on its own is not enough: the same number can belong to someone else after a reboot.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export const WINDOWS = process.platform === "win32";
const ROOT = path.join(import.meta.dirname, "..");
const RUNNER = path.join(ROOT, "worker", "runner.mjs");
/** A heartbeat older than this means the runner that wrote it is gone. */
const STALE_MS = 15_000;

/** Everything needed to start one turn of an agent that outlives the program which starts it. */
export type DetachedRun = {
  /** The agent itself, as the adapter built it. */
  program: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Where its stdout, stderr and exit code go, and the heartbeat that says it's still running. */
  out: string;
  err: string;
  exit: string;
  /** Where the command waits for /bin/sh: a login shell need not agree on how it reads arguments (fish has no $0 or $@). */
  commandFile: string;
  heartbeat: string;
  /** A string on the process's command line, so a reused pid is not mistaken for this run. */
  marker: string;
};

const quoted = (word: string) => `'${word.replaceAll("'", `'\\''`)}'`;

function launchPosix(run: DetachedRun) {
  // Login shells don't agree on how a command reads its arguments (fish has no $0 or $@), so the command waits in a
  // file for /bin/sh. Its path travels by environment because the install path can hold any character.
  writeFileSync(
    run.commandFile,
    `unset AGENT_AUTOLOOP_COMMAND\nexec ${[run.program, ...run.args].map(quoted).join(" ")}\n`,
    {
      mode: 0o600,
    },
  );
  // Output and the exit code go through the shell, so they land in their files even if this program has gone by then.
  const script = [
    "out=$1",
    "err=$2",
    "result=$3",
    "shift 3",
    "umask 077",
    '"$@" >"$out" 2>"$err"',
    'echo $? >"$result.tmp"',
    'mv "$result.tmp" "$result"',
    // A final external command can replace the shell before publishing its exit file.
    ":",
  ].join("\n");
  // The login shell gives it the PATH and sign-in its owner has in a terminal; launchd and systemd give neither.
  const login = [process.env.SHELL ?? "/bin/sh", "-lc", 'exec /bin/sh "$AGENT_AUTOLOOP_COMMAND"'];
  return spawn("/bin/sh", ["-c", script, run.marker, run.out, run.err, run.exit, ...login], {
    cwd: run.cwd,
    env: { ...run.env, AGENT_AUTOLOOP_COMMAND: run.commandFile },
    detached: true,
    stdio: "ignore",
  });
}

function launchWindows(run: DetachedRun) {
  // No shell at all: the runner takes the prompt as an ordinary argument, so nothing in it can be read as a command.
  const argv = [
    RUNNER,
    "--out",
    run.out,
    "--err",
    run.err,
    "--exit",
    run.exit,
    "--heartbeat",
    run.heartbeat,
    "--",
    run.program,
    ...run.args,
  ];
  return spawn(process.execPath, argv, {
    cwd: run.cwd,
    env: run.env,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
}

/** Starts the run and returns the pid that stands for it: the shell on POSIX, the runner on Windows. */
export function launchAgent(run: DetachedRun, log: (line: string) => void) {
  const child = WINDOWS ? launchWindows(run) : launchPosix(run);
  child.on("error", (error) => log(String(error)));
  child.unref();
  return child.pid;
}

function fresh(file: string) {
  try {
    return Date.now() - statSync(file).mtimeMs < STALE_MS;
  } catch {
    return false;
  }
}

/** Whether a pid is alive. Latin-1 keeps the ASCII we match on, whatever the console code page is. */
function pidRunning(pid: number) {
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

/** Whether the run this pid stands for is still going: not a stranger that got the number. */
export function agentAlive(pid: number | undefined, heartbeat: string, marker: string): boolean {
  if (!pid) return false;
  if (!WINDOWS) {
    try {
      const command = execFileSync("ps", ["-p", String(pid), "-o", "command="], {
        encoding: "utf8",
        timeout: 15_000,
        stdio: ["ignore", "pipe", "ignore"],
      });
      return command.includes(marker);
    } catch {
      return false;
    }
  }
  if (!pidRunning(pid)) return false;
  // The runner writes a heartbeat before it's asked: a missing one is a run that only just started.
  return !existsSync(heartbeat) || fresh(heartbeat);
}

/** Whether anything of the run is left. POSIX asks its process group; Windows asks the runner's own tree. */
export function groupAlive(pid: number | undefined): boolean {
  if (!pid) return false;
  if (!WINDOWS) {
    try {
      // The wrapper can die before a child; zombies have already stopped and only their parent can reap them.
      return execFileSync("ps", ["-ax", "-o", "pgid=", "-o", "stat="], {
        encoding: "utf8",
        timeout: 15_000,
        stdio: ["ignore", "pipe", "ignore"],
      })
        .trim()
        .split("\n")
        .some((line) => {
          const [group, state] = line.trim().split(/\s+/);
          return Number(group) === pid && !state.startsWith("Z");
        });
    } catch {
      return false;
    }
  }
  return pidRunning(pid);
}

/** Stops the run and everything it started. `force` is the last resort, after the grace the caller allows. */
export function signalTree(pid: number | undefined, force: boolean) {
  if (!pid) return;
  try {
    if (!WINDOWS) return void process.kill(-pid, force ? "SIGKILL" : "SIGTERM");
    // A console program on Windows has nothing to catch a SIGTERM with, so a polite first try would only wait out the
    // grace and then hit the same command: /T /F is what actually stops the tree.
    execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
      stdio: "ignore",
      timeout: 15_000,
      windowsHide: true,
    });
  } catch {}
}

/** Where a program is on what a person's terminal would find. Null when it isn't installed. */
export function findOnPath(name: string): string | null {
  if (WINDOWS) {
    // Walking PATH rather than running `where`: that program answers in the console's code page, so a folder whose name
    // is Chinese comes back as mojibake. The search order is the one Windows itself uses, PATH then PATHEXT.
    const extensions = (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
    for (const folder of (process.env.PATH ?? "").split(path.delimiter)) {
      if (!folder) continue;
      for (const candidate of [name, ...extensions.map((extension) => name + extension)]) {
        const file = path.join(folder, candidate);
        if (existsSync(file)) return file;
      }
    }
    return null;
  }
  try {
    const shell = process.env.SHELL ?? "/bin/sh";
    const printed = execFileSync(shell, ["-lc", `command -v ${name}`], {
      encoding: "utf8",
      timeout: 15_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return printed.trim().split("\n").at(-1) || null;
  } catch {
    return null;
  }
}

/** `~/notes` is a path a person writes; `~\notes` is the same path written on Windows. */
export const expandHome = (target: string) => target.replace(/^~(?=[\\/])/, homedir());
