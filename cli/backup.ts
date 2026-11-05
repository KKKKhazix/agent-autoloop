// `backup` and `restore`: the database, the key that signs card links, and the files that say what this machine is.
// A backup is taken while the hub runs; a restore needs it stopped, because it replaces the file that is open.
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { runningUp } from "../host/service.ts";

const DB = "hub.db";
const KEY = "master.key";
const FILES = [KEY, "config.json", "rules.json", "secrets.env"] as const;
const KEY_SHAPE = /^[A-Za-z0-9_-]{43}$/;

/** A consistent copy of a database that's in use: VACUUM INTO reads it as of one point, WAL and all. */
function copyDatabase(from: string, to: string) {
  const source = new DatabaseSync(from);
  try {
    source.exec("PRAGMA busy_timeout=5000");
    // The path is a literal in VACUUM INTO; a quote in it is doubled, as SQLite does.
    source.exec(`VACUUM INTO '${to.replaceAll("'", "''")}'`);
  } finally {
    source.close();
  }
  chmodSync(to, 0o600);
}

/** Writes a backup folder nothing exists in yet: the database first, then whichever of the files are there. */
export function backup(home: string, target: string) {
  const database = path.join(home, DB);
  if (!existsSync(database)) throw new Error("还没装好：先运行 agent-autoloop init");
  if (existsSync(target) && readdirSync(target).length) throw new Error(`备份目录不是空的：${target}`);
  mkdirSync(target, { recursive: true, mode: 0o700 });
  copyDatabase(database, path.join(target, DB));
  const files: string[] = [DB];
  for (const name of FILES) {
    const from = path.join(home, name);
    if (!existsSync(from)) continue;
    copyFileSync(from, path.join(target, name));
    chmodSync(path.join(target, name), 0o600);
    files.push(name);
  }
  return { target, files };
}

function readableBackup(source: string) {
  const database = path.join(source, DB);
  const key = path.join(source, KEY);
  if (!existsSync(database) || !existsSync(key)) throw new Error(`这个目录不像备份：缺 ${DB} 或 ${KEY}`);
  if (!KEY_SHAPE.test(readFileSync(key, "utf8").trim())) throw new Error("备份里的 master.key 坏了");
  const check = new DatabaseSync(database, { readOnly: true });
  try {
    const result = check.prepare("PRAGMA integrity_check").get();
    if (!result || Object.values(result)[0] !== "ok") throw new Error("备份里的 hub.db 读不出来");
  } finally {
    check.close();
  }
}

/** Puts a backup back in place, keeping what it replaced. The caller makes sure the hub is stopped. */
export function restore(home: string, source: string, running = runningUp) {
  if (running() !== null) {
    throw new Error("中台还在跑：先停掉它（例如 agent-autoloop service remove，或手动停服务），再恢复");
  }
  readableBackup(source);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const safety = path.join(home, `restore-before-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  mkdirSync(safety, { recursive: true, mode: 0o700 });
  // The WAL belongs to the file that's leaving: a stale one next to the restored database would be applied to it.
  for (const name of [DB, `${DB}-wal`, `${DB}-shm`, ...FILES]) {
    const from = path.join(home, name);
    if (existsSync(from)) renameSync(from, path.join(safety, name));
  }
  try {
    for (const name of [DB, ...FILES]) {
      const from = path.join(source, name);
      if (!existsSync(from)) continue;
      copyFileSync(from, path.join(home, name));
      chmodSync(path.join(home, name), 0o600);
    }
  } catch (error) {
    // Half a restore is worse than none: what this replaced goes back.
    for (const name of [DB, ...FILES]) {
      const saved = path.join(safety, name);
      if (existsSync(saved)) copyFileSync(saved, path.join(home, name));
    }
    throw error;
  }
  return { safety };
}
