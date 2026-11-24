import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { REPO } from "../../../plugins/delivery/project.ts";
import { ruleFile, checkRules } from "./settings.mjs";
const exec = promisify(execFile);

// Read the same repository the configured plugin receives. The browser supplies only an agent id and PR number.
export async function deliveryView(query) {
  const agent = checkRules(ruleFile().text).agents[query.get("agent")];
  const repo = agent?.command?.[0];
  if (agent?.use !== "delivery" || !repo || !REPO.test(repo) || repo.startsWith("-"))
    throw new Error("请选择已配置仓库的 delivery Agent");
  const number = query.get("pr");
  if (number !== null && !/^[1-9]\d*$/.test(number)) throw new Error("PR 编号无效");
  const args = number
    ? ["pr", "view", number, "--repo", repo, "--json", "number,title,url,state,reviewDecision,statusCheckRollup"]
    : ["api", "repos/" + repo + "/contents/ops/delivery.json?ref=main", "--jq", ".content"];
  try {
    const { stdout } = await exec("gh", args, { windowsHide: true, timeout: 30000, maxBuffer: 2 ** 21 });
    return JSON.parse(number ? stdout : Buffer.from(stdout.trim(), "base64").toString("utf8"));
  } catch (e) {
    throw new Error(e.stderr?.trim() || e.message);
  }
}
