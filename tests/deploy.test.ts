// Failure modes: a project without ops/deploy.json is told to write one, and a broken one (bad JSON, a string where a
// command list goes, an unknown field) fails saying which part, not "probe mismatch"; with confirm on, the deploy command
// must not run before the owner answers — an empty answers list asks, a "取消" answer cancels, an answer to another card
// doesn't count, and only "发布" runs the command; a deploy command that fails says its exit code and the tail of its
// stderr; a version command that fails is distinguished from a probe mismatch; when the live version never matches, the
// round fails with both the expected and the last observed version in evidence, so the owner sees the drift; an http
// probe that isn't localhost is refused before anything runs; a URL probe reads a JSON field or a regex capture and a
// command probe's whole output is the version; a chatty publish command printing megabytes isn't killed by Node's
// 1 MB default; only the first line of a version or probe command is the version; a URL probe doesn't follow redirects.
// The whole loop too: a rule using `deploy` gets its round, the question
// card, the answer and the verified finish through a real `up`, with the plugin loaded as an install-folder copy that
// can't reach the engine's sources.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const root = mkdtempSync(join(tmpdir(), "agent-autoloop-deploy-"));
after(() => rmSync(root, { recursive: true, force: true }));
const run = join(import.meta.dirname, "..", "plugins", "deploy", "run.ts");
const sh = (name: string) => [process.execPath, name];

/** A project dir with the given scripts plus ops/deploy.json and a context file. */
function project(
  deploy: unknown,
  files: Record<string, string>,
  answers: (title: string) => unknown[] = () => [],
  version = "v2",
) {
  const dir = mkdtempSync(join(root, "proj-"));
  mkdirSync(join(dir, "ops"), { recursive: true });
  writeFileSync(join(dir, "ops", "deploy.json"), typeof deploy === "string" ? deploy : JSON.stringify(deploy));
  for (const [name, code] of Object.entries(files)) writeFileSync(join(dir, name), code);
  const context = join(dir, "context.json");
  writeFileSync(context, JSON.stringify({ answers: answers(`发布 ${dir.split("/").at(-1)} ${version}`) }));
  return { dir, context };
}

// Async, not spawnSync: a probe may be a mock server in this process, and spawnSync would freeze its event loop.
const go = (dir: string, context: string, env: NodeJS.ProcessEnv = {}) =>
  new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", run], {
      cwd: dir,
      env: { ...process.env, AGENT_AUTOLOOP_CONTEXT: context, ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });

const ok = (name: string, body: string) => ({ [name]: body });
const SCRIPTS = {
  ...ok("version.cjs", `console.log("v2");`),
  ...ok("probe.cjs", `console.log(require("node:fs").readFileSync("live.txt", "utf8").trim());`),
};
// Cards don't carry the ask key: the round's own title names the question (see run.ts).
const deployAnswer = (title: string, chosen: string, choice: number) => ({
  title,
  chosen,
  options: ["发布", "取消"],
  choice,
  card: 3,
  text: null,
  by: null,
  at: "",
  about: "",
});

test("no ops/deploy.json: told to write one", async () => {
  const dir = mkdtempSync(join(root, "empty-"));
  const context = join(dir, "context.json");
  writeFileSync(context, JSON.stringify({ answers: [] }));
  const done = await go(dir, context);
  assert.notEqual(done.code, 0);
  assert.match(done.stdout, /没跑成：/);
  assert.match(done.stdout, /ops\/deploy\.json/);
});

test("a broken ops/deploy.json fails saying which part", async () => {
  for (const [name, deploy, clue] of [
    ["not json", "{oops", "不是 JSON"],
    ["command missing", { version: sh("v.cjs"), probe: { command: sh("p.cjs") } }, "command"],
    [
      "command not a list",
      { command: "publish.cjs", version: sh("v.cjs"), probe: { command: sh("p.cjs") } },
      "command",
    ],
    ["version not a list", { command: sh("c.cjs"), version: 7, probe: { command: sh("p.cjs") } }, "version"],
    ["probe empty", { command: sh("c.cjs"), version: sh("v.cjs"), probe: {} }, "probe"],
    [
      "unknown field",
      { command: sh("c.cjs"), version: sh("v.cjs"), probe: { command: sh("p.cjs") }, surprise: 1 },
      "不认识的字段",
    ],
  ] as const) {
    const { dir, context } = project(deploy, {});
    const done = await go(dir, context);
    assert.notEqual(done.code, 0, name);
    assert.match(done.stdout, new RegExp(clue), name);
    assert.match(done.stdout, /没跑成：/, name);
  }
});

test("confirm on: no answer yet asks, and the deploy command has not run", async () => {
  const { dir, context } = project(
    { command: sh("publish.cjs"), version: sh("version.cjs"), probe: { command: sh("probe.cjs") }, confirm: true },
    { ...SCRIPTS, ...ok("publish.cjs", `require("node:fs").writeFileSync("marker.txt", "ran");`) },
  );
  const done = await go(dir, context);
  assert.equal(done.code, 0, done.stderr);
  assert.equal(existsSync(join(dir, "marker.txt")), false, "the deploy command must not run before the answer");
  assert.match(done.stdout, /```agent-autoloop\n/);
  assert.match(done.stdout, /"key":"deploy"/);
  assert.match(done.stdout, /"options":\["发布","取消"\]/);
});

test("confirm on: an answer to another card doesn't count, it asks again", async () => {
  const { dir, context } = project(
    { command: sh("publish.cjs"), version: sh("version.cjs"), probe: { command: sh("probe.cjs") }, confirm: true },
    { ...SCRIPTS, ...ok("publish.cjs", `require("node:fs").writeFileSync("marker.txt", "ran");`) },
    () => [
      {
        title: "别的卡片",
        chosen: "绿色",
        options: ["蓝色", "绿色"],
        choice: 1,
        card: 9,
        text: null,
        by: null,
        at: "",
      },
    ],
  );
  const done = await go(dir, context);
  assert.equal(done.code, 0, done.stderr);
  assert.equal(existsSync(join(dir, "marker.txt")), false);
  assert.match(done.stdout, /"key":"deploy"/);
});

test("confirm on: 发布 runs and a matching probe finishes verified", async () => {
  const { dir, context } = project(
    { command: sh("publish.cjs"), version: sh("version.cjs"), probe: { command: sh("probe.cjs") }, confirm: true },
    {
      ...SCRIPTS,
      ...ok("publish.cjs", `require("node:fs").writeFileSync("live.txt", "v2");`),
    },
    (title) => [deployAnswer(title, "发布", 0)],
  );
  const done = await go(dir, context);
  assert.equal(done.code, 0, done.stderr);
  assert.match(done.stdout, /发布完成：线上版本已核实为 v2/);
});

test("confirm on: 取消 ends the round without running anything", async () => {
  const { dir, context } = project(
    { command: sh("publish.cjs"), version: sh("version.cjs"), probe: { command: sh("probe.cjs") }, confirm: true },
    { ...SCRIPTS, ...ok("publish.cjs", `require("node:fs").writeFileSync("marker.txt", "ran");`) },
    (title) => [deployAnswer(title, "取消", 1)],
  );
  const done = await go(dir, context);
  assert.equal(done.code, 0, done.stderr);
  assert.match(done.stdout, /已取消发布/);
  assert.equal(existsSync(join(dir, "marker.txt")), false);
});

test("a failing deploy command reports its exit code and stderr tail", async () => {
  const { dir, context } = project(
    { command: sh("publish.cjs"), version: sh("version.cjs"), probe: { command: sh("probe.cjs") } },
    {
      ...ok("publish.cjs", `console.error("disk on fire"); process.exit(3);`),
      ...ok("version.cjs", `console.log("v2");`),
      ...ok("probe.cjs", `console.log("v2");`),
    },
  );
  const done = await go(dir, context);
  assert.notEqual(done.code, 0);
  assert.match(done.stdout, /没跑成：发布命令退出码 3/);
  assert.match(done.stdout, /disk on fire/);
});

test("a failing version command is distinguished from a probe mismatch", async () => {
  const { dir, context } = project(
    { command: sh("publish.cjs"), version: sh("version.cjs"), probe: { command: sh("probe.cjs") } },
    {
      ...ok("publish.cjs", `require("node:fs").writeFileSync("marker.txt", "ran");`),
      ...ok("version.cjs", `console.error("not a repo"); process.exit(128);`),
      ...ok("probe.cjs", `console.log("v1");`),
    },
  );
  const done = await go(dir, context);
  assert.notEqual(done.code, 0);
  assert.match(done.stdout, /没跑成：版本命令退出码 128/);
  assert.equal(existsSync(join(dir, "marker.txt")), false, "nothing was published");
});

test("a probe that never matches fails with both versions in evidence", async () => {
  const { dir, context } = project(
    { command: sh("publish.cjs"), version: sh("version.cjs"), probe: { command: sh("probe.cjs") }, deadline: 2 },
    {
      ...ok("publish.cjs", `require("node:fs").writeFileSync("marker.txt", "ran");`),
      ...ok("version.cjs", `console.log("v2");`),
      ...ok("probe.cjs", `console.log("v1");`),
    },
  );
  const done = await go(dir, context);
  assert.notEqual(done.code, 0);
  assert.equal(existsSync(join(dir, "marker.txt")), true, "the deploy command did run");
  assert.match(done.stdout, /没跑成：/);
  assert.match(done.stdout, /期望「v2」/);
  assert.match(done.stdout, /仍是「v1」/);
});

test("an http probe that isn't localhost is refused before anything runs", async () => {
  const { dir, context } = project(
    { command: sh("publish.cjs"), version: sh("version.cjs"), probe: { url: "http://example.com/health" } },
    ok("publish.cjs", `require("node:fs").writeFileSync("marker.txt", "ran");`),
  );
  const done = await go(dir, context);
  assert.notEqual(done.code, 0);
  assert.match(done.stdout, /没跑成：/);
  assert.match(done.stdout, /https/);
  assert.equal(existsSync(join(dir, "marker.txt")), false);
});

test("a URL probe reads a JSON field or a regex capture", async () => {
  const server = createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, data: { commit: "abc123" } }));
    } else {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("version=def456\n");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    for (const [probe, expected] of [
      [{ url: `http://127.0.0.1:${port}/health`, field: "data.commit" }, "abc123"],
      [{ url: `http://127.0.0.1:${port}/plain`, pattern: "=(\\w+)" }, "def456"],
    ] as const) {
      const { dir, context } = project(
        { command: sh("publish.cjs"), version: sh("version.cjs"), probe, deadline: 2 },
        { ...ok("publish.cjs", ""), ...ok("version.cjs", `console.log("${expected}");`) },
      );
      const done = await go(dir, context);
      assert.equal(done.code, 0, done.stderr);
      assert.match(done.stdout, new RegExp(`发布完成：线上版本已核实为 ${expected}`));
    }
  } finally {
    server.close();
  }
});

test("a chatty publish command isn't killed at 1 MB of output", async () => {
  const { dir, context } = project(
    { command: sh("publish.cjs"), version: sh("version.cjs"), probe: { command: sh("probe.cjs") } },
    {
      ...SCRIPTS,
      ...ok(
        "publish.cjs",
        `process.stdout.write("x".repeat(2 * 1024 * 1024)); require("node:fs").writeFileSync("live.txt", "v2");`,
      ),
    },
  );
  const done = await go(dir, context);
  assert.equal(done.code, 0, done.stderr);
  assert.match(done.stdout, /发布完成：线上版本已核实为 v2/);
});

test("only the first line of a version or probe command is the version", async () => {
  const { dir, context } = project(
    { command: sh("publish.cjs"), version: sh("version.cjs"), probe: { command: sh("probe.cjs") } },
    {
      ...ok("version.cjs", `console.log("v2\\nbuild warning: deprecation");`),
      ...ok("publish.cjs", `require("node:fs").writeFileSync("live.txt", "v2");`),
      ...ok("probe.cjs", `console.log("v2\\nssh stderr noise goes here");`),
    },
  );
  const done = await go(dir, context);
  assert.equal(done.code, 0, done.stderr);
  assert.match(done.stdout, /发布完成：线上版本已核实为 v2/);
});

test("a URL probe doesn't follow redirects", async () => {
  const server = createServer((req, res) => {
    if (req.url === "/old") {
      res.writeHead(302, { location: "/health" });
      res.end();
    } else {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ commit: "abc123" }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    const { dir, context } = project(
      {
        command: sh("publish.cjs"),
        version: sh("version.cjs"),
        probe: { url: `http://127.0.0.1:${port}/old`, field: "commit" },
        deadline: 2,
      },
      {
        ...ok("publish.cjs", `require("node:fs").writeFileSync("marker.txt", "ran");`),
        ...ok("version.cjs", `console.log("abc123");`),
      },
    );
    const done = await go(dir, context);
    assert.notEqual(done.code, 0, "a redirect must not prove the version is live");
    assert.equal(existsSync(join(dir, "marker.txt")), true, "the deploy command did run");
    assert.match(done.stdout, /期望「abc123」/);
  } finally {
    server.close();
  }
});

test("a URL probe that errors is observed, not a crash", async () => {
  const server = createServer((req, res) => {
    res.writeHead(503);
    res.end("down");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    const { dir, context } = project(
      {
        command: sh("publish.cjs"),
        version: sh("version.cjs"),
        probe: { url: `http://127.0.0.1:${port}/` },
        deadline: 2,
      },
      { ...ok("publish.cjs", ""), ...ok("version.cjs", `console.log("v2");`) },
    );
    const done = await go(dir, context);
    assert.notEqual(done.code, 0);
    assert.match(done.stdout, /期望「v2」/);
    assert.match(done.stdout, /HTTP 503/);
  } finally {
    server.close();
  }
});

// The whole loop through a real `up`, with the plugin as an install-folder copy that can't reach the engine's sources.
const home = mkdtempSync(join(root, "home-"));
const bin = join(import.meta.dirname, "..", "bin", "agent-autoloop.ts");
after(() => rmSync(home, { recursive: true, force: true }));

const cli = (...args: string[]) =>
  spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", bin, ...args], {
    env: { ...process.env, AGENT_AUTOLOOP_HOME: home },
    encoding: "utf8",
    timeout: 60_000,
  });

test("an event, a confirming card, an answer, the deploy ran and verified", async () => {
  const port = await new Promise<number>((resolve) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
  const done = cli("init", "--no-service", "--command", "true", "--port", String(port));
  assert.equal(done.status, 0, done.stderr);

  // The project: publish flips the live file, version and probe agree after it.
  const proj = mkdtempSync(join(root, "loop-proj-"));
  mkdirSync(join(proj, "ops"), { recursive: true });
  writeFileSync(
    join(proj, "ops", "deploy.json"),
    JSON.stringify({
      command: sh("publish.cjs"),
      version: sh("version.cjs"),
      probe: { command: sh("probe.cjs") },
      confirm: true,
    }),
  );
  writeFileSync(join(proj, "publish.cjs"), `require("node:fs").writeFileSync("live.txt", "v9");`);
  writeFileSync(join(proj, "version.cjs"), `console.log("v9");`);
  writeFileSync(join(proj, "probe.cjs"), `console.log(require("node:fs").readFileSync("live.txt", "utf8").trim());`);

  // The plugin as an install-folder copy: its engine imports are rewritten to the files bundled beside it.
  const engine = join(import.meta.dirname, "..");
  const plugin = join(home, "plugins", "deploy");
  mkdirSync(plugin, { recursive: true });
  const agent = readFileSync(join(engine, "plugins", "deploy", "agent.ts"), "utf8");
  writeFileSync(join(plugin, "agent.ts"), agent.replaceAll("../../host/node-path.ts", "./node-path.ts"));
  writeFileSync(join(plugin, "node-path.ts"), readFileSync(join(engine, "host", "node-path.ts")));
  const runSource = readFileSync(join(engine, "plugins", "deploy", "run.ts"), "utf8");
  writeFileSync(join(plugin, "run.ts"), runSource.replaceAll("../../host/command.ts", "./command.ts"));
  writeFileSync(join(plugin, "command.ts"), readFileSync(join(engine, "host", "command.ts")));

  // `init` names the worker after this machine; a rule pointing nowhere is never picked up.
  const starter = JSON.parse(readFileSync(join(home, "rules.json"), "utf8"));
  const worker = starter.agents[starter.rules[0].to].worker;
  writeFileSync(
    join(home, "rules.json"),
    JSON.stringify({
      sources: { local: { name: "本机" } },
      agents: { ship: { name: "发布", worker, use: "deploy", timeout: 5 } },
      channels: {},
      rules: [
        {
          name: "发布",
          when: { source: "local", types: ["deploy.test"] },
          to: "ship",
          cwd: proj,
          prompt: "把最新版本发布到线上并核实。",
          tell: "never",
        },
      ],
    }),
  );

  const up = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", bin, "up"], {
    env: { ...process.env, AGENT_AUTOLOOP_HOME: home },
    stdio: "ignore",
  });
  try {
    const url = `http://127.0.0.1:${port}`;
    const get = (path: string, headers: Record<string, string> = {}) =>
      fetch(`${url}${path}`, { headers: { connection: "close", ...headers } });
    for (
      let i = 0;
      i < 100 &&
      !(await get("/healthz").then(
        (r) => r.ok,
        () => false,
      ));
      i++
    )
      await new Promise((resolve) => setTimeout(resolve, 100));

    const emitted = cli("emit", "deploy.test", "--subject", "demo");
    assert.equal(emitted.status, 0, emitted.stderr);
    assert.match(emitted.stdout, /交给了：发布/);

    const config = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
    const state = async () => (await get("/v1/state", { authorization: `Bearer ${config.owner}` })).json();
    const until = async (ok: (s: any) => boolean) => {
      let last: unknown;
      for (let i = 0; i < 150; i++) {
        const now = await state();
        last = now;
        if (ok(now)) return now;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.fail(`timed out: ${JSON.stringify(last)}`);
    };

    const asking = await until((s) => s.cards.length === 1);
    assert.match(asking.cards[0].title, /发布/);
    assert.equal(existsSync(join(proj, "live.txt")), false, "not before the answer");

    const answered = cli("answer", String(asking.cards[0].id), "1");
    assert.equal(answered.status, 0, answered.stderr);
    const finished = await until((s) => s.runs.some((r: any) => r.state === "done" && /发布完成/.test(r.summary)));
    assert.equal(existsSync(join(proj, "live.txt")), true);
    assert.match(finished.runs.find((r: any) => r.state === "done").summary, /发布完成：线上版本已核实为 v9/);
    const why = cli("why", String(finished.runs.find((r: any) => r.state === "done").id));
    assert.match(why.stdout, /线上版本已核实为 v9/);
  } finally {
    up.kill("SIGTERM");
    await new Promise((resolve) => up.once("exit", resolve));
  }
});
