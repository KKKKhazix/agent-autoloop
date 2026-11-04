// try 的轮询判定：只认这一次触发之后新出现的 run 和卡片。
// 之前跑过的 run 会一直留在 queued + attempts>0，卡片也会留在列表里，不排掉就会一进来就
// 报上一次的旧错，或者把上一轮的试跑卡片当成这一次的问题。

export type TryRun = {
  id: number;
  rule: string;
  state: string;
  attempts: number;
  error: string;
};

export type TryCard = {
  id: number;
  kind: string;
  title: string;
};

/** 这一次触发之后新出现的失败 run；没有就是 null。 */
export function newFailure(runs: TryRun[], seen: Set<number>): TryRun | null {
  return (
    runs.find((run) => !seen.has(run.id) && run.rule === "试一下" && run.state === "queued" && run.attempts > 0) ?? null
  );
}

/** 这一次触发之后新出现的试跑卡片；没有就是 null。 */
export function newAskCard<C extends TryCard>(cards: C[], seen: Set<number>): C | null {
  return cards.find((card) => !seen.has(card.id) && card.kind === "ask" && card.title.startsWith("试跑")) ?? null;
}

/** 记下现在已有的 id，之后只认不在里面的。 */
export function snapshot(ids: { id: number }[] | undefined): Set<number> {
  return new Set((ids ?? []).map((item) => item.id));
}
