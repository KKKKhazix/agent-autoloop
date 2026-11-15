// GitHub writes are made by the runner, never by the model inspecting the snapshot.
import { closeSync, existsSync, openSync } from "node:fs";
import { reproduction } from "./scout-repro.mjs";

export function scoutPath(path) {
  return /^(?:cli\/(?:main|runs|status|why)\.ts|tests\/(?:cli-runs|status-view|status-json|status-cost)\.test\.ts|docs\/[\w-]+\.md|README(?:\.en)?\.md)$/.test(
    path,
  );
}

function candidate(raw) {
  if (raw?.kind === "none") return null;
  if (!["bug", "feature"].includes(raw?.kind)) throw new Error("巡检类型无效");
  const fields = { title: 80, path: 160, excerpt: 250, evidence: 700, task: 800, acceptance: 600 };
  const result = { kind: raw.kind };
  for (const [key, limit] of Object.entries(fields)) {
    const value = raw[key];
    if (typeof value !== "string" || !value.trim() || value.length > limit || !value.isWellFormed())
      throw new Error("巡检结果缺少有效依据");
    result[key] = value.trim();
  }
  if (
    !/^[\p{L}\p{N} _.-]+$/u.test(result.title) ||
    !/^[\w./-]+$/.test(result.path) ||
    result.path.split("/").some((part) => !part || part.startsWith("."))
  )
    throw new Error("巡检标题或文件无效");
  if (!scoutPath(result.path)) throw new Error("巡检候选超出产品范围");
  return result;
}

export async function scout(config, gh, checkpoint, preview, inspect, reproduce, { bugsOnly = false } = {}) {
  const { base, repo } = config;
  if (config.scout !== true) return "没事可做：项目未开启巡检";
  const get = (args) => JSON.parse(gh(args));
  const openPulls = () =>
    get(["pr", "list", "--base", base, "--state", "open", "--limit", "10", "--json", "number,title"]);
  function waiting(pulls) {
    if (pulls.length) return "目标分支还有 PR 等待处理";
    if (
      get(["api", "repos/" + repo + "/issues?state=open&labels=agent-ready&per_page=10"]).some(
        (item) => !item.pull_request,
      )
    )
      return "已有 Issue 在接单流程中";
    return null;
  }

  const pulls = openPulls();
  const blocked = waiting(pulls);
  if (blocked && !preview) return "没事可做：" + blocked;

  const head = () => gh(["api", "repos/" + repo + "/git/ref/heads/" + base, "--jq", ".object.sha"]);
  const commit = head();
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error("无法确定巡检提交");
  const reservation = checkpoint + ".scout-" + commit;
  if (!preview && existsSync(reservation)) return "没事可做：此版本已尝试建单，请核对 GitHub";
  const recent = get(["api", "repos/" + repo + "/issues?state=all&per_page=40"]).filter((item) => !item.pull_request);
  const marker = "<!-- autoloop-scout:" + commit + " -->";
  if (!preview && recent.some((issue) => issue.body?.includes(marker))) return "没事可做：此版本已有巡检 Issue";
  const issues = recent.map(({ number, title, state }) => ({ number, title, state }));

  const ci = get([
    "run",
    "list",
    "--branch",
    base,
    "--limit",
    "8",
    "--json",
    "databaseId,name,headSha,status,conclusion",
  ]);
  const failures = ci.filter(({ headSha, conclusion }) => headSha === commit && conclusion === "failure").slice(0, 2);
  for (const run of failures) {
    if (!Number.isSafeInteger(run.databaseId) || run.databaseId <= 0) throw new Error("CI 轮次编号无效");
    const { jobs } = get(["run", "view", String(run.databaseId), "--json", "jobs"]);
    run.failedJobs = jobs
      .filter(({ conclusion }) => conclusion === "failure")
      .slice(0, 6)
      .map(({ name, steps }) => ({
        name: name.slice(0, 120),
        steps: steps
          .filter(({ conclusion }) => conclusion === "failure")
          .slice(0, 5)
          .map(({ name }) => name.slice(0, 120)),
      }));
  }
  const raw = await inspect({ commit, issues, pulls, ci });
  const found = candidate(raw);
  if (bugsOnly && found?.kind === "feature") return "没事可做：本轮只接收可独立复现的 Bug";
  if (!found) return "没事可做：未发现有证据且适合单次交付的改动";

  const file = get(["api", "repos/" + repo + "/contents/" + found.path + "?ref=" + commit]);
  if (
    file.type !== "file" ||
    file.encoding !== "base64" ||
    !Buffer.from(file.content, "base64").toString("utf8").includes(found.excerpt)
  )
    throw new Error("巡检引用的源码无法核对");

  const input = found.kind === "bug" ? reproduction(raw.reproduction) : null;
  const proof = input ? await reproduce(commit, input) : null;
  if (input && !proof) return "没事可做：独立复现未观察到异常";

  const title = "[" + (found.kind === "bug" ? "Bug 修复" : "功能优化") + "] " + found.title;
  if (issues.some((issue) => issue.title === title || issue.title === found.title)) return "没事可做：已有同名 Issue";
  if (preview) return "只读预览：" + title + " · " + commit + (blocked ? " · " + blocked : "");

  const changed = waiting(openPulls());
  if (changed) return "没事可做：" + changed;
  if (head() !== commit) return "没事可做：目标分支已更新，下次重新巡检";

  // Reserve a revision before publishing. Never retry an ambiguous creation automatically.
  try {
    closeSync(openSync(reservation, "wx", 0o600));
  } catch (error) {
    if (error.code === "EEXIST") return "没事可做：此版本已尝试建单，请核对 GitHub";
    throw error;
  }
  const body = [
    marker,
    ...(input
      ? [
          "<!-- autoloop-repro:" + Buffer.from(JSON.stringify(input)).toString("base64") + " -->",
          "独立复现：终端为 " + proof.expected + " 列，实际标题行占 " + proof.observed + " 列。",
        ]
      : []),
    "巡检提交 " + commit,
    "源码证据：" + found.path + "\n\n    " + found.excerpt.replaceAll("\n", "\n    "),
    "发现依据\n\n" + found.evidence,
    "改动范围\n\n" + found.task,
    "验收条件\n\n" + found.acceptance,
  ].join("\n\n");
  const url = gh(["issue", "create", "--title", title, "--body-file", "-", "--label", "agent-ready"], body);
  const prefix = "https://github.com/" + repo + "/issues/";
  if (!url.toLowerCase().startsWith(prefix.toLowerCase()) || !/^[1-9]\d*$/.test(url.slice(prefix.length)))
    throw new Error("未确认 Issue 创建结果");
  return "巡检发现可执行改动，已建单：" + url;
}
