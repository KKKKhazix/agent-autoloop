// An invalid report destination must fail before opening a hub or starting a model, without leaving temporary state.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";

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
