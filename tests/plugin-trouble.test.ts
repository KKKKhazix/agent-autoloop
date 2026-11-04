// One process holds the hub, the worker and the channels, and plugins run inside it. Failure cases: an agent plugin that
// can't read what it printed ends the process, and ends it again on every start because the run is still there; a channel
// plugin that returns at once goes round without a pause and the hub never answers again, with the process alive so nothing
// restarts it; a channel plugin's stray throw or unhandled rejection ends the process; the database held too long by
// another process makes a tick throw from a timer and ends the process, or the rules change that tick brought is lost.
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";

const bin = join(import.meta.dirname, "..", "bin", "agent-autoloop.ts");
const homes: string[] = [];
const running: ChildProcess[] = [];
after(async () => {
  for (const child of running) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    child.kill("SIGKILL");
    await new Promise((resolve) => child.once("exit", resolve));
  }
  for (const home of homes) rmSync(home, { recursive: true, force: true });
});

const freePort = () =>
  new Promise<number>((resolve) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });

const edit = (file: string, change: (value: any) => void) => {
  const value = JSON.parse(readFileSync(file, "utf8"));
  change(value);
  writeFileSync(file, JSON.stringify(value, null, 2));
};

/** A real install in a home of its own, without the desktop channel, with these plugins in its folder. */
async function install(plugins: Record<string, string> = {}) {
  const home = mkdtempSync(join(tmpdir(), "agent-autoloop-plugin-trouble-"));
  homes.push(home);
  const notifiers = join(home, "notifiers");
  mkdirSync(notifiers);
  for (const name of ["osascript", "notify-send"]) {
    writeFileSync(join(notifiers, name), "#!/bin/sh\nexit 0\n");
    chmodSync(join(notifiers, name), 0o755);
  }
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    AGENT_AUTOLOOP_HOME: home,
    PATH: `${notifiers}:${process.env.PATH}`,
  };
  delete env.AGENT_AUTOLOOP_RULES;
  delete env.AGENT_AUTOLOOP_PUBLIC_URL;
  const port = await freePort();
  const cli = (...args: string[]) =>
    spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", bin, ...args], {
      env,
      encoding: "utf8",
      timeout: 30_000,
    });
  const installed = cli("init", "--command", "echo hi {prompt}", "--port", String(port), "--no-service");
  assert.equal(installed.status, 0, installed.stderr);
  for (const [file, code] of Object.entries(plugins)) {
    mkdirSync(join(home, "plugins", file.split("/")[0]), { recursive: true });
    writeFileSync(join(home, "plugins", file), code);
  }
  edit(join(home, "rules.json"), (rules) => (rules.channels = {}));
  edit(join(home, "config.json"), (config) => delete config.channels);
  const log = join(home, "up.log");
  writeFileSync(log, "");
  const up = () => {
    const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", bin, "up"], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout!.on("data", (data) => writeFileSync(log, data, { flag: "a" }));
    child.stderr!.on("data", (data) => writeFileSync(log, data, { flag: "a" }));
    running.push(child);
    return child;
  };
  return { home, port, cli, up, said: () => readFileSync(log, "utf8") };
}

/** Each on a connection of its own: a hub that's stopped answering must not look like a reused one that closed. */
async function answers(port: number) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/healthz`, {
      headers: { connection: "close" },
      signal: AbortSignal.timeout(2_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function until(done: () => boolean | Promise<boolean>, what: string, patience = 20_000) {
  const end = Date.now() + patience;
  while (!(await done())) {
    if (Date.now() > end) assert.fail(`等不到：${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const alive = (child: ChildProcess) => child.exitCode === null && child.signalCode === null;

test("an agent plugin that can't read what it printed fails that run, and the hub stays up", async () => {
  const it = await install({
    "unreadable/agent.ts": `export default {
      command: () => ["/bin/echo", "ok"],
      read() { throw new Error("no idea what this says"); },
    };`,
  });
  edit(join(it.home, "rules.json"), (rules) => {
    for (const agent of Object.values<any>(rules.agents)) {
      agent.use = "unreadable";
      delete agent.command;
    }
  });
  const up = it.up();
  await until(() => answers(it.port), "中台应答");
  assert.equal(it.cli("emit", "try.start", "--subject", "#1").status, 0);
  const owner = () => JSON.parse(readFileSync(join(it.home, "config.json"), "utf8")).owner as string;
  const firstRun = async () => {
    const response = await fetch(`http://127.0.0.1:${it.port}/v1/state`, {
      headers: { authorization: `Bearer ${owner()}`, connection: "close" },
      signal: AbortSignal.timeout(2_000),
    }).catch(() => null);
    return response?.ok ? (await response.json()).runs.at(-1) : undefined;
  };
  await until(async () => alive(up) === false || (await firstRun())?.attempts === 1, "这一轮算没跑成");
  assert.equal(alive(up), true, it.said());
  assert.match((await firstRun()).error, /读不懂/);
  assert.equal(await answers(it.port), true);
});

test("a channel plugin that returns at once doesn't stop the hub answering", async () => {
  const it = await install({ "quick/channel.ts": "export default async function quick() {}" });
  const key = it.cli("key", "new", "channel", "quick").stdout.trim();
  edit(join(it.home, "config.json"), (config) => (config.channels = { quick: { use: "quick", key } }));
  edit(join(it.home, "rules.json"), (rules) => (rules.channels = { quick: { name: "快" } }));
  const up = it.up();
  await until(() => answers(it.port), "中台应答");
  assert.equal(alive(up), true);
  await until(() => it.said().includes("[quick] stopped"), "日志说通道停了");
});

test("a channel plugin's stray throw and unhandled rejection stay its own trouble", async () => {
  const it = await install({
    "stray/channel.ts": `export default async function stray({ signal }) {
      setTimeout(() => { throw new Error("thrown out of reach"); }, 200);
      setTimeout(() => { Promise.reject(new Error("rejected with nobody listening")); }, 300);
      await new Promise((resolve) => signal.addEventListener("abort", resolve));
    }`,
  });
  const key = it.cli("key", "new", "channel", "stray").stdout.trim();
  edit(join(it.home, "config.json"), (config) => (config.channels = { stray: { use: "stray", key } }));
  edit(join(it.home, "rules.json"), (rules) => (rules.channels = { stray: { name: "乱" } }));
  const up = it.up();
  await until(() => alive(up) === false || it.said().includes("thrown out of reach"), "日志记下抛错");
  await until(
    () => alive(up) === false || it.said().includes("rejected with nobody listening"),
    "日志记下没人接的 Promise",
  );
  assert.equal(alive(up), true, it.said());
  assert.equal(await answers(it.port), true);
});

test("the database held too long by another process fails a tick, not the hub, and the change still lands", async () => {
  const it = await install();
  const up = it.up();
  await until(() => answers(it.port), "中台应答");
  const db = new DatabaseSync(join(it.home, "hub.db"));
  const askFirst = () => {
    const row = db.prepare("SELECT data FROM projections WHERE collection='config' AND key='rules'").get()!;
    return JSON.parse(String(row.data)).value.askFirst as string[];
  };
  db.exec("BEGIN IMMEDIATE");
  edit(join(it.home, "rules.json"), (rules) => (rules.askFirst = ["只问这一件"]));
  // The hub gives up on the lock after 5 seconds.
  await new Promise((resolve) => setTimeout(resolve, 6_000));
  db.exec("ROLLBACK");
  await until(() => alive(up) === false || askFirst()[0] === "只问这一件", "新规则生效");
  assert.equal(alive(up), true, it.said());
  assert.equal(await answers(it.port), true);
  db.close();
});
