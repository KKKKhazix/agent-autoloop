// Code outside the allowlist, edited acceptance tests, failed checks or a stale review must never close a coding goal.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, delimiter, relative } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
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
    assert.equal(
      inspectCode(project, workspace).acceptanceFiles[0].content,
      readFileSync(join(workspace, "check.mjs"), "utf8"),
    );
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
    const proof = { revision: "a".repeat(64), passed: false, exitCode: 256 };
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

test(
  "Windows repository spelling does not change its physical identity",
  { skip: process.platform !== "win32" },
  () => {
    const { home, project } = fixture();
    try {
      const config = projectConfig({
        ...project,
        code: { ...project.code, repository: project.code!.repository.toUpperCase() },
      });
      const workspace = codeWorkspace(config, join(home, "state"), "path-case");
      assert.equal(
        readFileSync(join(workspace, "sum.mjs"), "utf8").replaceAll("\r\n", "\n"),
        "export const sum = (a, b) => a - b;\n",
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  },
);

test("in-flight checks persist current logs without reusing an older passing proof", async () => {
  const { home, repository, project } = fixture();
  let pid: number | undefined;
  let ended = true;
  let settled: Promise<boolean> | undefined;
  try {
    writeFileSync(
      join(repository, "check.mjs"),
      `import { existsSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict'; import { sum } from './sum.mjs';
if (existsSync('hold-check')) {
  writeFileSync('check.pid', String(process.pid));
  process.stdout.write('CURRENT-CHECK-PROGRESS'); process.stderr.write('CURRENT-CHECK-ERR');
  setInterval(() => {}, 1000);
} else assert.equal(sum(2, 3), 5);
`,
    );
    execFileSync("git", ["-C", repository, "add", "."]);
    execFileSync(
      "git",
      [
        "-C",
        repository,
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.invalid",
        "commit",
        "-m",
        "foreground progress",
      ],
      { stdio: "ignore" },
    );
    const workspace = codeWorkspace(project, join(home, "state"), "progress");
    const changes = [{ path: "sum.mjs", content: "export const sum = (a, b) => a + b;\n" }];
    assert.equal((await applyChanges(project, workspace, changes)).proof.passed, true);
    writeFileSync(join(workspace, "hold-check"), "1");
    ended = false;
    settled = applyChanges(project, workspace, changes)
      .then(
        (result) => result.proof.passed,
        () => false,
      )
      .finally(() => {
        ended = true;
      });
    const deadline = Date.now() + 8000;
    let observed = false;
    while (Date.now() < deadline) {
      if (existsSync(join(workspace, "check.pid"))) {
        pid = Number(readFileSync(join(workspace, "check.pid"), "utf8"));
        const running = inspectCode(project, workspace);
        if (
          running.check?.stdout.includes("CURRENT-CHECK-PROGRESS") &&
          running.check.stderr.includes("CURRENT-CHECK-ERR")
        ) {
          assert.equal(running.proof, undefined);
          observed = true;
          break;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(observed, "当前测试进度必须在进程结束前持久化");
    process.kill(pid!, "SIGTERM");
    assert.equal(await settled, false);
    const stopped = inspectCode(project, workspace);
    assert.notEqual(stopped.proof?.passed, true);
    assert.ok(stopped.check?.stdout.includes("CURRENT-CHECK-PROGRESS"));
  } finally {
    if (!ended && pid) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {}
    }
    if (settled) await settled;
    rmSync(home, { recursive: true, force: true });
  }
});

test("Windows native failure codes remain readable evidence", { skip: process.platform !== "win32" }, async () => {
  const { home, repository, project } = fixture();
  try {
    writeFileSync(join(repository, "check.mjs"), "process.stderr.write('native failure'); process.exit(256);\n");
    execFileSync("git", ["-C", repository, "add", "."]);
    execFileSync(
      "git",
      [
        "-C",
        repository,
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.invalid",
        "commit",
        "-m",
        "native exit",
      ],
      { stdio: "ignore" },
    );
    const workspace = codeWorkspace(project, join(home, "state"), "native-code");
    const result = await applyChanges(project, workspace, [
      { path: "sum.mjs", content: "export const sum = (a, b) => a + b;\n" },
    ]);
    assert.equal(result.proof.exitCode, 256);
    assert.equal(result.proof.passed, false);
    assert.equal(inspectCode(project, workspace, result.revision).proof.exitCode, 256);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("Windows checks preserve the standard mixed-case Path environment", { skip: process.platform !== "win32" }, () => {
  const { home, repository, project } = fixture();
  try {
    const originalPath = process.env.PATH!;
    writeFileSync(
      join(repository, "check.mjs"),
      "import assert from 'node:assert/strict'; assert.ok(process.env.PATH === " +
        JSON.stringify(originalPath) +
        ", 'PATH must be preserved');\n",
    );
    execFileSync("git", ["-C", repository, "add", "."]);
    execFileSync(
      "git",
      [
        "-C",
        repository,
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.invalid",
        "commit",
        "-m",
        "mixed-case environment",
      ],
      { stdio: "ignore" },
    );
    const entry = new URL("../examples/recipes/goal-loop/code.ts", import.meta.url).href;
    const driver = join(home, "driver.mjs");
    writeFileSync(
      driver,
      `import assert from 'node:assert/strict';
import { codeWorkspace, applyChanges } from ${JSON.stringify(entry)};
assert.ok(Object.keys(process.env).includes('Path'));
const project = ${JSON.stringify(project)};
const workspace = codeWorkspace(project, ${JSON.stringify(join(home, "state"))}, 'mixed-case-path');
const result = await applyChanges(project, workspace, [{path:'sum.mjs', content:'export const sum = (a, b) => a + b;\\n'}]);
assert.equal(result.proof.passed, true);
`,
    );
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toLowerCase() !== "path"));
    execFileSync(process.execPath, [driver], {
      env: { ...env, Path: originalPath },
      timeout: 20000,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("acceptance entries must be declared files inside the candidate checkout", () => {
  const { home, project } = fixture();
  try {
    const other = join(home, "other-checkout");
    mkdirSync(other);
    const external = join(other, "check.mjs");
    writeFileSync(external, "process.exit(0);\n");
    const absolute = projectConfig({ ...project, code: { ...project.code, check: [process.execPath, external] } });
    assert.throws(() => codeWorkspace(absolute, join(home, "state"), "other-absolute"), /副本/);
    const expectedWorkspace = join(home, "state", "goal-code", project.id, "other-relative", "workspace");
    const escaping = projectConfig({
      ...project,
      code: { ...project.code, check: [process.execPath, relative(expectedWorkspace, external)] },
    });
    assert.throws(() => codeWorkspace(escaping, join(home, "state"), "other-relative"), /副本/);
    writeFileSync(join(project.code!.repository, "alternate.mjs"), "process.exit(0);\n");
    execFileSync("git", ["-C", project.code!.repository, "add", "."]);
    execFileSync(
      "git",
      [
        "-C",
        project.code!.repository,
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.invalid",
        "commit",
        "-m",
        "alternate entry",
      ],
      { stdio: "ignore" },
    );
    const undeclared = projectConfig({
      ...project,
      code: { ...project.code, check: [process.execPath, "alternate.mjs"] },
    });
    assert.throws(() => codeWorkspace(undeclared, join(home, "state"), "undeclared"), /验收/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("non-path option values remain literal while file options stay confined", async () => {
  const { home, project } = fixture();
  try {
    const config = projectConfig({
      ...project,
      code: { ...project.code, check: [process.execPath, "--test-name-pattern=/divide/i", "check.mjs"] },
    });
    const workspace = codeWorkspace(config, join(home, "state"), "option-value");
    const result = await applyChanges(config, workspace, [
      { path: "sum.mjs", content: "export const sum = (a, b) => a + b;\n" },
    ]);
    assert.equal(result.proof.passed, true);
    const external = projectConfig({
      ...project,
      code: { ...project.code, check: [process.execPath, `--import=${join(project.code!.repository, "check.mjs")}`] },
    });
    assert.throws(() => codeWorkspace(external, join(home, "state"), "external-option"), /原仓库/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("file URL options cannot load acceptance from another checkout", () => {
  const { home, project } = fixture();
  try {
    const config = projectConfig({
      ...project,
      code: {
        ...project.code,
        check: [
          process.execPath,
          `--import=${pathToFileURL(join(project.code!.repository, "check.mjs")).href}`,
          "check.mjs",
        ],
      },
    });
    assert.throws(() => codeWorkspace(config, join(home, "state"), "url-option"), /相对路径/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test(
  "acceptance symlink cannot declare generated Git metadata as baseline",
  { skip: process.platform === "win32" },
  () => {
    const { home, project, repository } = fixture();
    try {
      symlinkSync(".git/config", join(repository, "check-config"));
      execFileSync("git", ["-C", repository, "add", "check-config"]);
      execFileSync(
        "git",
        ["-C", repository, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "alias"],
        { stdio: "ignore" },
      );
      const config = projectConfig({
        ...project,
        code: { ...project.code, checkFiles: ["check.mjs", "check-config"] },
      });
      assert.throws(() => codeWorkspace(config, join(home, "state"), "git-metadata"), /main/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  },
);

test("candidate-local executable acceptance entry must be declared", () => {
  const { home, project } = fixture();
  try {
    // Keep another noneditable tracked file declared, so only the omitted executable causes rejection.
    const repository = project.code!.repository;
    writeFileSync(join(repository, "helper.mjs"), "export {};\n");
    execFileSync("git", ["-C", repository, "add", "."]);
    execFileSync(
      "git",
      ["-C", repository, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "helper"],
      { stdio: "ignore" },
    );
    const config = projectConfig({
      ...project,
      code: { ...project.code, check: ["./check.mjs"], checkFiles: ["helper.mjs"] },
    });
    assert.throws(() => codeWorkspace(config, join(home, "state"), "executable-entry"), /checkFiles/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
