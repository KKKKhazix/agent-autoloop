export type Data = Record<string, unknown>;
export type PageGap = "read-failed" | "budget-exhausted" | "invalid-response" | "truncated" | "object-changed";
export type PageResult = { page: unknown } | { gap: PageGap };

export class ReadBudgetExhausted extends Error {}

export function readFailure(error: unknown): PageGap {
  return error instanceof ReadBudgetExhausted ? "budget-exhausted" : "read-failed";
}

export function record(value: unknown): Data {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Data) : {};
}

export const maxConnectionPages = 10;

function page(value: unknown) {
  const { nodes, pageInfo, totalCount } = record(value);
  const { hasNextPage, endCursor } = record(pageInfo);
  if (!Array.isArray(nodes) || typeof hasNextPage !== "boolean") return null;
  if (typeof totalCount !== "number" || !Number.isSafeInteger(totalCount) || totalCount < 0) {
    return null;
  }
  return { nodes, hasNextPage, totalCount, cursor: typeof endCursor === "string" && endCursor ? endCursor : null };
}

function nodeKey(value: unknown) {
  const { id, path } = record(value);
  return JSON.stringify(id ?? path ?? value);
}

type Page = NonNullable<ReturnType<typeof page>>;

function addPage(value: unknown, expected: Page["totalCount"], seen: Map<string, unknown>): Page | null {
  const next = page(value);
  if (!next || !next.nodes.length || expected !== next.totalCount) return null;
  const additional = new Map(next.nodes.map((node) => [nodeKey(node), node]));
  if (additional.size !== next.nodes.length || [...additional.keys()].some((key) => seen.has(key))) return null;
  for (const [key, node] of additional) seen.set(key, node);
  return next;
}

export async function cursorPages(initial: unknown, read: (cursor: string) => Promise<PageResult>) {
  const first = page(initial);
  if (!first) return { value: null, gap: null };
  const seen = new Map(first.nodes.map((node) => [nodeKey(node), node]));
  const visited = new Set<string>();
  let current = first;
  let gap: PageGap | null = seen.size === first.nodes.length ? null : "invalid-response";
  for (let count = 1; !gap && current.hasNextPage; count++) {
    const cursor = current.cursor;
    if (!cursor || count >= maxConnectionPages) {
      gap = "truncated";
      break;
    }
    if (visited.has(cursor)) {
      gap = "invalid-response";
      break;
    }
    visited.add(cursor);
    const result = await read(cursor);
    if ("gap" in result) {
      gap = result.gap;
      break;
    }
    const next = addPage(result.page, first.totalCount, seen);
    if (!next) {
      gap = "invalid-response";
      break;
    }
    current = next;
  }
  if (!gap && seen.size !== first.totalCount) gap = "invalid-response";
  return { value: { nodes: [...seen.values()], pageInfo: { hasNextPage: false } }, gap };
}
