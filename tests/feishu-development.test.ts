// A message or a free-text response must never authorize code changes.
// A failed runner must leave an actionable card, replay it without repeating work, and restart only after explicit approval.
import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nextAction } from "../examples/recipes/feishu-intake/development.ts";
import type { Job } from "../protocol/job.ts";
import { readMessage } from "../worker/contract.ts";

// This runner fixture executes /bin/sh; Windows process behavior has its native suite in windows.test.ts.
const unixTest = process.platform === "win32" ? test.skip : test;

test("only a confirmed answer for the same Feishu task starts development", () => {
  const request = { source: "feishu-operations", id: "om_first", subject: "om_first", detail: "停用站点查询" };
  const event = { ...request, type: "operations.development" };
  const reply = { ...request, id: "card:3", type: "card.answered" };
  const answer = {
    card: 3,
    title: "确认开发多站点后台",
    options: ["确认开工", "取消"],
    choice: 0,
    about: request.detail,
    by: "ou_owner",
  };
  const action = (events: unknown[], answers: unknown[] = []) =>
    nextAction({ events, answers } as Job["context"], "ou_owner");
  assert.equal(action([event]).kind, "ask");
  assert.equal(action([reply]).kind, "ignore");
  assert.equal(action([reply], [{ ...answer, by: "ou_other" }]).kind, "ignore");
  assert.equal(action([reply], [{ ...answer, choice: null }]).kind, "ignore");
  assert.equal(action([reply], [{ ...answer, choice: 1 }]).kind, "cancel");
  assert.deepEqual(action([reply], [answer]), {
    kind: "develop",
    subject: "om_first",
    detail: request.detail,
    retry: null,
  });
  const retry = { ...answer, title: "开发未完成，怎么继续", options: ["保留原工作区，重新执行", "结束"] };
  assert.equal(action([reply], [{ ...retry, by: "ou_other" }]).kind, "ignore");
  assert.equal(action([reply], [{ ...retry, choice: null }]).kind, "ignore");
  assert.equal(action([reply], [{ ...retry, choice: 1 }]).kind, "cancel");
  assert.equal(action([reply], [retry]).kind, "develop");
});

unixTest("failed development waits for a decision and preserves the prior workspace when explicitly restarted", () => {
  const root = mkdtempSync(join(tmpdir(), "feishu-development-"));
  try {
    const context = join(root, "context.json");
    const config = join(root, "config.json");
    const runner = join(root, "runner");
    const calls = join(root, "calls");
    const script = (code: number) =>
      `#!/bin/sh\necho "$1" >> '${calls}'\necho candidate > "$1/candidate"\nexit ${code}\n`;
    writeFileSync(runner, script(1), { mode: 0o700 });
    writeFileSync(config, JSON.stringify({ owner: "ou_owner", workspaceRoot: root, runner }));
    writeFileSync(
      context,
      JSON.stringify({
        events: [{ source: "feishu-operations", id: "card:3", subject: "om_approved", type: "card.answered" }],
        answers: [
          {
            card: 3,
            title: "确认开发多站点后台",
            options: ["确认开工", "取消"],
            choice: 0,
            about: "停用站点查询",
            by: "ou_owner",
          },
        ],
      }),
    );
    const invoke = () =>
      execFileSync(process.execPath, ["examples/recipes/feishu-intake/development.ts", config], {
        encoding: "utf8",
        env: { ...process.env, AGENT_AUTOLOOP_CONTEXT: context, AGENT_AUTOLOOP_RUN: "93" },
      });
    const first = invoke();
    assert.match(first, /第 93 轮/);
    assert.match(first, /验证未通过/);
    const failed = readMessage(first);
    assert.ok(Array.isArray(failed.receipt?.ask), "failed work must leave an actionable question");
    const [ask] = failed.receipt!.ask as { title: string; options: string[]; about: string }[];
    assert.ok(ask);
    assert.equal(failed.receipt!.notice, undefined);
    assert.match(ask.options[0], /重新执行/);
    writeFileSync(runner, script(0));
    assert.equal(invoke(), first);
    assert.equal(readFileSync(calls, "utf8").trim().split("\n").length, 1);
    writeFileSync(
      context,
      JSON.stringify({
        events: [{ source: "feishu-operations", id: "card:4", subject: "om_approved", type: "card.answered" }],
        answers: [{ card: 4, ...ask, choice: 0, by: "ou_owner" }],
      }),
    );
    const second = invoke();
    assert.match(second, /开发和定向验证通过/);
    assert.equal(invoke(), second);
    const workspaces = readFileSync(calls, "utf8").trim().split("\n");
    assert.equal(workspaces.length, 2);
    assert.notEqual(workspaces[0], workspaces[1]);
    assert.equal(readFileSync(join(workspaces[0], "candidate"), "utf8"), "candidate\n");
    mkdirSync(join(root, "om_interrupted"));
    writeFileSync(
      context,
      JSON.stringify({
        events: [{ source: "feishu-operations", id: "card:3", subject: "om_interrupted", type: "card.answered" }],
        answers: [
          {
            card: 3,
            title: "确认开发多站点后台",
            options: ["确认开工", "取消"],
            choice: 0,
            about: "继续核对",
            by: "ou_owner",
          },
        ],
      }),
    );
    const interrupted = invoke();
    assert.match(interrupted, /上次执行中断/);
    assert.ok(Array.isArray(readMessage(interrupted).receipt?.ask));
    assert.equal(invoke(), interrupted);
    assert.equal(readFileSync(calls, "utf8").trim().split("\n").length, 2);
    writeFileSync(
      join(root, "om_interrupted.result.txt"),
      '开发或验证未通过\n\n```agent-autoloop\n{"notice":[{"title":"开发结果","text":"未通过","fyi":true}]}\n```\n',
    );
    assert.ok(Array.isArray(readMessage(invoke()).receipt?.ask), "legacy failed receipts must also leave a decision");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
