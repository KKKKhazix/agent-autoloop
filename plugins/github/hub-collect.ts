import { readFileSync } from "node:fs";
import { collectGitHub, parseGitHubRequest, type GitHubRead } from "./collector.ts";
import { githubReceipt } from "./receipt.ts";

type Request = { repo: string } & (
  { mode: "discover"; author: string } | { mode: "verify"; kind: "issue" | "pr"; number: number }
);

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function scope(config: unknown) {
  const request = parseGitHubRequest({ ...record(config), mode: "discover" });
  if (request.mode !== "discover") throw new Error("invalid GitHub scope");
  return { repo: request.repo, author: request.author };
}

function manualTarget(value: unknown, repo: string): Request | null {
  const match = typeof value === "string" ? /^github:([^:]+):(issue|pr):([1-9]\d*)$/.exec(value) : null;
  if (!match || match[1].toLowerCase() !== repo) return null;
  const number = Number(match[3]);
  if (!Number.isSafeInteger(number) || number > 2_147_483_647) return null;
  return { mode: "verify", repo, kind: match[2] === "issue" ? "issue" : "pr", number };
}

export function githubHubRequests(config: unknown, context: unknown) {
  const { repo, author } = scope(config);
  const { events } = record(context);
  if (!Array.isArray(events)) throw new Error("invalid Hub context");
  const unique = new Map<string, Request>();
  let rejected = 0;
  for (const value of events) {
    const { source, type, subject } = record(value);
    let request: Request | null = null;
    if (source === "schedule" && type === "schedule.tick" && subject === "")
      request = { mode: "discover", repo, author };
    if (source === "schedule" && type === "run.manual") request = manualTarget(subject, repo);
    if (source === "github-request" && type === "github.verify.requested") request = manualTarget(subject, repo);
    if (request) unique.set(JSON.stringify(request), request);
    else rejected++;
  }
  return { requests: [...unique.values()], rejected };
}

export async function runGitHubHubCollection(config: unknown, context: unknown, read?: GitHubRead) {
  const { requests, rejected } = githubHubRequests(config, context);
  const batches: Awaited<ReturnType<typeof collectGitHub>>[] = [];
  for (const request of requests) batches.push(await collectGitHub(request, read));
  const status = !batches.length
    ? "rejected"
    : !rejected && batches.every((batch) => batch.status === "complete")
      ? "complete"
      : batches.every((batch) => batch.status === "failed")
        ? "failed"
        : "partial";
  return { version: 1, status, rejected, batches } as const;
}

if (import.meta.main) {
  try {
    const config = JSON.parse(process.argv[2] ?? "null");
    const context = JSON.parse(readFileSync(process.env.AGENT_AUTOLOOP_CONTEXT ?? "", "utf8"));
    const result = await runGitHubHubCollection(config, context);
    const summary = {
      complete: "GitHub 采集完整",
      partial: "GitHub 采集部分覆盖",
      failed: "GitHub 采集失败",
      rejected: "GitHub 采集请求被拒绝",
    };
    if (process.argv[3] === "--receipt") {
      const events = githubReceipt(result, process.env.AGENT_AUTOLOOP_RUN ?? "");
      const status = events.length === 1 ? "partial" : result.status;
      process.stdout.write(`${summary[status]}\n\n\`\`\`agent-autoloop\n${JSON.stringify({ events })}\n\`\`\`\n`);
    } else {
      process.stdout.write(`${summary[result.status]}\n${JSON.stringify(result)}\n`);
    }
  } catch {
    process.stderr.write("GitHub Hub command could not read its configuration or context\n");
    process.exitCode = 2;
  }
}
