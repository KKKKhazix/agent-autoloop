import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";

const defaultTests = join(import.meta.dirname, "..", "tests");

export function quickTests(folder = defaultTests): string[] {
  const files = readdirSync(folder)
    .filter((name) => name.endsWith(".test.ts") && name !== "simulation.test.ts")
    .sort()
    .map((name) => join(folder, name));
  if (!files.length) throw new Error(`no quick tests found in ${folder}`);
  return files;
}

export function runQuickTests(folder = defaultTests): number {
  const done = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", "--test", ...quickTests(folder)], {
    stdio: "inherit",
  });
  if (done.error) throw done.error;
  return done.status ?? 1;
}

if (import.meta.main) process.exitCode = runQuickTests(process.argv[2]);
