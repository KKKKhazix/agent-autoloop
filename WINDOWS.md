# Windows

The program started life on macOS and Linux. This document is what running it on Windows changed, why each change was
needed, and what is not covered yet.

## Install

Needs Node 22.18 or newer and Git. The project as a whole declares Node 24 in `package.json`, in CI and in `doctor`, and
that has not been changed here — lowering a support contract is a decision for the maintainer, not for a port. What this
port did do is run the whole Windows flow on 22.22.2, and let `install.ps1` proceed on 22.18 while printing a line that
`doctor` will still mark the Node row as not passing. So expect `doctor` to show `○ Node 22.x` on an older runtime; that
is the declared contract talking, not a broken install.

```powershell
git clone --depth 1 https://github.com/KKKKhazix/agent-autoloop.git "$env:TEMP\agent-autoloop"
powershell -ExecutionPolicy Bypass -File "$env:TEMP\agent-autoloop\install.ps1"
```

`install.ps1` puts the code in `%USERPROFILE%\.agent-autoloop\app`, writes an `agent-autoloop.cmd` shim into
`%USERPROFILE%\.local\bin`, adds that folder to your user `PATH`, registers the logon task, and runs `init`.

Open a new terminal afterwards (the `PATH` change reaches only new ones) and run `agent-autoloop try`.

Options are the same as `install.sh`: `--agent claude|codex`, `--command '<a command> {prompt}'`, `--port 3350`,
`--no-service`.

## What is different, and why

| Thing | macOS / Linux | Windows | Why |
| --- | --- | --- | --- |
| Output redirection and exit code | `/bin/sh -c '<cmd> >out 2>err; echo $? >exit'` | `worker/runner.mjs`, a Node program | There is no `/bin/sh`. Something has to keep copying output after the starter has gone, and publish the exit code as a file. |
| Starting a detached run | `detached: true` gives a new process group | `detached: true` plus the runner | Same intent: the agent outlives the worker. |
| Stopping a run | `process.kill(-pid, SIGTERM)` then `SIGKILL` | `taskkill /PID <pid> /T /F` | Negative pids and POSIX signals do not exist. `taskkill /T` is what reaches a child the agent started, as a process group does. |
| Is it still running | `ps -p <pid> -o command=` | pid + a heartbeat file the runner rewrites every second | There is no `ps`, and a pid alone can belong to someone else after a reboot. The heartbeat is what makes the answer trustworthy. |
| Kept running | launchd `KeepAlive` / systemd `Restart=always` | a Task Scheduler task: logon trigger, `RestartOnFailure` every minute, `ExecutionTimeLimit` of `PT0S`, `IgnoreNew` | The same three properties. `PT0S` matters: a task is otherwise killed after three days. |
| Environment for the task | launchd `EnvironmentVariables` / systemd `Environment=` | `%USERPROFILE%\.agent-autoloop\service.mjs`, a launcher the task runs | The scheduler's action has nowhere to set a variable, and `AGENT_AUTOLOOP_HOME` has to be the folder this install owns. |
| Desktop notification | `osascript` / `notify-send` | `plugins/desktop/toast.ps1`, a Windows Toast; falls back to `msg` | A Toast needs a registered app id; PowerShell's own works. |
| Finding a program | `$SHELL -lc 'command -v <name>'` | walk `PATH` × `PATHEXT` in Node | `where.exe` answers in the console code page, so a folder whose name is Chinese comes back as mojibake. |
| `~/notes` | expanded | also `~\notes` | A person writing a path on Windows writes it that way. |
| Rule `cwd` check | must start with `~/` or `/` | also accepts `C:\`, `C:/`, `\\server\share` | The old check rejected every absolute Windows path, which made a fresh `init` fail on Windows. |

## Files touched

- `host/platform.ts` — new. Everything above that differs, in one place. The POSIX branch is the previous code moved, not
  rewritten, so macOS and Linux behave exactly as before.
- `worker/runner.mjs` — new. The stand-in for `/bin/sh`. Takes the agent as argv after `--`, so a prompt is never parsed
  as a command. Also reads an npm `.cmd` shim to find the JavaScript it runs, because starting a `.cmd` without a shell
  is not allowed any more, and handing a prompt to `cmd.exe` would let `%`, `&` and `"` inside it be read as syntax.
- `worker/worker.ts` — `launch` / `alive` / `signal` / `groupAlive` now go through `host/platform.ts`; `~` expansion
  handles `~\`.
- `worker/agents.ts` — `findProgram` uses `findOnPath`.
- `host/service.ts` — a Windows branch: task XML, install/remove/query/stop, and `runningUp` by pid.
- `host/up.ts` — when nothing can read the console, output goes to `HOME/logs/up.log`. The scheduler has no
  `StandardOutPath`.
- `host/runtime.ts` — `chmod` on the install folder is best-effort.
- `host/server.ts` — the rules file watch compares against `path.basename`; the old `split("/")` never matched on Windows.
- `cli/main.ts` — `howToRun` recognises the `.cmd` shim; the skill link is a junction on Windows; the Node check accepts
  22.18.
- `cli/uninstall.ts` — removes the `.cmd` shim by its text.
- `plugins/desktop/channel.ts` — a Windows branch; `plugins/desktop/toast.ps1` is new.
- `plugins/delivery/project.ts` — the path check understands `\`.
- `protocol/rules.ts` — the `cwd` check accepts Windows absolute paths.
- `install.ps1` — new. The counterpart of `install.sh`.
- `bin/agent-autoloop.ts` — unchanged. Its shebang is ignored on Windows; the `.cmd` shim is what runs it.

## Checked on a real machine

Windows 11 专业版 26300, Node 22.22.2, on a folder whose name is Chinese (`C:\Users\朔晦\...`):

- `init --command '<a script> {prompt}'` — wrote rules and config, valid on the first try after the `cwd` fix.
- `try` → the agent ran in a detached process, ended, and a card appeared; `answer` → the agent ran again in the same
  session and the card closed as done. Two turns, nothing held open in between.
- `status`, `doctor`, `why` — correct.
- `service install` — task created, hub listening within seconds; `service remove` — task gone, `serviceRunning` false.
- `host/platform.ts` on its own: heartbeat advances, `agentAlive` true then false, and `taskkill /T` took the agent's own
  child process with it.
- `toast.ps1` — returns 0 and shows a notification.

## Not covered

- The test suite is POSIX throughout: every fixture is a `/bin/sh` script, and several use `chmod`, `symlink` and `ps`.
  `npm test` will not pass on Windows as it stands. The behaviour above was checked end to end instead. Making the
  suite run on Windows means a platform-aware fixture helper, which is a separate piece of work.
- Webhook channels (DingTalk, WeCom, Slack, Discord), ACP, and the delivery pipeline were not exercised on Windows.
- A Toast needs an interactive session. With the desktop disconnected it may not appear; the card is still readable
  with `agent-autoloop status`, and a webhook channel is the way to get it on a phone.
- `--command` splits on whitespace, so an agent whose command line contains a path with a space cannot be described
  that way. This is the same on all platforms.
