// Failure modes: the Windows login task does not start the installed hub, its status is wrong, or removal leaves the task running.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

test(
  "Windows login task starts and removes a private install",
  { skip: process.platform !== "win32" || !!process.env.CI },
  async () => {
    const home = mkdtempSync(join(tmpdir(), "agent-autoloop-service-"));
    process.env.AGENT_AUTOLOOP_HOME = home;
    const socket = createServer().listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => socket.once("listening", resolve));
    const port = (socket.address() as { port: number }).port;
    await new Promise<void>((resolve) => socket.close(() => resolve()));
    const initialized = spawnSync(
      process.execPath,
      [
        join(import.meta.dirname, "../bin/agent-autoloop.ts"),
        "init",
        "--no-service",
        "--command",
        "node",
        "--port",
        String(port),
      ],
      { encoding: "utf8" },
    );
    assert.equal(initialized.status, 0, initialized.stderr);
    const configFile = join(home, "config.json");
    const config = JSON.parse(readFileSync(configFile, "utf8"));
    config.channels = {};
    writeFileSync(configFile, JSON.stringify(config));
    const service = await import("../host/service.ts");
    try {
      service.installService();
      let healthy = false;
      const end = Date.now() + 20_000;
      while (Date.now() < end && !healthy) {
        healthy = await fetch(`http://127.0.0.1:${port}/healthz`).then(
          (r) => r.ok,
          () => false,
        );
        if (!healthy) await new Promise((resolve) => setTimeout(resolve, 200));
      }
      assert.ok(healthy, "the scheduled task did not start the hub");
      assert.ok(service.serviceRunning());
      service.removeService();
      service.stopUp();
      assert.equal(service.serviceRunning(), false);
      assert.equal(service.runningUp(), null);
    } finally {
      service.removeService();
      service.stopUp();
      rmSync(home, { recursive: true, force: true });
    }
  },
);
