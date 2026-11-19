import { author, owned, type Read } from "./api.ts";
import { evidenceParts, type Text } from "./evidence.ts";
import { decimal, record, type Target } from "./input.ts";

const WINDOW = "50";
const LOCAL_REFERENCE = /(?<![a-z0-9_./#-])(?:([a-z0-9_.-]+\/[a-z0-9_.-]+))?#([1-9][0-9]{0,19})(?![0-9])/gi;

function mentions(issue: Target, value: Record<string, unknown>) {
  const text = [value.title, value.body].filter((text) => typeof text === "string").join("\n");
  const cleaned = text.replace(/https?:\/\/[^\s<>"']+/gi, " ");
  for (const [, repo, number] of cleaned.matchAll(LOCAL_REFERENCE)) {
    if (number === issue.number && (!repo || repo.toLowerCase() === issue.repo.toLowerCase())) return true;
  }
  return false;
}

async function recentPulls(read: Read, path: string) {
  const reply = await read(path, { state: "all", sort: "updated", direction: "desc", page: "1", per_page: WINDOW });
  const items = new Map<string, Record<string, unknown>>();
  if ("reason" in reply) return { items, reason: reply.reason };
  if (!Array.isArray(reply.value)) return { items, reason: "invalid_response" };
  let reason = reply.value.length > Number(WINDOW) ? "recent_window_exceeded" : undefined;
  for (const value of reply.value.slice(0, Number(WINDOW))) {
    const item = record(value);
    const id = decimal(item.number);
    if (!id || items.has(id)) reason ||= "invalid_response";
    else items.set(id, item);
  }
  return { items, reason };
}

function referenceFacts(candidates: Map<string, Record<string, unknown>>, target: Target, text: Text) {
  const matches = [...candidates].filter(([, item]) => mentions(target, item));
  matches.sort(([left], [right]) => left.length - right.length || left.localeCompare(right));
  const refs = matches.map(([number, item]) => ({
    number,
    relationship: "text_reference",
    state: text(item.state, 32).text,
    author: text(author(item), 64).text,
    link: `https://gitcode.com/${target.repo}/merge_requests/${number}`,
  }));
  const missingText = [...candidates.values()].some(
    ({ title, body }) => typeof title !== "string" || (body !== null && typeof body !== "string"),
  );
  return { refs, missingText };
}

function referenceCoverage(reason: string | undefined, covered: boolean) {
  if (!reason) return "complete";
  return covered ? "partial" : "failed";
}

export async function references(read: Read, target: Target, account: string, text: Text) {
  const path = `/repos/${target.repo}/pulls`;
  const mine = await owned(read, path, "author", account);
  const recent = await recentPulls(read, path);
  const candidates = new Map(mine.items.filter(({ owned }) => owned).map(({ id, item }) => [id, item]));
  for (const [id, item] of recent.items) if (!candidates.has(id)) candidates.set(id, item);
  const { refs, missingText } = referenceFacts(candidates, target, text);
  const reason = mine.reason || recent.reason || (missingText ? "reference_text_missing" : undefined);
  const covered = candidates.size > 0 || !recent.reason || !mine.reason;
  const coverage = referenceCoverage(reason, covered);
  return evidenceParts(
    {
      facet: "issue-references",
      scope: "own_and_latest_50",
      coverage,
      reason,
      ownCoverage: mine.coverage,
      recentReason: recent.reason,
    },
    "references",
    refs,
    8,
  );
}
