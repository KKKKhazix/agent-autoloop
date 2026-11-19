import { readFailure, record, type PageGap } from "./pages.ts";

const jobPageSize = 100;
export const maxJobPages = 10;

function integer(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function checkNumber(url: unknown, repo: string) {
  if (typeof url !== "string") return null;
  const parts = /^https:\/\/api\.github\.com\/repos\/([^/]+\/[^/]+)\/check-runs\/([1-9]\d*)$/i.exec(url);
  if (!parts || parts[1].toLowerCase() !== repo) return null;
  const number = Number(parts[2]);
  return integer(number) ? number : null;
}

type Failure = { gap: PageGap };

function jobEvidence(value: unknown, repo: string, runId: number, latestAttempt: number): [number, number] | null {
  const { run_id, run_attempt: attempt, check_run_url } = record(value);
  const id = checkNumber(check_run_url, repo);
  if (id === null || run_id !== runId || !integer(attempt) || attempt < 1 || attempt > latestAttempt) return null;
  return [id, attempt];
}

function parseJobs(value: unknown, repo: string, runId: number, latestAttempt: number) {
  const { total_count: total, jobs } = record(value);
  if (!integer(total) || total < 0 || !Array.isArray(jobs) || jobs.length > jobPageSize) return null;
  const entries: [number, number][] = [];
  for (const value of jobs) {
    const entry = jobEvidence(value, repo, runId, latestAttempt);
    if (!entry) return null;
    entries.push(entry);
  }
  return { total, entries };
}

function appendJobs(found: Map<number, number>, entries: [number, number][]) {
  for (const [id, attempt] of entries) {
    if (found.has(id)) return false;
    found.set(id, attempt);
  }
  return true;
}

export async function readAttempts(
  repo: string,
  runId: number,
  latestAttempt: number,
  read: (page: number) => Promise<unknown>,
): Promise<Map<number, number> | Failure> {
  const found = new Map<number, number>();
  let expected: number | undefined;
  for (let page = 1; page <= maxJobPages; page++) {
    let data: unknown;
    try {
      data = await read(page);
    } catch (error) {
      return { gap: readFailure(error) };
    }
    const parsed = parseJobs(data, repo, runId, latestAttempt);
    if (!parsed || (expected !== undefined && expected !== parsed.total)) return { gap: "invalid-response" };
    expected = parsed.total;
    if (!appendJobs(found, parsed.entries)) return { gap: "invalid-response" };
    if (found.size > expected) return { gap: "invalid-response" };
    if (found.size === expected) return found;
    if (parsed.entries.length < jobPageSize) return { gap: "invalid-response" };
  }
  return { gap: "truncated" };
}
