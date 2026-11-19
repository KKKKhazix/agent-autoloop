#!/usr/bin/env node
// 定时看一眼 GitHub 有没有新 issue，没有新东西不花 Token。中台在家里、连不上公网也能用。
//
//   "agents": { "watcher": { "name": "轮询", "worker": "my-pc", "use": "command", "command": ["node", "/绝对路径/watch-github-issues.mjs", "owner/repo", "created:>=YYYY-MM-DDT00:00:00+08:00"] } }
//   "rules": [
//     { "name": "看新 issue", "when": { "cron": "*/5 * * * *" }, "to": "watcher", "cwd": "~/", "tell": "never", "emits": { "source": "github", "types": ["issues.opened"] } },
//     { "name": "处理 issue", "when": { "source": "github", "types": ["issues.opened"] }, "to": "claude", "cwd": "~/code/app", "skill": "handle-issue", "parallel": 1 }
//   ]
//
// 第二个参数可选，是 GitHub 的搜索条件：created:>=日期 只看这天以后开的（GitHub 按 UTC 算日期，带上 T00:00:00+08:00 才是北京时间的那天），label:agent 只看打了这个标签的。不写就是所有开着的。
// 不留游标：每次都读最近的，事件的 id 是稳定的，重复的中台只记一次。
// 整理好的例子见 examples/recipes/github-issues。用 node 而不是 sh，是为了 Windows 上也能直接跑。
import { execFileSync } from "node:child_process";

const [repo, search] = process.argv.slice(2);
if (!repo) {
  console.error("用法：node watch-github-issues.mjs owner/repo [GitHub 搜索条件]");
  process.exit(2);
}

const args = ["issue", "list", "--repo", repo, "--state", "open", "--limit", "30", "--json", "number,title,url,body"];
if (search) args.push("--search", search);
const issues = JSON.parse(execFileSync("gh", args, { encoding: "utf8" }));
const events = issues.map((issue) => ({
  id: `issue-${issue.number}`,
  type: "issues.opened",
  subject: `#${issue.number}`,
  summary: String(issue.title ?? "").slice(0, 200),
  detail: String(issue.body ?? "").slice(0, 4000),
  link: issue.url,
}));

console.log(`看了 ${repo} 最近的 issue`);
console.log("");
console.log("```agent-autoloop");
console.log(JSON.stringify({ events }));
console.log("```");
