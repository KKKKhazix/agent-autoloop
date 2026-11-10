// What `try` goes by. A run comes back to queued only by failing, and stays there until its retry, taking in any new
// event of its rule meanwhile: so the same run can be this try's, and only attempts tell an old failure from a new one.
import { t } from "../host/i18n.ts";

export type TryRun = { id: number; rule: string; state: string; attempts: number; error: string; notBefore: string };

// The rule name as it was written into rules.json — which starterRules localises, so compare in the same language.
const failed = (run: TryRun) => run.rule === t("试一下") && run.state === "queued" && run.attempts > 0;

/** A run still waiting for its retry as this try starts. */
export const waitingRetry = (runs: TryRun[]) => runs.find(failed);

export const attemptsOf = (runs: TryRun[]) => new Map(runs.map((run) => [run.id, run.attempts]));

/** A run that has failed since those attempts were counted. */
export const newFailure = (runs: TryRun[], before: Map<number, number>) =>
  runs.find((run) => failed(run) && run.attempts > (before.get(run.id) ?? 0));
