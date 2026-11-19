import type { Text } from "./evidence.ts";

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function numericEntity(name: string, fallback: string) {
  const hex = name[1].toLowerCase() === "x";
  const code = Number.parseInt(name.slice(hex ? 2 : 1), hex ? 16 : 10);
  return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code).toWellFormed() : fallback;
}

function decodeEntity(entity: string, name: string) {
  if (name[0] === "#") return numericEntity(name, entity);
  return Object.hasOwn(ENTITIES, name) ? ENTITIES[name] : entity;
}

function cellText(cell: string) {
  return cell
    .replace(/<[^>]+>/g, " ")
    .replace(/&([a-z]+|#[0-9]+|#x[0-9a-f]+);/gi, decodeEntity)
    .replace(/\s+/g, " ")
    .trim();
}

function firstMatch(pattern: RegExp, value: string) {
  const match = pattern.exec(value);
  return match ? match[1] : null;
}

function publicLink(href: string) {
  try {
    const url = new URL(href);
    if (url.protocol !== "https:" || `${url.username}${url.password}`) return null;
    url.search = "";
    return url.href.length <= 360 ? url.href : null;
  } catch {
    return null;
  }
}

function reportLink(raw: string | undefined, text: Text) {
  if (!raw) return null;
  const href = firstMatch(/\bhref\s*=\s*["']([^"']+)["']/i, raw);
  const link = href && publicLink(href);
  return link ? text(link, 360).text : null;
}

function checkRow(row: string, text: Text) {
  const cells = [...row.matchAll(/<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]\s*>/gi)].map(([, value]) => value);
  if (cells.length < 2) return null;
  const name = cellText(cells[0]);
  if (!name || name === "任务名称") return null;
  const status = cellText(cells[1])
    .replace(/[✅❌]/gu, "")
    .trim();
  return {
    name: text(name, 120).text,
    status: text(status, 48).text,
    link: reportLink(cells[2], text),
  };
}

export function ciReport(body: string, text: Text) {
  const sample = body.slice(0, 64_000);
  const running = /the pipeline\([^)]*\)\s+is running/i.test(sample);
  const table = /<table\b/i.exec(sample);
  if (!table && !running) return undefined;
  const fragment = table ? sample.slice(table.index) : "";
  const rows = [...fragment.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr\s*>/gi)].flatMap(([, value]) => {
    const row = checkRow(value, text);
    return row ? [row] : [];
  });
  return {
    signal: running ? "running" : "report",
    checks: rows,
    inputTruncated: sample.length < body.length,
  };
}

export function reviewSummary(body: string) {
  if (!body.includes("<!-- dev-reviewer:review-summary -->")) return undefined;
  const verdict = firstMatch(/总体判定\s*[:：]\s*([a-z]{1,32})\b/i, body);
  const mustFix = firstMatch(/必须修复（Must Fix）\s*[:：]\s*([0-9]{1,12})\b/, body);
  return verdict || mustFix ? { verdict, mustFix } : undefined;
}
