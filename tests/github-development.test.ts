// Failure mode: a withdrawn issue, a failed check or a repeated turn must not publish another draft.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

test(
  "publishes a checked draft once and stops on a failed check or withdrawn issue",
  { skip: process.platform === "win32" },
  () => {
    const dir = mkdtempSync(join(tmpdir(), "github-development-"));
    try {
      const log = join(dir, "calls");
      const context = join(dir, "context.json");
      const config = join(dir, "project.json");
      writeFileSync(config, JSON.stringify({ repo: "owner/project", base: "main", verify: ["node", "check.mjs"] }));
      writeFileSync(
        context,
        JSON.stringify({
          events: [{ source: "development-owner-project", type: "issue.ready", subject: "42" }],
          answers: [],
        }),
      );
      const fake = join(dir, "fixture");
      writeFileSync(
        fake,
        `#!${process.execPath}
const { appendFileSync, readFileSync, writeFileSync } = require('node:fs');
const [cmd, ...args] = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify([cmd, ...args]) + '\\n');
const flags = JSON.parse(readFileSync(${JSON.stringify(join(dir, "flags"))}, 'utf8'));
if (cmd === 'gh' && args[0] === 'issue' && args[1] === 'list') console.log('[{"number":42}]');
if (cmd === 'gh' && args[0] === 'api' && args[1] === 'repos/owner/project/issues/42') console.log(JSON.stringify({number:42,state:'open',labels:flags.WITHDRAWN ? [] : [{name:'agent-ready'}],title:'Fixture',body:'Fixture issue'}));
if (cmd === 'gh' && args[0] === 'api' && args[1].startsWith('repos/owner/project/pulls?')) console.log(JSON.stringify(flags.EXISTING
  ? [{number:7,base:{ref:'main'},head:{repo:{full_name:'owner/project'},ref:'codex/issue-42',sha:'a'.repeat(40)},draft:!flags.NON_DRAFT}]
  : []));
if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'view') console.log(JSON.stringify({
  isDraft:true, baseRefName:'main', headRefName:'codex/issue-42', headRefOid:(flags.WRONG_HEAD ? 'b' : 'a').repeat(40)
}));
if (cmd === 'gh' && args[0] === 'api' && args[1] === 'repos/owner/project/pulls') {
  if (flags.CREATE_FAILED) process.exit(1);
  const payload = JSON.parse(readFileSync(0, 'utf8'));
  if (payload.draft !== true || payload.base !== 'main' || payload.head !== 'codex/issue-42') process.exit(1);
  console.log(JSON.stringify({html_url:'https://github.com/owner/project/pull/7'}));
}
if (cmd === 'git' && args.includes('rev-parse')) console.log('a'.repeat(40));
if (cmd === 'git' && args.includes('ls-remote') && flags.PUSHED) console.log('a'.repeat(40) + ' refs/heads/codex/issue-42');
if (cmd === 'git' && args.includes('diff') && args.includes('--name-only')) console.log('changed.txt');
if (cmd === 'codex' && args[0] === 'exec') writeFileSync('changed.txt', 'fixed');
if (cmd === 'codex' && args[0] === 'sandbox' && flags.BAD_CHECK) process.exit(1);
`,
      );
      chmodSync(fake, 0o700);
      for (const name of ["git", "gh", "codex"]) {
        writeFileSync(join(dir, name), `#!/bin/sh\nexec '${fake}' '${name}' "$@"\n`, { mode: 0o700 });
      }
      const script = fileURLToPath(new URL("../examples/recipes/github-development/run.mjs", import.meta.url));
      const run = (extra: Record<string, string>, mode = "work") => {
        writeFileSync(log, "");
        writeFileSync(join(dir, "flags"), JSON.stringify(extra));
        const output = execFileSync(process.execPath, [script, mode, config, "mac-lan"], {
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: `${dir}:${process.env.PATH}`,
            AGENT_AUTOLOOP_CONTEXT: context,
          },
        });
        return {
          output,
          calls: readFileSync(log, "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line) as string[]),
        };
      };
      const rules = join(dir, "rules.json");
      writeFileSync(rules, JSON.stringify({ sources: {}, agents: {}, rules: [] }));
      const add = execFileSync(process.execPath, [script, "add", config, "mac-lan"], {
        encoding: "utf8",
        env: { ...process.env, AGENT_AUTOLOOP_RULES: rules },
      });
      assert.match(add, /已登记/);
      assert.equal(JSON.parse(readFileSync(rules, "utf8")).rules.length, 2);
      const poll = run({}, "poll");
      assert.match(poll.output, /"id":"issue-42"/);
      assert.ok(poll.calls.some((args) => args.includes("--label") && args.includes("agent-ready")));

      writeFileSync(
        context,
        JSON.stringify({
          events: [
            { source: "development-owner-project", type: "issue.ready", subject: "42" },
            { source: "development-owner-project", type: "run.manual", subject: "42", detail: "续派自轮次 #1" },
          ],
          answers: [],
        }),
      );
      writeFileSync(
        config,
        JSON.stringify({
          repo: "owner/project",
          base: "main",
          verify: ["node", "check.mjs"],
          gitTransport: "ssh",
        }),
      );
      const success = run({});
      assert.match(success.output, /\/pull\/7/);
      for (const operation of ["ls-remote", "fetch", "push"]) {
        const git = success.calls.find(([cmd, ...args]) => cmd === "git" && args.includes(operation));
        assert.ok(git?.includes("git@github.com:owner/project.git"));
      }
      const evidence = JSON.parse(readFileSync(config + ".issue-42.json", "utf8"));
      assert.equal(evidence.issue, "42");
      assert.equal(evidence.commit, "a".repeat(40));
      assert.equal(evidence.pr, "https://github.com/owner/project/pull/7");
      assert.deepEqual(evidence.verification.argv, ["node", "check.mjs"]);
      assert.equal(evidence.verification.exitCode, 0);
      const check = success.calls.findIndex(([cmd, sub]) => cmd === "codex" && sub === "sandbox");
      const push = success.calls.findIndex((args) => args[0] === "git" && args.includes("push"));
      assert.ok(check >= 0 && push > check);
      assert.ok(
        success.calls.some(
          (args) => args.slice(0, 3).join(" ") === "gh api repos/owner/project/pulls" && args.includes("POST"),
        ),
      );
      const failed = run({ BAD_CHECK: "1" });
      assert.match(failed.output, /待你处理/);
      for (const result of [failed, run({ WITHDRAWN: "1" }), run({ EXISTING: "1" })]) {
        assert.ok(result.calls.every((args) => !args.includes("push") && !args.includes("POST")));
      }
      writeFileSync(
        context,
        JSON.stringify({
          events: [{ source: "development-owner-project", type: "card.answered", subject: "42" }],
          answers: [{ choice: 0, about: "development:42" }],
        }),
      );
      assert.match(run({ CREATE_FAILED: "1" }).output, /待你处理/);

      const pending = JSON.parse(readFileSync(config + ".issue-42.json", "utf8"));
      assert.match(run({ EXISTING: "1", NON_DRAFT: "1" }).output, /已有 PR/);
      assert.equal(JSON.parse(readFileSync(config + ".issue-42.json", "utf8")).pr, undefined);
      assert.match(run({ EXISTING: "1" }).output, /已有 PR/);
      assert.equal(
        JSON.parse(readFileSync(config + ".issue-42.json", "utf8")).pr,
        "https://github.com/owner/project/pull/7",
      );
      writeFileSync(config + ".issue-42.json", JSON.stringify({ ...pending, goal: "派单时的目标" }));
      writeFileSync(
        config,
        JSON.stringify({ repo: "owner/project", base: "main", verify: ["node", "check.mjs"], goal: "后来编辑的目标" }),
      );
      const recovered = run({ PUSHED: "1" });
      assert.match(recovered.output, /\/pull\/7/);
      assert.equal(JSON.parse(readFileSync(config + ".issue-42.json", "utf8")).goal, "派单时的目标");
      assert.ok(recovered.calls.every((args) => !args.includes("push") && !args.includes("exec")));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
