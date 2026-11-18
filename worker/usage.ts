// A session's running total isn't what a launch used; how far the total rose during the launch is. The launch keeps
// where the total stood when it began, because a worker that stops after moving this file on reads that launch again.
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { HOME } from "../host/home.ts";
import type { Usage } from "./agents.ts";

const DIRECTORY = path.join(HOME, "worker", "usage");
const FIELDS = ["input", "output", "cached", "cost"] as const;
/** How long a session's baseline stays without being read: a session resumed weeks on still refreshes it. */
export const KEEP_DAYS = 14;

// A session's name comes from the agent program, so it isn't used as a file name.
const file = (adapter: string, session: string) => {
  const name = createHash("sha256")
    .update(JSON.stringify([adapter, session]))
    .digest("hex");
  return path.join(DIRECTORY, `${name}.json`);
};

export function loadUsage(adapter: string, session: string): Usage | undefined {
  try {
    const target = file(adapter, session);
    const found = JSON.parse(readFileSync(target, "utf8"));
    // Reading it means the session is still going: push its day of reckoning back.
    const now = new Date();
    utimesSync(target, now, now);
    return found;
  } catch {
    return undefined;
  }
}

export function saveUsage(adapter: string, session: string, usage: Usage) {
  mkdirSync(DIRECTORY, { recursive: true, mode: 0o700 });
  const target = file(adapter, session);
  writeFileSync(`${target}.tmp`, JSON.stringify(usage), { mode: 0o600 });
  renameSync(`${target}.tmp`, target);
}

/** Baselines no resume has asked about for longer than the runs are kept: one small file per session, forever otherwise. */
export function tidyUsage(moment = Date.now(), keepMs = KEEP_DAYS * 24 * 3600_000) {
  try {
    for (const name of readdirSync(DIRECTORY)) {
      const target = path.join(DIRECTORY, name);
      try {
        if (moment - statSync(target).mtimeMs > keepMs) rmSync(target, { force: true });
      } catch {}
    }
  } catch {
    // No directory yet is nothing to clear.
  }
}

/** With no idea where a total began, or one that fell, what the launch used is unknown: neither nothing nor everything. */
export function usageDelta(total: Usage, baseline: Usage | undefined): Usage | undefined {
  if (!baseline) return undefined;
  const rise: Usage = {};
  for (const field of FIELDS) {
    const now = total[field];
    const before = baseline[field];
    if (now === undefined || before === undefined) continue;
    if (now < before) return undefined;
    rise[field] = now - before;
  }
  return Object.keys(rise).length ? rise : undefined;
}
