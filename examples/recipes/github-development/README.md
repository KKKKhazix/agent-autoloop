# 自动开发并提交草稿 PR

给已登记仓库的开放 Issue 打上 `agent-ready`，中台每五分钟收单。接单程序在临时工作目录调用 Codex，从指定分支开始改代码，跑项目的验证命令。通过后推送任务分支并开 Draft PR。你在 GitHub 查看差异和验证结果，手动合并。

## 新增项目

接单机需要 Node 24、Git、已登录的 `gh` 和 Codex CLI。让 GitHub 账号能读取该仓的 Issue、推送任务分支和开 PR，用仓库规则保护目标分支。项目的依赖和测试工具要能在接单机离线使用。

Git 默认用 HTTPS。接单机已配好 GitHub SSH 密钥时，可在项目 JSON 中加 `"gitTransport": "ssh"`。SSH 只用于 Git 拉取和推送，Issue 和 PR 仍使用已登录的 `gh`。

项目 JSON 可加 `"showCodexSessions": true`，让实际启动 Codex 的任务在接单机的 Codex 会话列表中可见。标题包含仓库、Issue 和中控轮次。查询 Issue 或沿用已有 PR 时不会创建会话。会话正文由 Codex 保留。

把下面的 JSON 保存到接单机的私有目录，比如 `~/.agent-autoloop/projects/my-project.json`。验证命令由你指定，用参数数组传入。示例里的测试入口要换成项目真实的定向检查。

```json
{
  "repo": "owner/repo",
  "base": "main",
  "goal": "写清项目最终要达到的结果和验收条件",
  "verify": ["node", "--test", "tests/target.test.js"]
}
```

在 Agent Autoloop 仓库目录运行一次登记命令。将 `mac-lan` 换成实际接单机名称。脚本校验并合入已有规则，并保存原规则的备份。只想查看生成的规则时，将 `add` 改成 `rules`。

```sh
node examples/recipes/github-development/run.mjs add "$HOME/.agent-autoloop/projects/my-project.json" mac-lan
```

在 GitHub 新建 `agent-ready` 标签。给一条写清改动范围和验收条件的 Issue 打上标签就能派单。每个仓库同时处理一单。相同 Issue 复用同一个任务分支和已有 PR。关闭 Issue 或移除标签会撤回派单。失败时在中台卡片选择「重试」或「结束」。通过 `status` 查结果，通过 `why` 查轮次。草稿 PR 正文会记录实际执行的验证命令和退出码。

最终目标可在本机控制台的项目卡片里编辑。每轮读取启动时保存的目标，用于判断当前 Issue 是否符合项目方向。具体工作由该 Issue 的范围决定，项目目标由你验收。

接单机从项目固定的目标分支取代码。Issue 标题和正文只作为资料交给 Codex。Codex 的命令和项目验证在工作区沙箱中运行，GitHub 推送和开 PR 由外层脚本完成。脚本使用单仓库工作目录。前后端独立仓库分别登记，涉及版本锁定的任务按依赖顺序派发。

需要暂停时，用 `agent-autoloop pause "owner/repo 查 Issue"` 和 `agent-autoloop pause "owner/repo 开发"`。已经领取的任务用 `agent-autoloop stop <轮次>`。要撤销登记，从规则文件移除该项目的来源、两个 Agent 和两条规则。若登记后没有其他规则改动，也可恢复登记时保存的备份。

本机控制台可从项目卡片按 Issue 编号主动派单，也可从已结束的轮次续派同一 Issue。后续轮次记录来源，并继续校验 Issue 是否带派单标签。已有 PR 时返回链接，验证失败或上次交付中断时按当前状态继续。要迭代已交付的改动，可以为同一项目派发下一条 Issue。

## 定时找活

项目配置加上 `"scout": true` 后，登记规则时会增加「项目巡检」，每天按中控时区 09:00 检查目标分支。已登记的项目需把 `rules` 生成的巡检 Agent 和规则合入现有配置。巡检和开发共用一个执行名额。目标分支有开放 PR，或有开放的 `agent-ready` Issue 时，巡检结束，留待下次检查。

巡检让 Codex 阅读目标分支固定提交的源码、已有 Issue、最近 CI 结果和同提交失败的步骤。它从 CLI 历史、状态、回执展示和文档中选择一项有具体证据的功能优化或普通 Bug。已有测试未覆盖的 Bug 可以提交结构化复现输入。执行器在独立的同提交快照运行固定检查，确认异常才建单。当前支持历史标题行宽，其他类型需要增加对应的固定检查。接单后先复核异常仍存在，再补回归测试和修复。修复后重放同一输入并跑项目定向测试，通过才提草稿 PR。巡检和实际开发分别使用可在 Codex 列表查看的会话。

每个提交最多自动建一单。建单前再次确认没有待审 PR、待接 Issue 或目标分支变更。遇到不确定的建单结果，先在 GitHub 核对，再决定是否清除配置旁的 `.scout-<提交号>` 标记后重试。

用 `scout-preview` 可以在待审期间查看真实源码和 CI 的巡检结论，预览只读取 GitHub。暂停「项目巡检」规则即可暂停找活。
