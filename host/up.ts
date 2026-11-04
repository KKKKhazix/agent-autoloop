// Everything this machine does, in one process: the hub, the worker and its channels, whichever config.json says. They
// speak the same protocol to each other here as they would across the world. A stop leaves agents running: they're
// detached, and the worker finds them again when it's back.
import { createWriteStream, existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadChannel } from "./channels.ts";
import { readConfig, type ChannelConfig } from "./config.ts";
import { HOME } from "./home.ts";
import { WINDOWS } from "./platform.ts";
import { runningUp } from "./service.ts";
import { commitOf } from "./version.ts";
import { hubClient } from "../protocol/client.ts";
import { createWorker } from "../worker/worker.ts";

const log = (who: string) => (line: string) => console.log(`${new Date().toISOString()} [${who}] ${line}`);

/**
 * launchd and systemd send this program's output to a file themselves; the Windows task scheduler has nowhere to say
 * that. When it's started by the task there is no console to write to, so the log becomes a file instead. A person who
 * runs `up` in a terminal still sees it on the terminal.
 */
function redirectOutput() {
  if (process.stdout.isTTY) return;
  const file = process.env.AGENT_AUTOLOOP_LOG ?? (WINDOWS ? path.join(HOME, "logs", "up.log") : null);
  if (!file) return;
  mkdirSync(path.dirname(file), { recursive: true });
  const stream = createWriteStream(file, { flags: "a" });
  const write = (parts: unknown[]) => stream.write(`${parts.map((part) => String(part)).join(" ")}\n`);
  console.log = (...parts: unknown[]) => write(parts);
  console.error = (...parts: unknown[]) => write(parts);
}

/** Only one of these per install: a second would take work beside the first. */
function lock() {
  const running = runningUp();
  if (running !== null) throw new Error(`已经在跑了（进程 ${running}）`);
  const file = path.join(HOME, "up.pid");
  writeFileSync(file, String(process.pid));
  return () => {
    try {
      unlinkSync(file);
    } catch {}
  };
}

/** secrets.env: what an adapter needs to check a webhook, kept out of rules.json. */
function loadSecrets() {
  const file = path.join(HOME, "secrets.env");
  if (existsSync(file)) process.loadEnvFile(file);
}

/** A channel that stops for any reason is started again. */
async function keepChannelRunning(
  id: string,
  { use, key, ...options }: ChannelConfig,
  url: string,
  signal: AbortSignal,
) {
  const say = log(id);
  while (!signal.aborted) {
    try {
      const start = await loadChannel(use ?? id);
      await start({ hub: hubClient(url, key), options, log: say, signal });
    } catch (error) {
      say(`stopped: ${error}; starting again in 30 seconds`);
      await new Promise((resolve) => setTimeout(resolve, 30_000));
    }
  }
}

export async function up() {
  redirectOutput();
  const config = readConfig();
  mkdirSync(HOME, { recursive: true, mode: 0o700 });
  const unlock = lock();
  const stop = new AbortController();
  const jobs: Promise<unknown>[] = [];
  let close = () => {};
  if (config.hub) {
    loadSecrets();
    const [host, port] = config.hub.listen.split(":");
    process.env.AGENT_AUTOLOOP_PUBLIC_URL = config.hub.publicUrl ?? `http://${config.hub.listen}`;
    const { serve } = await import("./http.ts");
    const say = log("hub");
    const server = serve(Number(port), host, { commit: commitOf() });
    server.on("listening", () => say(`listening on ${config.hub!.listen}`));
    server.on("error", (error) => {
      say(`can't listen: ${error}`);
      process.exit(1);
    });
    close = () => {
      server.close();
      server.closeAllConnections();
    };
  }
  if (config.worker) {
    const { key, name, capacity, unreachable } = config.worker;
    const worker = createWorker({ hub: hubClient(config.url, key), name, capacity, unreachable, log: log("worker") });
    jobs.push(worker.run(stop.signal));
  }
  for (const [id, channel] of Object.entries(config.channels ?? {})) {
    jobs.push(keepChannelRunning(id, channel, config.url, stop.signal));
  }
  const finish = () => {
    stop.abort();
    close();
    unlock();
    process.exit(0);
  };
  process.on("SIGTERM", finish);
  process.on("SIGINT", finish);
  await Promise.all(jobs);
}
