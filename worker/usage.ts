// Session totals are not per-launch usage. Keep the baseline on the launch entry so rereading a completed process after
// a crash uses the same subtraction, even if the session checkpoint was already advanced before the worker stopped.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { HOME } from "../host/home.ts";
import type { Usage } from "./agents.ts";

const directory = path.join(HOME, "worker", "usage");
const fields = ["input", "output", "cached", "cost"] as const;
const file = (adapter: string, session: string) =>
  path.join(
    directory,
    createHash("sha256")
      .update(JSON.stringify([adapter, session]))
      .digest("hex") + ".json",
  );

export function loadUsage(adapter: string, session: string): Usage | undefined {
  try {
    const value = JSON.parse(readFileSync(file(adapter, session), "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    if (fields.some((key) => value[key] !== undefined && (!Number.isFinite(value[key]) || value[key] < 0))) return;
    return value;
  } catch {
    return;
  }
}

export function saveUsage(adapter: string, session: string, usage: Usage) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const target = file(adapter, session);
  writeFileSync(target + ".tmp", JSON.stringify(usage), { mode: 0o600 });
  renameSync(target + ".tmp", target);
}

/** An unknown/reset baseline cannot honestly be reported as either zero or this launch's consumption. */
export function usageDelta(total: Usage, baseline: Usage | undefined): Usage | undefined {
  if (!baseline) return;
  const result: Usage = {};
  for (const key of fields) {
    const value = total[key];
    if (value === undefined || baseline[key] === undefined) continue;
    if (!Number.isFinite(value) || value < baseline[key]) return;
    result[key] = value - baseline[key];
  }
  return Object.keys(result).length ? result : undefined;
}
