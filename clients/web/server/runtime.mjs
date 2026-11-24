// One console per install home: the file lets a second double-click hand the browser to the console already running, and
// lets stop.cmd close that console instead of guessing by port or process name. Only its own process number is written,
// so a number reused after a crash is checked against the session before anything is closed.
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HOME } from "../../../host/home.ts";

export const RUNTIME_FILE = join(HOME, "web-client.json");

export function readRuntime() {
  try {
    const value = JSON.parse(readFileSync(RUNTIME_FILE, "utf8"));
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

export function writeRuntime(value) {
  writeFileSync(RUNTIME_FILE, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

export function clearRuntime(pid) {
  const value = readRuntime();
  if (value && (pid === undefined || value.pid === pid)) rmSync(RUNTIME_FILE, { force: true });
}

/** The console that answers with the session in the file: a stale file from a dead process is removed on the way. */
export async function runningClient() {
  const value = readRuntime();
  if (
    !value ||
    !Number.isInteger(value.pid) ||
    typeof value.url !== "string" ||
    typeof value.session !== "string"
  )
    return null;
  let url;
  try {
    url = new URL(value.url);
  } catch {
    clearRuntime(value.pid);
    return null;
  }
  const answers = await fetch(new URL("/api/local", url), {
    headers: { "x-autoloop-session": value.session },
    signal: AbortSignal.timeout(1500),
  }).then(
    (response) => response.ok,
    () => false,
  );
  if (answers) return value;
  let alive = true;
  try {
    process.kill(value.pid, 0);
  } catch (error) {
    alive = error.code === "EPERM";
  }
  if (!alive) clearRuntime(value.pid);
  return null;
}
