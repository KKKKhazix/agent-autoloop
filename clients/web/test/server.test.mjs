// Only a browser opened by this local instance can read configuration or invoke the native CLI.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("the adapter requires its launch link and preserves native credentials on the server", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "autoloop-client-"));
  const secret = "credential-stays-in-config";
  await writeFile(
    join(home, "config.json"),
    JSON.stringify({ url: "http://127.0.0.1:3350", owner: secret, worker: { name: "local", key: secret } }),
  );
  const proc = spawn(process.execPath, [resolve(import.meta.dirname, "../server/main.mjs")], {
    env: { ...process.env, AGENT_AUTOLOOP_HOME: home, AGENT_AUTOLOOP_WEB_PORT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const exited = once(proc, "exit");
  t.after(async () => {
    proc.kill();
    await exited;
    await rm(home, { recursive: true, force: true });
  });
  const [first] = await once(proc.stdout, "data");
  const url = new URL(String(first).trim().split(/\s+/).at(-1));
  const headers = { "X-Autoloop-Session": url.hash.slice("#connect=".length) };
  const local = url.origin + "/api/local";
  assert.equal((await fetch(local)).status, 401);
  const result = await fetch(local, { headers });
  assert.equal(result.status, 200);
  assert.ok(!(await result.text()).includes(secret));
  assert.equal(
    (
      await fetch(url.origin + "/api/worker", {
        method: "POST",
        headers: { ...headers, Origin: "http://example.test", "Content-Type": "application/json" },
        body: "{}",
      })
    ).status,
    403,
  );
});
