// A second double-click must reuse the console that is already serving, not start a second one or a second hub.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const launch = resolve(import.meta.dirname, "../server/launch.mjs");

function launchProcess(home) {
  const proc = spawn(process.execPath, [launch], {
    env: {
      ...process.env,
      AGENT_AUTOLOOP_HOME: home,
      AGENT_AUTOLOOP_WEB_PORT: "0",
      AGENT_AUTOLOOP_WEB_SKIP_PREPARE: "1",
      AGENT_AUTOLOOP_WEB_NO_BROWSER: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let output = "";
  let resolved = false;
  const url = new Promise((resolveUrl) => {
    const settle = (value) => {
      if (resolved) return;
      resolved = true;
      resolveUrl(value);
    };
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk) => {
      output += chunk;
      const found = output.match(/http:\/\/127\.0\.0\.1:\d+\/#connect=[0-9a-f]+/);
      if (found) settle(found[0]);
    });
    proc.stderr.setEncoding("utf8");
    proc.stderr.on("data", (chunk) => (output += chunk));
    proc.once("exit", () => settle(null));
  });
  return { proc, url, output: () => output };
}

test("a second launch reuses the running console and stop closes only that console", async (t) => {
  const hub = createServer((req, res) => {
    if (req.url === "/healthz") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"ok":true}');
    } else {
      res.writeHead(404).end();
    }
  });
  hub.listen(0, "127.0.0.1");
  await once(hub, "listening");
  const home = await mkdtemp(join(tmpdir(), "autoloop-launch-"));
  await writeFile(
    join(home, "config.json"),
    JSON.stringify({
      url: `http://127.0.0.1:${hub.address().port}`,
      owner: "owner-key",
      worker: { name: "local", key: "worker-key" },
    }),
  );
  const first = launchProcess(home);
  t.after(async () => {
    if (first.proc.exitCode === null) first.proc.kill();
    if (first.proc.exitCode === null) await once(first.proc, "exit").catch(() => {});
    hub.close();
    await rm(home, { recursive: true, force: true });
  });
  const found = await first.url;
  assert.ok(found, first.output());
  const url = new URL(found);
  assert.ok(existsSync(join(home, "web-client.json")));

  const second = launchProcess(home);
  const [code] = await once(second.proc, "exit");
  assert.equal(code, 0, second.output());
  assert.match(second.output(), /已经在运行/);
  assert.match(second.output(), new RegExp(url.port));

  const response = await fetch(url.origin + "/api/shutdown", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Origin: url.origin,
      "x-autoloop-session": url.hash.slice("#connect=".length),
    },
    body: "{}",
  });
  assert.equal(response.status, 200);
  if (first.proc.exitCode === null) {
    const [stopped] = await once(first.proc, "exit");
    assert.equal(stopped, 0);
  }
  assert.equal(existsSync(join(home, "web-client.json")), false);
});
