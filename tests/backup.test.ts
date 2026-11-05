// Failure modes: a backup taken from a database in use is inconsistent; a restore leaves the old WAL beside the new
// database; a broken master.key is restored; a failed restore loses what it replaced; restoring runs with the hub up.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { setup } from "./helpers.ts";

const home = setup("backup");
// Imported after setup: the module reads AGENT_AUTOLOOP_HOME when it loads, for the "is the hub running?" check.
const { backup, restore } = await import("../cli/backup.ts");
const dbFile = join(home, "hub.db");
const keyFile = join(home, "master.key");
const key = "k".repeat(43);
const mode = (file: string) => statSync(file).mode & 0o777;
const cli = async (...args: string[]) =>
  (
    await promisify(execFile)(
      process.execPath,
      ["--disable-warning=ExperimentalWarning", join(import.meta.dirname, "../bin/agent-autoloop.ts"), ...args],
      { env: { ...process.env } },
    )
  ).stdout;

function makeHome() {
  const db = new DatabaseSync(dbFile);
  db.exec(
    "CREATE TABLE IF NOT EXISTS facts(seq INTEGER PRIMARY KEY, fact TEXT NOT NULL); DELETE FROM facts; INSERT INTO facts VALUES (1, 'one');",
  );
  db.close();
  writeFileSync(keyFile, `${key}\n`, { mode: 0o600 });
  writeFileSync(join(home, "config.json"), '{"url":"http://127.0.0.1:1"}', { mode: 0o600 });
  writeFileSync(join(home, "rules.json"), '{"sources":{},"agents":{},"rules":[]}');
}

test("a backup holds a consistent database and the files that make this machine", () => {
  makeHome();
  const target = join(home, "snap-one");
  const { files } = backup(home, target);
  assert.deepEqual(files.sort(), ["config.json", "hub.db", "master.key", "rules.json"].sort());
  assert.equal(mode(join(target, "hub.db")), 0o600);
  assert.equal(mode(join(target, "master.key")), 0o600);
  const backupDb = new DatabaseSync(join(target, "hub.db"));
  try {
    assert.equal(backupDb.prepare("SELECT fact FROM facts WHERE seq=1").get()!.fact, "one");
  } finally {
    backupDb.close();
  }
  assert.equal(readFileSync(join(target, "master.key"), "utf8").trim(), key);
  assert.throws(() => backup(home, target), /不是空的/);
});

test("a restore puts the backup back and keeps what it replaced", () => {
  makeHome();
  const target = join(home, "snap-two");
  backup(home, target);
  const live = new DatabaseSync(dbFile);
  live.exec("DELETE FROM facts");
  live.close();
  writeFileSync(keyFile, `${"z".repeat(43)}\n`, { mode: 0o600 });
  // A WAL that belonged to the file being replaced must not be applied to the restored one.
  writeFileSync(join(home, "hub.db-wal"), "stale");
  const { safety } = restore(home, target);
  assert.ok(existsSync(safety));
  assert.ok(!existsSync(join(home, "hub.db-wal")));
  const restored = new DatabaseSync(dbFile);
  try {
    assert.equal(restored.prepare("SELECT COUNT(*) AS n FROM facts").get()!.n, 1);
  } finally {
    restored.close();
  }
  assert.equal(readFileSync(keyFile, "utf8").trim(), key);
  assert.ok(existsSync(join(safety, "hub.db")), "what it replaced is kept");
});

test("a restore refuses a backup whose key or database is broken", () => {
  makeHome();
  const bad = join(home, "bad-backup");
  mkdirSync(bad);
  copyFileSync(dbFile, join(bad, "hub.db"));
  writeFileSync(join(bad, "master.key"), "short");
  assert.throws(() => restore(home, bad), /master\.key 坏了/);
});

test("restoring refuses while the hub is up", () => {
  makeHome();
  const target = join(home, "snap-run");
  backup(home, target);
  // `ps` is not available in every test sandbox, so the check goes through the same seam the CLI does.
  assert.throws(() => restore(home, target, () => 12345), /中台还在跑/);
  assert.ok(existsSync(join(home, "hub.db")));
});

test("the command writes a backup where it is told, and refuses a folder that isn't empty", async () => {
  makeHome();
  const target = join(home, "cli-snap");
  assert.match(await cli("backup", target), /备份好了/);
  assert.ok(existsSync(join(target, "hub.db")));
  await assert.rejects(cli("backup", target), /不是空的/);
});

test("restore takes --yes before or after the folder", async () => {
  makeHome();
  const target = join(home, "cli-restore");
  await cli("backup", target);
  const live = new DatabaseSync(dbFile);
  live.exec("DELETE FROM facts");
  live.close();
  // `--yes` first: the folder is its value, not a position after the flag.
  assert.match(await cli("restore", "--yes", target), /恢复好了/);
  const restored = new DatabaseSync(dbFile);
  try {
    assert.equal(restored.prepare("SELECT COUNT(*) AS n FROM facts").get()!.n, 1);
  } finally {
    restored.close();
  }
});
