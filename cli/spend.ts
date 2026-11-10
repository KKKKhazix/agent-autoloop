// The cost lines in `agent-autoloop status`, from /v1/state's completion-time totals. Agents report usage for themselves, or
// don't: a plain command says nothing, and some give tokens but no price. So every figure says how many rounds it leaves out.
import type { Spending } from "../host/state.ts";
import { localeTag, t } from "../host/i18n.ts";
const count = new Intl.NumberFormat(localeTag(), { notation: "compact", maximumFractionDigits: 1 });
/** To two places, a day on a cheap model would read as nothing at all. */
const dollars = (amount: number) => (amount > 0 && amount < 0.01 ? "<$0.01" : `$${amount.toFixed(2)}`);

function tally(label: string, { rounds, tokens, cost, missingTokens, missingCost }: Spending) {
  if (!rounds) return t('{"label"} 0 轮', { label });
  const missing = (silent: number) => (silent ? t('（{"n"} 轮没上报）', { n: silent }) : "");
  const shownTokens =
    missingTokens === rounds
      ? t("Token 没上报")
      : t('{"tokens"} Token{"missing"}', {
          tokens: count.format(tokens).replace(/(万|亿)/, " $1"),
          missing: missing(missingTokens),
        });
  const shownCost =
    missingCost === rounds
      ? t("费用没上报")
      : t('{"cost"}{"missing"}', { cost: dollars(cost), missing: missing(missingCost) });
  return t('{"label"} {"n"} 轮 · {"tokens"} · {"cost"}', { label, n: rounds, tokens: shownTokens, cost: shownCost });
}

/** Two lines, labels padded to the same terminal width so the figures line up. */
export function spendLines(spending: { today: Spending; week: Spending }) {
  return [tally(t("今天     "), spending.today), tally(t("最近 7 天"), spending.week)];
}
