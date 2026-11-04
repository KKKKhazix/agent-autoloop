// The shell that Windows doesn't have. On POSIX the worker starts `/bin/sh -c '<cmd> >out 2>err; echo $? >exit'` so the
// output and the exit code land in files after the worker itself is gone. Windows has no such shell, so this program is
// that shell: it spawns the agent, copies its stdout and stderr into the same files, publishes the exit code the same
// way, and keeps a heartbeat file fresh so the worker can tell "still running" from "that pid is someone else now".
//
// It takes the agent as ordinary argv after `--`, never as a command string, so a prompt full of quotes or `&` stays a
// prompt. Nothing the agent is asked to do can be read as something to run.
//
//   node runner.mjs --out <file> --err <file> --exit <file> --heartbeat <file> -- <program> [args...]
import { spawn } from "node:child_process";
import { createWriteStream, readFileSync, renameSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { finished } from "node:stream/promises";

const HEARTBEAT_MS = 1000;

function parse(argv) {
  const flags = {};
  let i = 0;
  while (i < argv.length && argv[i] !== "--") {
    flags[argv[i].replace(/^--/, "")] = argv[i + 1];
    i += 2;
  }
  return { flags, rest: argv.slice(i + 1) };
}

const { flags, rest } = parse(process.argv.slice(2));
const [program, ...args] = rest;

if (!program) {
  process.stderr.write("runner: no program\n");
  process.exit(2);
}

function heartbeat() {
  const now = new Date();
  try {
    utimesSync(flags.heartbeat, now, now);
  } catch {
    try {
      writeFileSync(flags.heartbeat, "");
    } catch {}
  }
}

/** The exit code as a file: written beside it, then renamed, so a reader never sees half a number. */
function publishExit(code) {
  try {
    const temporary = `${flags.exit}.tmp`;
    writeFileSync(temporary, String(code));
    renameSync(temporary, flags.exit);
  } catch {}
}

/**
 * An npm-installed agent is a `.cmd` shim: on Windows a console program can't be started from a `.cmd` without a shell
 * since Node honoured CVE-2024-27980. Rather than hand the arguments to cmd.exe, which would read `%`, `&` and `"` inside
 * a prompt as syntax, the shim is read to find the JavaScript it runs and that is started directly.
 */
function throughShim(program) {
  if (process.platform !== "win32") return null;
  if (!/\.(cmd|bat)$/i.test(program)) return null;
  let text = "";
  try {
    text = readFileSync(program, "utf8");
  } catch {
    return null;
  }
  const relative = /"?%dp0%\\([^"\r\n]+?\.(?:js|mjs|cjs))"?/i.exec(text)?.[1];
  if (!relative) return null;
  const script = path.join(path.dirname(program), relative);
  try {
    readFileSync(script);
  } catch {
    return null;
  }
  return { program: process.execPath, args: [script, ...args] };
}

const target = throughShim(program) ?? { program, args };

const out = createWriteStream(flags.out, { flags: "a" });
const err = createWriteStream(flags.err, { flags: "a" });

heartbeat();
const beat = setInterval(heartbeat, HEARTBEAT_MS);

let child;
try {
  child = spawn(target.program, target.args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
} catch (error) {
  clearInterval(beat);
  err.write(`runner: ${error?.message ?? error}\n`);
  err.end(() => out.end(() => publishExit(126)));
}

if (child) {
  child.stdout.pipe(out);
  child.stderr.pipe(err);
  child.on("error", (error) => {
    try {
      err.write(`runner: ${error?.message ?? error}\n`);
    } catch {}
  });
  // `close` rather than `exit`: it fires once the pipes are closed too, so the streams below finish before this returns.
  // The exit code has to be published from here and nowhere earlier: the streams can drain before `close` fires, and a
  // code read at that moment is still null.
  child.on("close", async (exitCode) => {
    clearInterval(beat);
    await Promise.all([finished(out).catch(() => {}), finished(err).catch(() => {})]);
    publishExit(exitCode ?? 1);
    process.exit(0);
  });
}
