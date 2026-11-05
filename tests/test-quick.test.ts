// `npm run test:quick` must select the same files without relying on a Unix shell. Failure cases: simulation or helper
// files run, order depends on the filesystem, an empty folder falls back to repository discovery, or failures are hidden.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { after, test } from "node:test";
import { quickTests } from "../scripts/test-quick.ts";

const dir = mkdtempSync(join(tmpdir(), "agent-autoloop-test-quick-"));
const script = join(import.meta.dirname, "..", "scripts", "test-quick.ts");
after(() => rmSync(dir, { recursive: true, force: true }));

const passing = `import test from "node:test"; test("passes", () => {});`;
const run = (folder: string) => {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", script, folder], {
    encoding: "utf8",
    env,
  });
};

test("quick tests are stable and leave simulation and helpers out", () => {
  const folder = join(dir, "passing tests 中文");
  mkdirSync(folder);
  writeFileSync(join(folder, "zeta.test.ts"), passing);
  writeFileSync(join(folder, "alpha.test.ts"), passing);
  writeFileSync(join(folder, "simulation.test.ts"), `throw new Error("simulation ran")`);
  writeFileSync(join(folder, "helper.ts"), `throw new Error("helper ran")`);

  assert.deepEqual(
    quickTests(folder).map((file) => basename(file)),
    ["alpha.test.ts", "zeta.test.ts"],
  );
  const done = run(folder);
  assert.equal(done.status, 0, done.stderr);
});

test("an empty selection is rejected and a test failure is returned", () => {
  const empty = join(dir, "empty");
  mkdirSync(empty);
  assert.throws(() => quickTests(empty), /no quick tests/i);

  const failing = join(dir, "failing");
  mkdirSync(failing);
  writeFileSync(join(failing, "failure.test.ts"), `throw new Error("expected failure")`);
  assert.notEqual(run(failing).status, 0);
});
