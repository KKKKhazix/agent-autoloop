// Code outside the allowlist, edited acceptance tests, failed checks or a stale review must never close a coding goal.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, delimiter } from "node:path";
import { test } from "node:test";
import { projectConfig, next } from "../examples/recipes/goal-loop/loop.ts";
import { codeWorkspace, applyChanges, inspectCode } from "../examples/recipes/goal-loop/code.ts";

function fixture(logs = false) {
  const home = mkdtempSync(join(tmpdir(), "goal-code-test-"));
  const repository = join(home, "repository");
  mkdirSync(repository);
  execFileSync("git", ["init", "-b", "main", repository], { stdio: "ignore" });
  writeFileSync(join(repository, "sum.mjs"), "export const sum = (a, b) => a - b;\n");
  writeFileSync(
    join(repository, "check.mjs"),
    (logs
      ? 'process.stdout.write("o".repeat(100000) + "STDOUT-END"); process.stderr.write("e".repeat(100000) + "STDERR-END");\n'
      : "") +
      "import { appendFileSync } from 'node:fs'; appendFileSync('checks.log', 'check\\n'); import assert from 'node:assert/strict'; import { sum } from './sum.mjs'; assert.equal(sum(2, 3), 5);\n",
  );
  execFileSync("git", ["-C", repository, "add", "."]);
  execFileSync(
    "git",
    ["-C", repository, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "fixture"],
    { stdio: "ignore" },
  );
  const project = projectConfig({
    id: "code-demo",
    goal: "修复加法",
    acceptance: "2 + 3 等于 5",
    maxRounds: 4,
    code: { repository, files: ["sum.mjs"], check: [process.execPath, "check.mjs"], checkFiles: ["check.mjs"] },
  });
  return { home, repository, project };
}

test("real code changes and test exit codes are isolated from the source repository", async () => {
  const { home, repository, project } = fixture();
  try {
    const workspace = codeWorkspace(project, join(home, "state"), "run-1");
    const failing = await applyChanges(project, workspace, [
      { path: "sum.mjs", content: "export const sum = (a, b) => a - b;\n" },
    ]);
    assert.equal(failing.proof.passed, false);
    assert.notEqual(failing.proof.exitCode, 0);
    await assert.rejects(() => applyChanges(project, workspace, [{ path: "check.mjs", content: "" }]));
    await assert.rejects(() => applyChanges(project, workspace, [{ path: "../sum.mjs", content: "" }]));
    const fixed = await applyChanges(project, workspace, [
      { path: "sum.mjs", content: "export const sum = (a, b) => a + b;\n" },
    ]);
    assert.equal(fixed.proof.passed, true);
    assert.equal(fixed.proof.exitCode, 0);
    assert.equal(readFileSync(join(repository, "sum.mjs"), "utf8"), "export const sum = (a, b) => a - b;\n");
    assert.equal(inspectCode(project, workspace, fixed.proof.revision).proof.revision, fixed.proof.revision);
    writeFileSync(join(workspace, "sum.mjs"), "export const sum = () => 0;\n");
    assert.throws(() => inspectCode(project, workspace, fixed.proof.revision));
    const unchecked = inspectCode(project, workspace);
    assert.equal(unchecked.proof, undefined);
    assert.equal(unchecked.check, undefined);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a coding review and completion require runner evidence for that revision", () => {
  const { home, project } = fixture();
  try {
    const start = next(project, "plan", [
      { source: "goal-code-demo-results", type: "run.manual", subject: "run-1", detail: "" },
    ]);
    const proposal = { decision: "task", capability: "draft", task: "修复加法", acceptance: "加法测试通过" };
    const task = start.accept(proposal).events![0];
    const execution = next(project, "draft", [{ ...task, source: "goal-code-demo-tasks" }]);
    const value = { status: "done", output: "改好了", evidence: "声称通过" };
    assert.throws(() => execution.accept(value));
    const proof = { revision: "a".repeat(64), passed: false, exitCode: 1 };
    const result = execution.accept(value, proof).events![0];
    const reviewTask = next(project, "plan", [{ ...result, source: "goal-code-demo-results" }]).accept({
      ...proposal,
      capability: "review",
    }).events![0];
    const inspection = next(project, "review", [{ ...reviewTask, source: "goal-code-demo-tasks" }]);
    assert.throws(() =>
      inspection.accept({ status: "done", output: "通过", evidence: "改好了", verdict: "pass" }, proof),
    );
    assert.throws(() =>
      inspection.accept(
        { status: "done", output: "需改", evidence: "改好了", verdict: "revise" },
        { ...proof, revision: "b".repeat(64) },
      ),
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("configuration cannot authorize editing the configured test command or escape the clone", () => {
  const { home, project } = fixture();
  try {
    assert.throws(() => projectConfig({ ...project, code: { ...project.code, files: ["check.mjs"] } }));
    assert.throws(() => projectConfig({ ...project, code: { ...project.code, files: ["../outside.mjs"] } }));
    assert.throws(() => projectConfig({ ...project, code: { ...project.code, files: ["package.json"] } }));
    assert.throws(() => projectConfig({ ...project, code: { ...project.code, files: ["tsconfig.json"] } }));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("changing acceptance files invalidates a previously passing code snapshot", async () => {
  const { home, project } = fixture();
  try {
    const workspace = codeWorkspace(project, join(home, "state"), "run-1");
    const passed = await applyChanges(project, workspace, [
      { path: "sum.mjs", content: "export const sum = (a, b) => a + b;\n" },
    ]);
    writeFileSync(join(workspace, "check.mjs"), "process.exit(0);\n");
    assert.throws(() => inspectCode(project, workspace, passed.proof.revision));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("successful checks retain bounded tails from both large output streams", async () => {
  const { home, project } = fixture(true);
  try {
    const workspace = codeWorkspace(project, join(home, "state"), "run-1");
    const result = await applyChanges(project, workspace, [
      { path: "sum.mjs", content: "export const sum = (a, b) => a + b;\n" },
    ]);
    assert.equal(result.proof.passed, true);
    assert.ok(result.check.stdout.endsWith("STDOUT-END"));
    assert.ok(result.check.stderr.endsWith("STDERR-END"));
    assert.ok(result.check.stdout.length <= 8000 && result.check.stderr.length <= 8000);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

function stubbedDraft(home: string, project: ReturnType<typeof projectConfig>, evidence: string) {
  const bin = join(home, "bin");
  mkdirSync(bin);
  const counter = join(home, "model-calls");
  const response = {
    status: "done",
    output: "修复加法",
    evidence,
    changes: [{ path: "sum.mjs", content: "export const sum = (a, b) => a + b;\n" }],
  };
  writeFileSync(
    join(bin, "codex"),
    `#!/usr/bin/env node
import { appendFileSync, writeFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(counter)}, 'call\\n');
writeFileSync(process.argv[process.argv.indexOf('--output-last-message') + 1], ${JSON.stringify(JSON.stringify(response))});
`,
    { mode: 0o700 },
  );
  const task = next(project, "plan", [
    { source: "goal-code-demo-results", type: "run.manual", subject: "run-1", detail: "" },
  ]).accept({ decision: "task", capability: "draft", task: "修复加法", acceptance: "加法测试通过" }).events![0];
  const config = join(home, "project.json");
  const context = join(home, "context.json");
  writeFileSync(config, JSON.stringify(project));
  writeFileSync(context, JSON.stringify({ events: [{ ...task, source: "goal-code-demo-tasks" }] }));
  const run = () =>
    execFileSync(
      process.execPath,
      [join(import.meta.dirname, "../examples/recipes/goal-loop/run.ts"), "draft", config],
      {
        encoding: "utf8",
        timeout: 8000,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          PATH: [bin, dirname(process.execPath), process.env.PATH].join(delimiter),
          AGENT_AUTOLOOP_HOME: join(home, "state"),
          AGENT_AUTOLOOP_CONTEXT: context,
        },
      },
    );
  return { run, counter };
}

test("an invalid model reply cannot write code or run acceptance", { skip: process.platform === "win32" }, () => {
  const { home, project } = fixture();
  try {
    const { run } = stubbedDraft(home, project, "");
    assert.throws(run, (error: any) => error.status === 1 && String(error.stderr).includes("文字缺失"));
    const workspace = codeWorkspace(project, join(home, "state"), "run-1");
    assert.equal(readFileSync(join(workspace, "sum.mjs"), "utf8"), "export const sum = (a, b) => a - b;\n");
    assert.equal(existsSync(join(workspace, "checks.log")), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test(
  "a completed draft replay repeats neither the model nor the tests",
  { skip: process.platform === "win32" },
  async () => {
    const { home, project } = fixture();
    try {
      const { run, counter } = stubbedDraft(home, project, "已修改");
      const first = run();
      const replay = run();
      assert.equal(replay, first);
      assert.equal(readFileSync(counter, "utf8"), "call\n");
      const workspace = codeWorkspace(project, join(home, "state"), "run-1");
      assert.equal(readFileSync(join(workspace, "checks.log"), "utf8"), "check\n");
      const repaired = "export const sum = (a, b) => { return a + b; };\n";
      await applyChanges(project, workspace, [{ path: "sum.mjs", content: repaired }]);
      assert.equal(run(), first);
      assert.equal(readFileSync(counter, "utf8"), "call\n");
      assert.equal(readFileSync(join(workspace, "checks.log"), "utf8"), "check\ncheck\n");
      assert.equal(readFileSync(join(workspace, "sum.mjs"), "utf8"), repaired);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  },
);

test("a direct acceptance alias cannot resolve to editable source", { skip: process.platform === "win32" }, () => {
  const { home, repository, project } = fixture();
  try {
    symlinkSync("sum.mjs", join(repository, "alias.mjs"));
    execFileSync("git", ["-C", repository, "add", "."]);
    execFileSync(
      "git",
      ["-C", repository, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "alias"],
      { stdio: "ignore" },
    );
    const aliased = projectConfig({
      ...project,
      code: { ...project.code, check: [process.execPath, "alias.mjs"], checkFiles: ["alias.mjs"] },
    });
    assert.throws(() => codeWorkspace(aliased, join(home, "state"), "run-1"), /验收/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("acceptance cannot target the original repository through paths or option values", () => {
  const { home, repository, project } = fixture();
  try {
    const absolute = projectConfig({
      ...project,
      code: { ...project.code, check: [process.execPath, join(repository, "check.mjs")] },
    });
    assert.throws(() => codeWorkspace(absolute, join(home, "state"), "absolute-check"), /原仓库/);
    const prefix = projectConfig({
      ...project,
      code: { ...project.code, check: ["npm", "--prefix=" + repository, "test"] },
    });
    assert.throws(() => codeWorkspace(prefix, join(home, "state"), "prefix-check"), /原仓库/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("fixed check argv preserves empty arguments and boundary spaces", async () => {
  const { home, repository, project } = fixture();
  try {
    writeFileSync(
      join(repository, "check.mjs"),
      readFileSync(join(repository, "check.mjs"), "utf8") + "assert.deepEqual(process.argv.slice(2), [' a ', '']);\n",
    );
    execFileSync("git", ["-C", repository, "add", "."]);
    execFileSync(
      "git",
      ["-C", repository, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "argv"],
      { stdio: "ignore" },
    );
    const exact = projectConfig({
      ...project,
      code: { ...project.code, check: [process.execPath, "check.mjs", " a ", ""] },
    });
    const workspace = codeWorkspace(exact, join(home, "state"), "argv-check");
    const result = await applyChanges(exact, workspace, [
      { path: "sum.mjs", content: "export const sum = (a, b) => a + b;\n" },
    ]);
    assert.equal(result.proof.passed, true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
