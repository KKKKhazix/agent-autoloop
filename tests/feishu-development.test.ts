// A message or a free-text response must never authorize code changes.
import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nextAction } from "../examples/recipes/feishu-intake/development.ts";
import type { Job } from "../protocol/job.ts";

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
  assert.deepEqual(action([reply], [answer]), { kind: "develop", subject: "om_first", detail: request.detail });
});

test("the confirmed run returns a terminal Feishu receipt and replays it without developing again", () => {
  const root = mkdtempSync(join(tmpdir(), "feishu-development-"));
  try {
    const context = join(root, "context.json");
    const config = join(root, "config.json");
    const runner = join(root, "runner");
    writeFileSync(runner, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
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
    assert.match(first, /"fyi":true/);
    writeFileSync(runner, "#!/bin/sh\nexit 0\n");
    assert.equal(invoke(), first);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
