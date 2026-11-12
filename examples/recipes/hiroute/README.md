# 用 HiRoute 给后台任务选模型

[English](README.en.md)

反馈分类这类重复任务可以用支持工具调用的经济模型，少占主力模型的 Token 和订阅额度。Autoloop 仍用原有 Agent 插件派活、续接会话和收回执。Agent 的模型请求经 [HiRoute](https://hiroute.ai/) 选模并记录用量。

## 在接单电脑配置

在运行 Agent 的电脑上启动 HiRoute，为反馈分类接入经济模型并发布固定路由。固定路由按候选顺序选模，省掉决策调用。遇到同类任务难度差异较大时，可以再试按难度分流。[接入模型](https://hiroute.ai/zh/docs/models/) · [智能路由](https://hiroute.ai/zh/docs/model-routing/)

按接单电脑上已有的 Agent 选择一种配置。

- 使用 **Claude Code** 时，在 HiRoute 的「Agent → Claude Code → 模型路由」把路由映射到你使用的预设，例如 Sonnet。示例中的 `use: "claude"` 和 `model: "sonnet"` 会选这个预设。映射到其他预设时，相应修改 `model`。[Claude Code 接入步骤](https://hiroute.ai/zh/docs/claude-code-model-routing/#connect-agent)
- 使用 **Codex** 时，在 HiRoute 为 Codex CLI 选「按需使用 · 仅 CLI」，把发布的路由设为默认，复制启动命令中的配置目录。下方脚本只在 `exec` 时选择 HiRoute profile。把脚本的绝对路径填入示例中 `hiroute-codex` 的 `program`。[Codex CLI 接入步骤](https://hiroute.ai/zh/docs/codex-model-routing/)

Codex 在 macOS / Linux 上把下面的脚本保存为 `codex-via-hiroute.sh`。替换两个路径，再用 `chmod +x` 让脚本可执行。

```sh
#!/bin/sh
codex_config='/absolute/path/to/codex-config'
codex_bin='/absolute/path/to/codex'
if [ "${1:-}" = exec ]; then
  CODEX_HOME="$codex_config" exec "$codex_bin" --profile hiroute "$@"
fi
CODEX_HOME="$codex_config" exec "$codex_bin" "$@"
```

Windows 上用 `codex-via-hiroute.ps1`，同样填入 HiRoute 启动命令里的配置目录和 Codex 可执行文件的路径。

```powershell
$env:CODEX_HOME = 'C:\path\to\codex-config'
$codex = 'C:\path\to\codex.exe'
if ($args[0] -eq 'exec') {
  & $codex --profile hiroute @args
} else {
  & $codex @args
}
exit $LASTEXITCODE
```

模型凭据留在 HiRoute。`agent-autoloop doctor` 的 Codex 登录检查仍看原生登录状态，只用网关凭据时可能提示未登录。下面的试跑能确认请求实际到了 HiRoute。

## 试跑一条只读规则

1. 在接单电脑创建一个试验目录，把下面三行存为其中的 `feedback.txt`。

   ```text
   A 更新后导出 CSV 时应用会退出。
   B 希望导出 CSV 时可以选择列。
   C 在哪里能下载已有报表？
   ```

2. 从 [rules.json](rules.json) 合并 `sources`、选中的 `agents` 项和这条 `rules` 到你的规则文件。将 `worker` 改为 `agent-autoloop status` 里的接单电脑，把 `cwd` 改成试验目录。`to` 默认选 Claude Code，用 Codex 时改为 `hiroute-codex`。示例使用 `access: "read"`，由所选 Agent 插件处理权限。
3. 运行 `agent-autoloop check`，然后执行 `agent-autoloop run "HiRoute feedback triage"`。在 `agent-autoloop status` 看结果，预期 A 是 `bug`、B 是 `feature`、C 是 `question`。在 HiRoute 的「会话 → 路由时间线」确认本次请求走了预期路由和模型。

## 怎么确认省了多少

用原模型和经济路由各跑一轮相同的输入，按同一个标准验收结果。记录主力模型的 Token、输入输出和缓存用量，并把重试和额外的决策调用算进去。Autoloop 的 `why` 可查看轮次，HiRoute 的[路由时间线和费用分析](https://hiroute.ai/zh/docs/optimize-model-routing/)可查看实际模型与 API 等价费用。

低价模型能降低同等用量的费用，分走常规任务能节省主力模型的 Token。想降低总 Token，可以让脚本过滤无需处理的事件，并让独立任务只读取所需资料。
