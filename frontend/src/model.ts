import type { Fact, Run } from "./types/console.ts";
export const labels: Record<string, string> = {
  claimed: "执行中",
  queued: "排队中",
  done: "已完成",
  nothing: "无事可做",
  cancelled: "已停止",
  unknown: "不确定",
};
/** Keep previously loaded pages while replacing newer rows by ID. */
export function mergeRuns(previous: Run[], current: Run[]): Run[] {
  return [...new Map([...previous, ...current].map((run) => [run.id, run])).values()].sort((a, b) => b.id - a.id);
}
/** Never turn untrusted text into executable link schemes. */
export function safeLink(value: string): string {
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) ? value : "";
  } catch {
    return "";
  }
}
/** Only display row changes truly related to this run, its events and its cards. */
export function timeline(facts: Fact[], id: number): Fact[] {
  const eventIds = new Set(
    facts.flatMap((f) =>
      f.changes
        .filter((c) => c.table === "run_events" && Number(c.row?.run_id) === id)
        .map((c) => Number(c.row?.event_id)),
    ),
  );
  const cardIds = new Set(
    facts.flatMap((f) =>
      f.changes
        .filter(
          (c) => c.table === "cards" && (Number(c.row?.run_id) === id || eventIds.has(Number(c.row?.answer_event))),
        )
        .map((c) => Number(c.row?.id)),
    ),
  );
  return facts
    .map((f) => ({
      ...f,
      changes: f.changes.filter((c) =>
        c.table === "runs"
          ? Number(c.row?.id ?? c.key) === id
          : c.table === "events"
            ? eventIds.has(Number(c.row?.id ?? c.key))
            : c.table === "cards"
              ? cardIds.has(Number(c.row?.id ?? c.key))
              : c.table === "run_events" && Number(c.row?.run_id) === id,
      ),
    }))
    .filter((f) => f.changes.length > 0);
}
export function time(value: string | number | null | undefined): string {
  return value
    ? new Date(value).toLocaleString("zh-CN", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      })
    : "—";
}

/** Refresh a retained run from its latest full projection, not from an inferred terminal state. */
export function runFromFacts(previous: Run, facts: Fact[]): Run {
  const row = facts
    .filter((f) => f.changes.some((c) => c.table === "runs" && Number(c.row?.id ?? c.key) === previous.id))
    .sort((a, b) => b.seq - a.seq)[0]
    ?.changes.filter((c) => c.table === "runs" && Number(c.row?.id ?? c.key) === previous.id)
    .at(-1)?.row;
  if (!row) throw new Error("未能读取轮次的最新状态，请刷新重试。");
  return {
    ...previous,
    state: String(row.state),
    summary: String(row.summary ?? ""),
    error: String(row.error ?? ""),
    attempts: Number(row.attempts),
    stopping: row.cancel_at !== null,
    usage: row.usage ? JSON.parse(String(row.usage)) : null,
    createdAt: String(row.created_at ?? previous.createdAt),
    claimedAt: row.claimed_at == null ? null : String(row.claimed_at),
    finishedAt: row.finished_at == null ? null : String(row.finished_at),
    notBefore: String(row.not_before ?? previous.notBefore),
    rule: String(row.rule ?? previous.rule),
    agent: String(row.agent ?? previous.agent),
    session: row.session == null ? null : String(row.session),
    link: String(row.link ?? ""),
  };
}

export const factTitles: Record<string, string> = {
  claimNext: "领取任务",
  finish: "交回结果",
  answer: "收到回答",
  ingest: "收到事件",
  started: "开始执行",
  cancel: "请求停止",
  resolve: "卡片结案",
  rules: "规则更新",
  tick: "到期处理",
  heartbeat: "执行端报到",
  channelSeen: "通道报到",
  addKey: "接入授权",
  delivered: "卡片送达",
};
