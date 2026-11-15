import { spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { Job } from "../../../protocol/job.ts";
import { readMessage } from "../../../worker/contract.ts";

const title = "确认开发多站点后台";
const options = ["确认开工", "取消"];
const retryTitle = "开发未完成，怎么继续";
const retryOptions = ["保留原工作区，重新执行", "结束"];
const source = "feishu-operations";
const messageId = /^om_[A-Za-z0-9_-]{1,97}$/;

export function nextAction(context: Job["context"], owner: string) {
  const [event] = context.events;
  if (context.events.length !== 1 || event.source !== source || !messageId.test(event.subject))
    return { kind: "ignore" } as const;
  if (event.type === "operations.development" && event.id === event.subject && event.detail.trim())
    return { kind: "ask", detail: event.detail } as const;

  const [answer] = context.answers;
  const retry = answer?.title === retryTitle;
  const expectedOptions = retry ? retryOptions : options;
  if (
    event.type !== "card.answered" ||
    context.answers.length !== 1 ||
    event.id !== "card:" + answer.card ||
    !Number.isSafeInteger(answer.card) ||
    answer.card < 1 ||
    answer.by !== owner ||
    answer.title !== (retry ? retryTitle : title) ||
    answer.options.length !== expectedOptions.length ||
    !expectedOptions.every((option, index) => answer.options[index] === option) ||
    !answer.about.trim()
  )
    return { kind: "ignore" } as const;
  if (answer.choice === 1) return { kind: "cancel" } as const;
  if (answer.choice !== 0) return { kind: "ignore" } as const;
  return { kind: "develop", subject: event.subject, detail: answer.about, retry: retry ? answer.card : null } as const;
}

/** A failure waits for an explicit restart decision; it never schedules another attempt on its own. */
function blocked(heading: string, detail: string) {
  return `${heading}\n\n\`\`\`agent-autoloop\n${JSON.stringify({
    ask: [
      {
        title: retryTitle,
        text: "开发尚未完成，已有代码和日志已保留。重新执行会新建工作区，从项目基线重新开始；也可以结束后人工接手。",
        options: retryOptions,
        about: detail,
        key: "development-blocked",
      },
    ],
  })}\n\`\`\`\n`;
}

function main(path: string) {
  const { owner, workspaceRoot, runner } = JSON.parse(readFileSync(path, "utf8"));
  if (!/^ou_[A-Za-z0-9_-]+$/.test(owner) || !isAbsolute(workspaceRoot) || !isAbsolute(runner))
    throw new Error("Invalid development configuration");
  const action = nextAction(JSON.parse(readFileSync(process.env.AGENT_AUTOLOOP_CONTEXT!, "utf8")), owner);
  if (action.kind === "ask") {
    console.log("已发出开工确认，等待你的选择。\n\n```agent-autoloop");
    console.log(
      JSON.stringify({
        ask: [{ title, text: action.detail, options, about: action.detail, key: "approve-development" }],
      }),
    );
    console.log("```");
    return;
  }
  if (action.kind !== "develop") {
    console.log(action.kind === "cancel" ? "已取消开发需求。" : "没事可做：没有有效的开工确认。");
    return;
  }

  // A card decision authorizes one fresh attempt. Replaying that decision reuses its receipt, not the runner.
  const attempt = action.subject + (action.retry === null ? "" : ".retry-" + action.retry);
  const workspace = join(workspaceRoot, attempt);
  // Keep the worker's result outside the candidate workspace the model can edit.
  const receipt = join(workspaceRoot, attempt + ".result.txt");
  try {
    // One workspace per approved message. An interrupted attempt stays available for review, never runs twice.
    mkdirSync(workspace, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (existsSync(receipt)) {
      const saved = readFileSync(receipt, "utf8");
      // Older receipts closed failed work with an FYI. Add the missing decision without running the business again.
      const failed = /^(?:第 [1-9][0-9]* 轮 · )?开发或验证未通过(?:[，。\r\n]|$)/.test(saved);
      process.stdout.write(
        failed && !readMessage(saved).receipt?.ask
          ? blocked("待你处理：上次开发或验证未通过，已有工作区已保留。", action.detail)
          : saved,
      );
    } else process.stdout.write(blocked("待你处理：上次执行中断，已有工作区保留，尚未确认完成。", action.detail));
    return;
  }
  const request = join(workspace, "requirement.txt");
  writeFileSync(request, action.detail, { mode: 0o600, flag: "wx" });
  const log = openSync(join(workspace, "development.log"), "wx", 0o600);
  try {
    // The worker owns the deadline and stops the process group, including the runner's children.
    const result = spawnSync(runner, [workspace, request], { stdio: ["ignore", log, log] });
    const status = result.status === 0 ? "开发和定向验证通过" : "开发或验证未通过";
    const run = process.env.AGENT_AUTOLOOP_RUN;
    const heading = run && /^[1-9][0-9]*$/.test(run) ? `第 ${run} 轮 · ${status}` : status;
    const text = `${heading}\n本机工作区 ${workspace}\n开发日志 ${join(workspace, "development.log")}`;
    const body = { notice: [{ title: "多站点后台开发结果", text, fyi: true, key: "development-result" }] };
    const output =
      result.status === 0
        ? `${heading}\n\n\`\`\`agent-autoloop\n${JSON.stringify(body)}\n\`\`\`\n`
        : blocked(heading, action.detail);
    // A restart can repeat the worker turn after the local work finished. Preserve the exact terminal receipt.
    const pending = receipt + ".tmp";
    writeFileSync(pending, output, { mode: 0o600, flag: "wx" });
    renameSync(pending, receipt);
    process.stdout.write(output);
  } finally {
    closeSync(log);
  }
}

if (import.meta.main) main(process.argv[2]);
