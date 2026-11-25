// Compare on the same virtual clock. The real CLI is opt-in; its token counts are measured, never simulated.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import codex from "../../../plugins/codex/agent.ts";
import type { Adapter } from "../../../worker/agents.ts";
import { usageDelta } from "../../../worker/usage.ts";
import type { Usage } from "../../../protocol/validate.ts";
import { World } from "../../../sim/world.ts";

const adapter: Adapter = codex;
const amounts = [12, 25, 4];
const step = 60_000;

function runCodex(data: number[] | null, dir: string, resume: string | null) {
  const prompt =
    "这是一个合成实验。只读这条消息，不读文件，不使用工具。此刻的导出快照为 " +
    JSON.stringify(data) +
    "。若为 null，只回复 WAIT；若是数组，只回复 行数,总和（半角逗号、阿拉伯数字，无其他文字）。";
  const [program, ...args] = adapter.command({
    prompt,
    cwd: dir,
    access: "read",
    session: randomUUID(),
    resume: resume ?? null,
    contextFile: "",
    folder: dir,
    effort: "low",
  });
  const result = spawnSync(program, args, {
    cwd: dir,
    encoding: "utf8",
    timeout: 120000,
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  const read = adapter.read(result.stdout, result.status, result.stderr);
  if (result.status !== 0 || read.error || !read.text || !read.session)
    throw new Error(read.error ?? "Codex 未完成本轮");
  if (resume) assert.equal(read.session, resume, "复查没有接回原会话");

  return { reply: read.text.trim(), session: read.session, usage: read.usage, sessionUsage: read.sessionUsage };
}

function compareArm(strategy: "later" | "probe", real: boolean, readyTick: number | null) {
  const world = new World();
  const dir = mkdtempSync(join(tmpdir(), "autoloop-export-"));
  const file = join(dir, "export.json");
  const products: string[] = [];
  const usage: (Usage | null)[] = [];
  let baseline: Usage | undefined;
  let calls = 0;
  let readyLagTicks: number | null = null;
  let readyLagMs: number | null = null;
  let readyAt: number | undefined;
  try {
    for (let tick = 0; tick < 4; tick++) {
      if (tick === readyTick) {
        writeFileSync(file, JSON.stringify(amounts));
        readyAt = performance.now();
      }
      // Repeated observations publish the same source event, including the one after the report finished.
      if ((strategy === "later" && tick === 0) || (strategy === "probe" && existsSync(file))) {
        world.call("ingest", "app", { id: "export-1", type: "one", subject: "export-1" });
      }
      if (tick > 0) world.advance(step);
      const job = world.call("claimNext", "w1", `claim-${tick}`);
      if (!job) continue;
      calls++;
      const data: number[] | null = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
      let reply: string;
      let session = job.resume ?? "fixture";
      let used: Usage | undefined;
      if (real) {
        const read = runCodex(data, dir, job.resume);
        session = read.session;
        reply = read.reply;
        used =
          read.usage ??
          (read.sessionUsage && (job.resume ? usageDelta(read.sessionUsage, baseline) : read.sessionUsage));
        baseline = read.sessionUsage;
        usage.push(used ?? null);
      } else {
        reply = data === null ? "WAIT" : `${data.length},${data.reduce((a, b) => a + b, 0)}`;
      }
      if (reply === "WAIT") {
        assert.equal(data, null, "已就绪的导出被遗漏");
        world.finish(job.run, {
          outcome: "done",
          session,
          usage: used,
          later: [{ key: "ready", at: new Date(world.now + step).toISOString(), about: "检查导出" }],
        });
      } else {
        assert.ok(readyTick !== null && readyAt !== undefined, "在文件就绪前交付了摘要");
        assert.equal(reply, "3,41", "摘要的业务校验未通过");
        products.push(reply);
        readyLagTicks = tick - readyTick;
        readyLagMs = Math.round(performance.now() - readyAt);
        world.finish(job.run, { outcome: "done", session, usage: used, summary: reply });
      }
    }
    assert.deepEqual(products, readyTick === null ? [] : ["3,41"]);
    return { strategy, calls, products, readyLagTicks, readyLagMs, usage };
  } finally {
    world.view.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

export function compare(real: boolean, readyTick: number | null) {
  return [compareArm("later", real, readyTick), compareArm("probe", real, readyTick)];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 1 || args[0] !== "--codex")) throw new Error("用法：node compare.ts [--codex]");
  console.log(JSON.stringify(compare(args[0] === "--codex", 2), null, 2));
}
