// The runner must reject unsupported evidence and never publish a second proposal for one revision.
// A failed GitHub request must reach the hub as failed so its retry policy can wake the same work again.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readMessage } from "../worker/contract.ts";
// @ts-expect-error The recipe runs directly as an ES module.
import { scout } from "../examples/recipes/github-development/scout.mjs";

test("a failed scout request returns a retryable receipt", { skip: process.platform === "win32" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "github-scout-failure-"));
  try {
    const config = join(dir, "project.json");
    writeFileSync(
      config,
      JSON.stringify({ repo: "owner/repo", base: "main", scout: true, verify: ["node", "check.mjs"] }),
    );
    writeFileSync(join(dir, "gh"), "#!/bin/sh\necho 'GitHub unavailable' >&2\nexit 1\n", { mode: 0o700 });
    const output = execFileSync(process.execPath, ["examples/recipes/github-development/run.mjs", "scout", config], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, AGENT_AUTOLOOP_CONTEXT: join(dir, "unused") },
    });
    const result = readMessage(output);
    assert.equal(result.outcome, "failed");
    assert.match(result.error!, /项目巡检未完成/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("checks CI and source, respects pending review, and publishes one candidate per revision", async () => {
  const dir = mkdtempSync(join(tmpdir(), "github-scout-test-"));
  try {
    const path = join(dir, "project.json");
    const config = { repo: "owner/repo", base: "develop", scout: true };
    const commit = "a".repeat(40);
    let waiting = true;
    let inspected = 0;
    let created = 0;
    const ci = [{ headSha: commit, conclusion: "success" }];
    function gh(args: string[], body: string) {
      if (args[0] === "pr") return waiting ? '[{"number":2}]' : "[]";
      if (args[0] === "run") return JSON.stringify(ci);
      if (args[0] === "api" && args[1].includes("/issues?")) return "[]";
      if (args[0] === "api" && args[1].includes("git/ref")) return commit;
      if (args[0] === "api") {
        assert.ok(args[1].endsWith("?ref=" + commit));
        return JSON.stringify({
          type: "file",
          encoding: "base64",
          content: Buffer.from("const rows = [];").toString("base64"),
        });
      }
      if (args[1] === "list") return "[]";
      assert.equal(args[1], "create");
      assert.equal(args.at(-1), "agent-ready");
      assert.match(body, new RegExp(commit));
      assert.match(body, /实际标题行占 420 列/);
      created++;
      return "https://github.com/owner/repo/issues/3";
    }
    const proposal = {
      kind: "feature",
      title: "改进历史空态",
      path: "cli/runs.ts",
      excerpt: "const rows = [];",
      evidence: "用户看到空列表时无法判断能否继续查询",
      task: "给空态增加提示",
      acceptance: "定向验证空态文本",
    };
    const inspect = ({ ci: actual }: { ci: unknown }) => {
      assert.deepEqual(actual, ci);
      inspected++;
      return proposal;
    };
    assert.match(await scout(config, gh, path, false, inspect), /PR 等待处理/);
    assert.equal(inspected, 0);
    assert.match(await scout(config, gh, path, true, inspect), /只读预览/);
    waiting = false;
    await assert.rejects(
      scout(config, gh, path, false, () => ({ ...proposal, excerpt: "不存在的源码" })),
      /无法核对/,
    );
    assert.match(await scout(config, gh, path, false, inspect, undefined, { bugsOnly: true }), /本轮只接收/);
    assert.equal(created, 0);
    const bug = {
      ...proposal,
      kind: "bug",
      reproduction: { probe: "history-row-width", rule: "每日巡检".repeat(50), columns: 80 },
    };
    const replay = (at: string, input: typeof bug.reproduction) => {
      assert.equal(at, commit);
      assert.deepEqual(input, bug.reproduction);
      return { expected: 80, observed: 420 };
    };
    assert.match(
      await scout(
        config,
        gh,
        path,
        false,
        () => bug,
        () => null,
      ),
      /未观察到异常/,
    );
    assert.match(await scout(config, gh, path, false, () => bug, replay), /issues\/3$/);
    assert.match(await scout(config, gh, path, false, inspect), /已尝试建单/);
    assert.equal(created, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a fixed read-only probe reproduces the display defect outside the existing suite", async () => {
  // @ts-expect-error The recipe runs directly as an ES module.
  const { reproduction, confirmReproduction } = await import("../examples/recipes/github-development/scout-repro.mjs");
  const input = reproduction({ probe: "history-row-width", rule: "每日巡检".repeat(50), columns: 80 });
  assert.deepEqual(confirmReproduction(input, 420), { expected: 80, observed: 420 });
  assert.equal(confirmReproduction(input, 80), null);
  assert.equal(reproduction({ ...input, rule: "每日巡检。" }).rule, "每日巡检。");
  assert.throws(() => confirmReproduction(input, "420"));
  assert.throws(() => reproduction({ ...input, command: "node" }));
  assert.throws(() => reproduction({ ...input, probe: "shell" }));
});
