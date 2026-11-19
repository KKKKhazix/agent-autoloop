import { decimal, record } from "./input.ts";

const BASE = "https://api.gitcode.com/api/v5";
const PAGE_SIZE = 20;
const MAX_PAGES = 4;

type Reply = { value: unknown } | { reason: string };
export type Read = (path: string, query?: Record<string, string>) => Promise<Reply>;
export type Options = { token: string; fetcher?: typeof fetch; now?: () => string };

export function reader({ token, fetcher = fetch }: Options): Read {
  return async (path, query) => {
    const url = new URL(path.startsWith("/v8/") ? `https://api.gitcode.com/api${path}` : BASE + path);
    url.search = new URLSearchParams(query).toString();
    let response: Response;
    try {
      response = await fetcher(url, {
        method: "GET",
        redirect: "error",
        signal: AbortSignal.timeout(8_000),
        headers: { accept: "application/json", "private-token": token },
      });
    } catch {
      return { reason: "network_error" };
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      return { reason: `http_${response.status}` };
    }
    try {
      return { value: await response.json() };
    } catch {
      return { reason: "invalid_response" };
    }
  };
}

export async function checkAccount(read: Read, account: string) {
  const identity = await read("/user");
  if ("reason" in identity) return identity.reason;
  return login(record(identity.value))?.toLowerCase() === account.toLowerCase() ? null : "account_mismatch";
}

export function login(person: Record<string, unknown>) {
  return typeof person.login === "string" && person.login ? person.login : null;
}

export function author(value: Record<string, unknown>) {
  return login(record(value.user)) || login(record(value.author));
}

export function owned(read: Read, path: string, filter: "author" | "creator", account: string, startPage = 1) {
  return pages(
    read,
    path,
    { state: "all", [filter]: account },
    (value) => {
      const item = record(value);
      const id = decimal(item.number);
      const owner = author(item);
      return id && owner ? { id, owned: owner.toLowerCase() === account.toLowerCase(), item } : null;
    },
    PAGE_SIZE,
    startPage,
  );
}

type Identified = { id: string };
async function pageItems(read: Read, path: string, query: Record<string, string>, page: number, size: number) {
  const result = await read(path, { ...query, per_page: String(size), page: String(page) });
  if ("reason" in result) return result;
  return Array.isArray(result.value) ? { values: result.value } : { reason: "invalid_response" };
}

function pageResult<Item>(found: Map<string, Item>, reason?: string, nextPage?: number) {
  const coverage = !reason ? "complete" : found.size ? "partial" : "failed";
  return { items: [...found.values()], coverage, ...(reason ? { reason } : {}), ...(nextPage ? { nextPage } : {}) };
}

export async function pages<Item extends Identified>(
  read: Read,
  path: string,
  query: Record<string, string>,
  parse: (value: unknown) => Item | null,
  size = PAGE_SIZE,
  startPage = 1,
) {
  const found = new Map<string, Item>();
  const endPage = startPage + MAX_PAGES;
  for (let page = startPage; page < endPage; page += 1) {
    const result = await pageItems(read, path, query, page, size);
    if ("reason" in result) return pageResult(found, result.reason);
    if (!result.values.length) return pageResult(found);
    const problem = addPage(found, result.values, parse, size);
    if (problem) return pageResult(found, problem);
  }
  return pageResult(found, "page_limit", endPage <= 9999 ? endPage : undefined);
}

function addPage<Item extends Identified>(
  found: Map<string, Item>,
  values: unknown[],
  parse: (input: unknown) => Item | null,
  size: number,
) {
  let problem = values.length > size ? "page_size_exceeded" : null;
  for (const value of values.slice(0, size)) {
    const item = parse(value);
    if (!item) problem ??= "invalid_response";
    else if (found.has(item.id)) problem ??= "pagination_overlap";
    else found.set(item.id, item);
  }
  return problem;
}
