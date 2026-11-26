// Real model acceptance: an incomplete source must be rejected, repaired, reviewed again, and only then closed.
import assert from "node:assert/strict";
import { openSync, closeSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { parseResult } from "../../../protocol/validate.ts";
import { projectConfig, rulesFor } from "./loop.ts";

const [flag, report] = process.argv.slice(2);
assert.ok(flag === "--run" && report && isAbsolute(report), "用法：node real.ts --run /absolute/path/report.json");
// Fail before creating state or spending model usage; never overwrite an earlier acceptance report.
const reportFile = openSync(report, "wx", 0o600);
let home: string | undefined;
let runtime: typeof import("../../../host/runtime.ts") | undefined;
let server: ReturnType<typeof import("../../../host/http.ts").serve> | undefined;
let worker: ReturnType<typeof import("../../../worker/worker.ts").createWorker> | undefined;
let owner: ReturnType<typeof import("../../../protocol/client.ts").hubClient> | undefined;
const trace: { run: number; role: string; summary: string; feedback: unknown }[] = [];
const started = Date.now();
let verified = false;
let closing = false;
let interrupted = false;
let receiptFailure: Error | undefined;
let uncertainCleanup = false;
let failureReason: string | undefined;
const failures: { run: number; role?: string; outcome: string; error?: string; rejected: unknown[] }[] = [];
const interrupt = () => {
  interrupted = true;
};
process.on("SIGINT", interrupt);
process.on("SIGTERM", interrupt);
const project = projectConfig({
  id: "real-loop",
  goal: "整理一份升级说明。第一轮起草只忠实转录旧稿，不补充：升级：安装新版。验证：查看版本号。审查后再根据指出的缺项修正旧稿。修正时可使用的资料：备份：保存当前配置。回退：安装旧版并恢复配置。",
  acceptance: "最终说明必须包含升级、验证、备份、回退四项具体操作；初稿只是旧资料，不视为验收通过。",
  requiredText: ["升级：安装新版", "验证：查看版本号", "备份：保存当前配置", "回退：安装旧版并恢复配置"],
  maxRounds: 4,
});
try {
  home = mkdtempSync(join(tmpdir(), "goal-loop-real-"));
  process.env.AGENT_AUTOLOOP_HOME = home;
  process.env.AGENT_AUTOLOOP_RULES = join(home, "rules.json");
  const file = join(home, "project.json");
  writeFileSync(file, JSON.stringify(project));
  writeFileSync(process.env.AGENT_AUTOLOOP_RULES, JSON.stringify({ ...rulesFor(project, "real", file), channels: {} }));
  const { serve } = await import("../../../host/http.ts");
  runtime = await import("../../../host/runtime.ts");
  const { hubClient } = await import("../../../protocol/client.ts");
  const { createWorker } = await import("../../../worker/worker.ts");
  server = serve(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}`;
  owner = hubClient(url, runtime.addKey("owner", "real"));
  const client = hubClient(url, runtime.addKey("worker", "real"));
  const roles = new Map<number, string>();
  worker = createWorker({
    name: "real",
    capacity: 1,
    wait: 0,
    hub: {
      async work(query) {
        const reply = await client.work({
          ...query,
          capacity: query.capacity && !closing && !interrupted && roles.size < 9,
        });
        if (reply.job) roles.set(reply.job.run, reply.job.agent.id.split("-").at(-1)!);
        return reply;
      },
      started: client.started,
      async result(run, token, raw) {
        const receipt = parseResult(raw);
        const ack = await client.result(run, token, receipt);
        // The hub has accepted the receipt even when individual actions were rejected. Do not make the worker replay it.
        if (ack.rejected.length) receiptFailure = new Error("中台拒绝了回执中的动作：" + JSON.stringify(ack.rejected));
        if (receipt.outcome === "failed" || ack.rejected.length) {
          failures.push({
            run,
            role: roles.get(run),
            outcome: receipt.outcome,
            error: receipt.error,
            rejected: ack.rejected,
          });
        }
        // A timeout can fail to confirm shutdown before cleanup starts, too. Preserve evidence for every such stop.
        if (
          receipt.outcome === "failed" &&
          worker?.entries().some((entry) => entry.run === run && entry.stopping !== undefined)
        )
          uncertainCleanup = true;
        // Observe only accepted receipts. Tokens and keys never enter the report.
        if (!ack.rejected.length && receipt.outcome === "done" && !trace.some((step) => step.run === run)) {
          const event = receipt.events?.[0];
          trace.push({
            run,
            role: roles.get(run)!,
            summary: receipt.summary!,
            feedback: event ? JSON.parse(event.detail!) : null,
          });
          console.log(`${trace.length}/9 ${roles.get(run)}: ${receipt.summary}`);
        }
        return ack;
      },
    },
  });
  await owner.run("real-loop 目标规划", { subject: "acceptance" });
  // Run the generated rules through the real worker, including heartbeat, parsing, submission and process-tree cleanup.
  while (trace.length < 9 || worker.entries().length) {
    assert.ok(!interrupted, "真实模型验收已中断");
    assert.ok(Date.now() - started < 30 * 60_000, "真实模型验收超时");
    await worker.tick();
    if (receiptFailure) throw receiptFailure;
    const state: { runs: { error?: string; state: string }[] } = await owner.state();
    const failed = state.runs.find((run: any) => run.error || ["failed", "cancelled"].includes(run.state));
    assert.ok(!failed, failed?.error ?? "真实执行失败");
    if (
      !worker.entries().length &&
      !state.runs.some((run: any) => ["queued", "claimed", "unknown"].includes(run.state)) &&
      trace.length < 9
    )
      throw new Error("闭环提前结束");
    await delay(100);
  }
  const results = trace.filter((step) => step.role !== "plan").map((step) => step.feedback as any);
  assert.deepEqual(
    results.map((step) => step.task.capability),
    ["draft", "review", "draft", "review"],
  );
  assert.equal(results[1].result.verdict, "revise");
  assert.equal(results[3].result.verdict, "pass");
  assert.notEqual(results[0].result.output, results[2].result.output);
  assert.equal(results[1].result.artifact, results[0].result.output);
  assert.equal(results[3].result.artifact, results[2].result.output);
  assert.ok(project.requiredText!.some((text) => !results[0].result.output.includes(text)));
  assert.ok(project.requiredText!.every((text) => results[2].result.output.includes(text)));
  assert.match(trace.at(-1)!.summary, /^验收通过，已结项：/);
  assert.equal((await client.work({ claim: "closed", wait: 0, running: [], capacity: true })).job, null);
  assert.equal((await owner.state()).runs.length, 9);
  verified = true;
} catch (error) {
  failureReason = (error as Error).message;
  throw error;
} finally {
  closing = true;
  let reaped = false;
  try {
    // Cancellation uses the worker's existing Unix process-group / Windows Job Object implementation.
    if (worker && owner) {
      const state: { runs: { id: number; state: string }[] } = await owner.state();
      for (const entry of worker.entries()) {
        // A result may already be committed while its local ACK is still pending; terminal runs cannot be cancelled.
        const run = state.runs.find((run) => run.id === entry.run);
        if (run && ["queued", "claimed"].includes(run.state)) await owner.cancel(entry.run);
      }
      const deadline = Date.now() + 30_000;
      while (worker.entries().length && Date.now() < deadline) {
        await worker.tick();
        await delay(100);
      }
      assert.ok(!uncertainCleanup, "没能确认进程树结束，保留临时目录以便排查");
      assert.equal(worker.entries().length, 0, "进程尚未退出，保留临时目录以便排查");
    }
    reaped = true;
  } catch (error) {
    failureReason ??= (error as Error).message;
    throw error;
  } finally {
    try {
      writeFileSync(
        reportFile,
        JSON.stringify(
          {
            verified: verified && reaped,
            failureReason,
            failures,
            ...(!reaped ? { retainedHome: home } : {}),
            node: process.version,
            platform: process.platform,
            model: "local Codex CLI default",
            ms: Date.now() - started,
            project,
            trace,
          },
          null,
          2,
        ),
      );
    } finally {
      closeSync(reportFile);
      server?.closeAllConnections();
      if (server?.listening) await new Promise<void>((resolve) => server!.close(() => resolve()));
      runtime?.db.close();
      if (home && reaped) rmSync(home, { recursive: true, force: true });
      process.off("SIGINT", interrupt);
      process.off("SIGTERM", interrupt);
    }
  }
}
