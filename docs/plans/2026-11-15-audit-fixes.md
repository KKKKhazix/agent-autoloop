# 2026-11-15 深度审计修复批

**状态:2026-11-15 完成。** 8 项全部落地并带测试;typecheck 过、format:check 过、`npm test`(含 20 万步模拟与穷举)950 条 0 挂(21 条平台条件跳过)。第 3 项说明:github.ts/review.ts 的 is-ancestor 用会抛错的 `git()` 包裹且需要区分退出码 1 与 128(128 触发补 fetch),与布尔版不是同一语义,保持原样;共享版落在 project.ts(2 处)+ gitlab.ts(原参数颠倒处)。

全量审计 kernel/host/worker/protocol/cli/plugins(内核亲读 + 外围三路审计,每条发现亲手核实或跑复现脚本)。基线:typecheck 过、test:quick 917 过 0 挂。架构无结构性问题;以下 8 项是核实过的真实缺陷。

## 必修

1. **cli/plugins.ts `plugins remove` 路径穿越** — 名字零校验就 join+rmSync(recursive),`remove ..` 删整个 AGENT_AUTOLOOP_HOME(hub.db、master.key)。修:入口按 PLUGIN_NAME 校验。测试:tests/plugins-cli.test.ts。
2. **cli/runs.ts 翻页建议 shell 注入** — 规则名白名单放行 `;|&()<>`,JSON.stringify 兜底挡不住 `$(...)`(sh/PowerShell 都展开)。规则名无字符集限制且 rules.json 常由 Agent 改,复制粘贴即执行。修:复用 cli/status.ts 的 `shellWord`。测试:tests/cli-runs.test.ts。
3. **plugins/delivery/gitlab.ts isAncestor 参数颠倒** — `--is-ancestor head base` 问的反问题;github.ts/project.ts/review.ts 四处同语义都是 `base, head`。后果:GitLab 交付 15 分钟超时循环、发布核实方向反(旧版本被当"已发布")。修:project.ts 导出 `isAncestor(root, base, head)`,四处共用。测试:本地 git 两提交仓断言方向。
4. **kernel/decide.ts 卡片去向回读当前规则** — 协议"去向创建时写在卡片上",实测规则后加 channels 会把已开 ask 卡静默收窄。修:createCard 对无显式 routing 的卡片按创建时规则冻结 channels;ask(别处任务提问)补传 ruleRouting;nextCard 只看 card.channels ?? defaultChannels。测试:tests/cards.test.ts(文件头补失败模式)。

## 应修

5. **cli/update.ts update.json 非原子写** — 写一半崩溃砖死 rollback。修:tmp+rename(同 saveLock 先例)。
6. **cli/plugins.ts add 清理绕过** — try 内 `git()` fail() 直接 process.exit,catch 的回滚(删首装目录/切回旧版)到不了。修:try 内改抛错变体。测试:--ref 不存在标签,失败后不留目录。
7. **host/backup.ts keyChanged 读 CWD** — replaced 为 null 时 `path.join("", "master.key")` 是相对路径,restore 空 home 时拿 CWD 无关文件算。修:补 replaced !== null。测试:tests/backup.test.ts。
8. **worker/worker.ts start() mkdir 在 try 外** — 磁盘满/权限失败被 tick catch 记成"连不上中台",10 分钟后误报 unreachable。修:包入本地失败处理。测试:tests/worker.test.ts(runs 目录 0o500,root 跳过)。

## 记录不修(仓规:罕见条件凑一起的记下来;pinned 测试站对立面的不动)

- worker 对永久 401 结果无限重试(容量占用 + run 不可停):pinned test "a result refused for a revoked key is kept and handed in later, not dropped" 明确保留结果,属设计张力,要改先翻那条行为规格,单独立项。
- up.pid 复用竞态;飞书 markdown 未中和外部链接(企微有防御,飞书无);source 适配器多字节签名头抛错回 400 而非 401;powershell() 两处无超时;tell() 重发改卡片文字 vs 协议"内容不变";plugins lock/signers 并发写竞态;rules edit $EDITOR 未引号;mcp.ts 死变量 `initialized`;卡片链接回答逻辑 kernel/http.ts 与 host/runtime.ts answerByLink 双份维护。
