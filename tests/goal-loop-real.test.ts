// Invalid report paths must fail before startup; confirmed timeouts must fail without leaving temporary state.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

test("an unwritable report destination leaves no hub or model workspace", async () => {
  const home = mkdtempSync(join(tmpdir(), "goal-loop-report-"));
  const report = join(home, "report-directory");
  mkdirSync(report);
  try {
    await assert.rejects(
      promisify(execFile)(process.execPath, ["examples/recipes/goal-loop/real.ts", "--run", report], {
        cwd: join(import.meta.dirname, ".."),
        // No external model is launched, even on the broken implementation.
        env: { ...process.env, TMPDIR: home, TMP: home, TEMP: home, PATH: home },
        timeout: 5000,
      }),
    );
    assert.deepEqual(readdirSync(home), ["report-directory"]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a confirmed worker timeout cleans its temporary state", async () => {
  const home = mkdtempSync(join(tmpdir(), "goal-loop-timeout-"));
  const report = join(home, "report.json");
  const preload = join(home, "clock.mjs");
  const workerUrl = new URL("../worker/worker.ts", import.meta.url).href;
  let diagnostics = "";
  // Replace only the external command and advance the supported worker clock; process stopping and ACK handling stay real.
  const wrapper = `import { createWorker as actual } from ${JSON.stringify(workerUrl)};
export function createWorker(options) {
  let offset = 0;
  const work = options.hub.work;
  const hub = { ...options.hub, async work(query) {
    const reply = await work(query);
    if (reply.job) reply.job.agent.command = [process.execPath, '-e', 'setInterval(() => {}, 1000)'];
    return reply;
  }};
  const worker = actual({ ...options, hub, now: () => Date.now() + offset });
  return { ...worker, async tick() {
    await worker.tick();
    if (worker.entries().some(entry => entry.pid)) offset = 181000;
  }};
}`;
  writeFileSync(
    preload,
    `import { registerHooks } from 'node:module';
registerHooks({ resolve(specifier, context, next) {
  if (specifier === '../../../worker/worker.ts' && context.parentURL?.endsWith('/examples/recipes/goal-loop/real.ts'))
    return { url: ${JSON.stringify("data:text/javascript," + encodeURIComponent(wrapper))}, shortCircuit: true };
  return next(specifier, context);
}});
`,
  );
  try {
    await assert.rejects(
      promisify(execFile)(
        process.execPath,
        ["--import", pathToFileURL(preload).href, "examples/recipes/goal-loop/real.ts", "--run", report],
        {
          cwd: join(import.meta.dirname, ".."),
          env: { ...process.env, TMPDIR: home, TMP: home, TEMP: home },
          timeout: 20000,
        },
      ),
      (error: any) => {
        diagnostics = String(error.stderr);
        return error.code === 1;
      },
    );
    assert.ok(existsSync(report), diagnostics);
    const result = JSON.parse(readFileSync(report, "utf8"));
    assert.equal(result.verified, false);
    assert.ok(
      result.failures.some((receipt: any) => receipt.outcome === "failed" && receipt.error?.includes("已停止")),
    );
    assert.equal(result.retainedHome, undefined);
    assert.deepEqual(
      readdirSync(home).filter((name) => name.startsWith("goal-loop-real-")),
      [],
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
