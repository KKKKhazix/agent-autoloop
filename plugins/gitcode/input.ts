const SUBJECT =
  /^(?:gitcode|gc([1-9][0-9]{0,3})):([a-z0-9][a-z0-9_.-]*\/[a-z0-9][a-z0-9_.-]*):(pr|issue):(own|[1-9][0-9]{0,19})$/;
const REPO = /^[a-z0-9][a-z0-9_.-]*\/[a-z0-9][a-z0-9_.-]*$/i;
export const DISCOVER = "gitcode.discover.requested";
export const VERIFY = "gitcode.verify.requested";
export const SWEEP = "gitcode.sweep.requested";
export const FOLLOW = "gitcode.verify.discovered";
export const REQUEST_SOURCE = "gitcode-request";
export const OBSERVATION_SOURCE = "gitcode-observation";

export type Kind = "pr" | "issue";
export type Target = { repo: string; kind: Kind; number: string; subject: string; page: number };
export type Config = {
  account: string;
  repositories: ReadonlyMap<string, string>;
  targets: Target[];
  botIds: ReadonlySet<string>;
};

export function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function decimal(value: unknown) {
  if (typeof value !== "string" && !(typeof value === "number" && Number.isSafeInteger(value))) return null;
  return /^[1-9][0-9]{0,19}$/.test(String(value)) ? String(value) : null;
}

export function actorId(value: unknown) {
  return typeof value === "string" && /^[0-9a-f]{24}$/i.test(value) ? value.toLowerCase() : decimal(value);
}

function strings(value: unknown, limit: number, field: string, check: (item: string) => boolean): string[] {
  if (!Array.isArray(value) || value.length > limit || !value.every((item) => typeof item === "string" && check(item)))
    throw new Error(`GitCode 配置项 ${field} 无效`);
  return [...new Set(value)];
}

export function parseConfig(raw: unknown): Config {
  const { account, repositories, targets, botIds } = record(raw);
  if (typeof account !== "string" || !/^[a-z0-9][a-z0-9_.-]{0,63}$/i.test(account))
    throw new Error("GitCode 配置项 account 无效");
  const allowed = strings(repositories, 16, "repositories", (repo) => repo.length <= 65 && REPO.test(repo));
  if (!allowed.length) throw new Error("GitCode repositories 不能为空");
  const byName = new Map(allowed.map((repo) => [repo.toLowerCase(), repo]));
  const pinned = strings(targets ?? [], 50, "targets", () => true);
  return {
    account,
    repositories: byName,
    targets: pinned.map((subject) => requireTarget(subject, byName)),
    botIds: new Set(strings(botIds ?? [], 50, "botIds", (id) => actorId(id) !== null).map((id) => id.toLowerCase())),
  };
}

function requireTarget(subject: string, repositories: Config["repositories"]) {
  const target = parseTarget(subject, repositories, VERIFY);
  if (!target || target.page !== 1) throw new Error("GitCode 配置项 targets 无效");
  return target;
}

function parseTarget(value: unknown, allowed: Config["repositories"], type: string): Target | null {
  if (typeof value !== "string" || value.length > 100) return null;
  const match = SUBJECT.exec(value);
  if (!match) return null;
  const [, page, slug, kind, number] = match;
  if (page === "1" || (number === "own" ? ![DISCOVER, SWEEP].includes(type) : ![VERIFY, FOLLOW].includes(type)))
    return null;
  const repo = allowed.get(slug);
  return repo ? { repo, kind: kind === "pr" ? "pr" : "issue", number, subject: value, page: Number(page ?? 1) } : null;
}

export function scanSubject(target: Target, page = 1, number = target.number) {
  return `${page === 1 ? "gitcode" : `gc${page}`}:${target.repo.toLowerCase()}:${target.kind}:${number}`;
}

function requestMeta(detail: unknown) {
  try {
    return record(typeof detail === "string" ? JSON.parse(detail) : null);
  } catch {
    return {};
  }
}

export function readTarget(events: unknown[], config: Config) {
  let selected: Target | null = null;
  let auto = false;
  let scheduled = false;
  let scanRun: string | null = null;
  let hops = 0;
  for (const value of events) {
    const { source, type, subject, detail, hops: eventHops } = record(value);
    if (typeof type !== "string") return null;
    if (
      source === REQUEST_SOURCE
        ? ![DISCOVER, VERIFY, SWEEP].includes(type)
        : source !== OBSERVATION_SOURCE || ![SWEEP, FOLLOW].includes(type)
    )
      return null;
    const target = parseTarget(subject, config.repositories, type);
    if (!target || (selected && target.subject !== selected.subject)) return null;
    selected = target;
    const meta = requestMeta(detail);
    const planned =
      type === VERIFY &&
      meta.scheduled === true &&
      decimal(meta.scanRun) &&
      config.targets.some(({ subject }) => subject === target.subject);
    if (type === SWEEP || type === FOLLOW || planned) {
      auto = true;
      scheduled ||= meta.scheduled === true;
      scanRun ??= decimal(meta.scanRun);
    }
    if (typeof eventHops === "number" && Number.isInteger(eventHops)) hops = Math.max(hops, eventHops);
  }
  return selected ? { target: selected, auto, scheduled, scanRun, canFollow: hops < 7, canContinue: hops < 6 } : null;
}
