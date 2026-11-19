// 防的事故：旧事件的 id/type/subject/summary/link 语义被静默改变（工作台按 subject+对象号对账），或
// check_run/check_suite/status/workflow_run/push 这类只带 head SHA 的事件在翻译后丢掉可信线索，导致工作台
// registry 无法把 CI 变化对到已登记的 PR head 上；或者反过来，由 payload 编造 PR 号/把不可信文字写进线索。
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import github from "../plugins/github/source.ts";

const secret = "s3cret";

function fixture(name: string) {
  return JSON.stringify(
    JSON.parse(readFileSync(new URL(`./fixtures/attention-github-source/${name}.json`, import.meta.url), "utf8")),
  );
}

function signed(body: string, over: Record<string, string> = {}) {
  return {
    headers: {
      "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
      "x-github-event": "issues",
      "x-github-delivery": "d-1",
      ...over,
    },
    body,
    secret,
  };
}

test("兼容：issue 事件的 id/type/subject/summary/detail/link 与既有行为逐字一致", () => {
  const body = JSON.stringify({
    action: "opened",
    issue: { number: 12, title: "首页打不开", body: "详情", html_url: "https://github.com/a/b/issues/12" },
    repository: { full_name: "a/b", html_url: "https://github.com/a/b" },
  });
  assert.deepEqual(github(signed(body, { "x-github-event": "issues" })), [
    {
      id: "d-1",
      type: "issues.opened",
      subject: "a/b#12",
      summary: "首页打不开",
      detail: "详情",
      link: "https://github.com/a/b/issues/12",
    },
  ]);
});

test("兼容：PR 同步事件 subject 带 #号，ping 返回空，验签不过抛错", () => {
  const body = JSON.stringify({
    action: "synchronize",
    pull_request: { number: 7, title: "改路由", body: "说明", html_url: "https://github.com/a/b/pull/7" },
    repository: { full_name: "a/b", html_url: "https://github.com/a/b" },
  });
  assert.deepEqual(github(signed(body, { "x-github-event": "pull_request" })), [
    {
      id: "d-1",
      type: "pull_request.synchronize",
      subject: "a/b#7",
      summary: "改路由",
      detail: "说明",
      link: "https://github.com/a/b/pull/7",
    },
  ]);
  assert.deepEqual(github(signed("{}", { "x-github-event": "ping" })), []);
  assert.throws(() =>
    github({
      headers: { "x-hub-signature-256": "sha256=00", "x-github-event": "issues", "x-github-delivery": "d-1" },
      body: "{}",
      secret,
    }),
  );
  assert.throws(() => github({ headers: { "x-github-event": "issues" }, body: "{}", secret }));
  assert.throws(() => github({ ...signed("{}"), secret: "" }));
});

test("check_run：subject 保持 repo（不伪造 PR 号），detail 给出可信 head/branch/prs 线索", () => {
  const events = github(signed(fixture("check-run"), { "x-github-event": "check_run" }));
  assert.deepEqual(events, [
    {
      id: "d-1",
      type: "check_run.completed",
      subject: "acme/widgets",
      summary: "",
      detail: "head=c0ffee1111111111111111111111111111111111 branch=feature/routing prs=7",
      link: "https://github.test/acme/widgets",
    },
  ]);
});

test("check_suite：无关联 PR 时不写 prs，线索只有 head/branch", () => {
  const events = github(signed(fixture("check-suite"), { "x-github-event": "check_suite" }));
  assert.equal(events.length, 1);
  assert.equal(events[0]?.type, "check_suite.completed");
  assert.equal(events[0]?.subject, "acme/widgets");
  assert.equal(events[0]?.detail, "head=c0ffee2222222222222222222222222222222222 branch=main");
});

test("status 事件：type 无 action 后缀，branch 取第一个包含该提交的分支", () => {
  const events = github(signed(fixture("status"), { "x-github-event": "status" }));
  assert.deepEqual(events, [
    {
      id: "d-1",
      type: "status",
      subject: "acme/widgets",
      summary: "",
      detail: "head=c0ffee3333333333333333333333333333333333 branch=main",
      link: "https://github.test/acme/widgets",
    },
  ]);
});

test("workflow_run：多个关联 PR 的号码原样进线索，不增不减", () => {
  const events = github(signed(fixture("workflow-run"), { "x-github-event": "workflow_run" }));
  assert.equal(events[0]?.type, "workflow_run.completed");
  assert.equal(events[0]?.detail, "head=c0ffee4444444444444444444444444444444444 branch=feature/next prs=11,12");
});

test("push：summary 仍是提交说明，detail 新增 head/branch 线索（原来是空）", () => {
  const events = github(signed(fixture("push"), { "x-github-event": "push" }));
  assert.deepEqual(events, [
    {
      id: "d-1",
      type: "push",
      subject: "acme/widgets",
      summary: "fix: routing fallback",
      detail: "head=c0ffee5555555555555555555555555555555555 branch=feature/next",
      link: "https://github.test/acme/widgets",
    },
  ]);
});

test("payload 没有 head SHA 时不编造线索，issue 事件的 detail 仍是正文", () => {
  const noHead = JSON.stringify({
    action: "completed",
    check_run: { id: 1, name: "build", status: "completed" },
    repository: { full_name: "acme/widgets", html_url: "https://github.test/acme/widgets" },
  });
  const events = github(signed(noHead, { "x-github-event": "check_run" }));
  assert.equal(events[0]?.detail, "");

  const issueBody = JSON.stringify({
    action: "opened",
    issue: { number: 3, title: "t", body: "正文", html_url: "https://github.com/a/b/issues/3" },
    repository: { full_name: "a/b", html_url: "https://github.com/a/b" },
  });
  const issueEvents = github(signed(issueBody, { "x-github-event": "issues" }));
  assert.equal(issueEvents[0]?.detail, "正文");
});
