// Model output supplies data for a fixed product check. It cannot select a command or provide executable code.
export function reproduction(input) {
  if (
    !input ||
    Object.keys(input).length !== 3 ||
    input.probe !== "history-row-width" ||
    typeof input.rule !== "string" ||
    !/^[\p{L}\p{N}\p{P} ]{1,240}$/u.test(input.rule) ||
    !Number.isInteger(input.columns) ||
    input.columns < 40 ||
    input.columns > 160
  )
    throw new Error("巡检复现参数不受支持");
  return { probe: input.probe, rule: input.rule, columns: input.columns };
}

export function confirmReproduction(input, observed) {
  if (!Number.isSafeInteger(observed) || observed < 1) throw new Error("复现未返回有效的显示宽度");
  return observed > input.columns ? { expected: input.columns, observed } : null;
}

export const historyWidthProgram = `
import { readFileSync } from "node:fs";
import { runsText } from "./cli/runs.ts";
import { width } from "./cli/status.ts";
const {rule, columns} = JSON.parse(readFileSync(0, "utf8"));
const now = "2026-11-10T02:00:00.000Z";
const state = {now, timezone: "Asia/Shanghai"};
const run = {id: 1, rule, state: "done", finishedAt: now, summary: "完成", error: ""};
const line = runsText({state, runs: [run], more: null}, {color: false, columns}).split("\\n")[0];
console.log(JSON.stringify(width(line)));
`;

export function replayHistoryWidth(command, codex, cwd, env, input) {
  const stdout = command(
    codex,
    [
      "sandbox",
      "--permission-profile",
      ":workspace",
      "--sandbox-state-disable-network",
      "-C",
      cwd,
      "--",
      process.execPath,
      "--disable-warning=ExperimentalWarning",
      "--input-type=module",
      "-e",
      historyWidthProgram,
    ],
    { cwd, env, input: JSON.stringify(input), timeout: 15_000, maxBuffer: 64 * 1024 },
  );
  return confirmReproduction(input, JSON.parse(stdout));
}
