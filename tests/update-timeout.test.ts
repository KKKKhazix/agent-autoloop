// Failure modes: a git that never answers hangs agent-autoloop update instead of failing.
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { updateCode } from "../cli/update.ts";

test("a git that never answers fails the update instead of hanging it", () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-autoloop-update-timeout-"));
  const git = join(dir, "git");
  writeFileSync(git, "#!/bin/sh\nsleep 2\n", { mode: 0o755 });
  chmodSync(git, 0o755);
  const before = process.env.PATH;
  process.env.PATH = `${dir}:${before}`;
  const start = Date.now();
  try {
    assert.throws(() => updateCode(dir, 100), /超时/);
    assert.ok(Date.now() - start < 2000, "it waited for the timeout, not the git");
  } finally {
    process.env.PATH = before;
    rmSync(dir, { recursive: true, force: true });
  }
});
