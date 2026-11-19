# GitHub 事件和主动采集

`source.ts` 仍是同步 webhook 入口：先验签，再解析；保留事件 ID、类型、仓库/对象主题、链接和发布版评论正文。已签名的 check run、check suite、status、workflow run 和 push 可以附带 head SHA 线索，不凭 branch 或 SHA 猜 PR 编号。线索不是主动核实结果，也不生成订阅。

## 一次性只读命令

需要 Node 24+ 和能访问目标仓库的 `gh` 身份；命令固定访问 `github.com`，不启动循环、不写外部平台、不发 Hub 事件。

```sh
node plugins/github/collector.ts '{"mode":"discover","repo":"HKUDS/DeepTutor","author":"LaiYongqiang"}'
node plugins/github/collector.ts '{"mode":"verify","repo":"HKUDS/DeepTutor","kind":"pr","number":2475}'
```

- 两种请求按同一对象键 `github:<owner/repo>:<issue|pr>:<number>`，复用对象、评论、评审、关系和比较读取。发现有账号过滤；指定对象核实不需要账号过滤，也不创建订阅。请求来自授权路由，不从 webhook 文本提取 CLI 参数。
- 标准输出是一条 JSON 记录。处理了合法请求就返回记录，即使批次为 `failed`；调用方须读 `status`，不能靠退出码判断访问成功。无效请求退出 `2`；外部错误正文不出现在结果里。`observedAt` 是本次读取结束的时间，不是平台更新时间，也不证明此刻以后仍然有效。
- 发现自动翻页，每类最多尝试 1,000 个对象；显式报告 Search `incomplete_results`、分页短缺/重叠和总量漂移。嵌套连接以游标续读，每条最多 10 页（通常 100 条/页、评审线程 25、线程内评论 10）。CI 作业也有 10 页上限。重复游标、重复节点、总量不符或检测到对象版本变化都不算读全。提交比较仍只能取文件有效的第一页，抵达 300 文件保守标为截断。
- 单次 `gh` 调用最多 20 秒，对象最多同时读 4 个，整轮远端读取预算 120 秒。超预算或上限报部分/失败，不跨轮自动保存游标。`complete` 是所请求范围内没有观察到覆盖缺口，不是 GitHub 全量快照或跨请求原子性保证。
- 批次和对象都区分 `complete`、`partial`、`failed`。部分结果可读，不可作为全量替换；字段取不到时结合 `problems`，不把空数组/`null` 当成已证实为空。对象未出现在搜索结果不等于删除。图查询报错时不采信其混合返回；网络、限流、权限等命令失败统一归为 `read-failed`，不猜测对象已删除。
- `previous` 可传同授权范围、同采集版本下上次**完整**对象的 `{对象键: fingerprint}`。首次为 `baseline`，等指纹为 `unchanged`，内容有变化为 `changed`；部分或失败为 `unknown`、不产新指纹。扩展采集字段后重新建立基线，不能混用旧指纹。时间戳保留作证据但仅 `updatedAt` 变化不改变指纹。指纹比较不是告警/派工策略；保存、重试和是否触发后续动作由上层决定。

## 迁移核对（2026-11-19）

以 `runtime/workbench/tracker-command.json` 指向的 `releases/workbench/code-v18/scripts/legacy-tracker` 为基准；不以 Antigravity scratch 原目录或 GitHub 默认分支替代。源码工作树以 `f94444d` 为底，补齐发布 `37a9eb2e` 的评论正文/防截断行为，并吸收集成提交 `6ec9273` / `912bf57` 的 webhook 头部线索。另一发布副本 `84305a3` 的 GitHub webhook 与 `f94444d` 同版。

| 对照项 | 已有 / 新实现 | 边界 |
| --- | --- | --- |
| 按仓库和作者发现 | 保留 v18 的单仓、按作者、全部状态语义；从各类 200 提升为自动翻页、最多 1,000，并明确检出截断 | GitHub 搜索索引可延迟；不跨仓扫描，调用方可分别请求多个仓库 |
| 对象字段 | 基础字段、PR 评审与行内线程、文件、base/head 与 CI 原始证据 | v18 的评论预览、CI 归纳和活动分类是消费侧计算；这里返回证据，不复刻这些展示字段 |
| 关联 | Issue 的 GitHub 关闭 PR 关系、PR 的 GitHub 关闭 Issue 关系（含仓库）；发现批次另从 PR 正文和首条评论（仅当其来自 PR 作者）推断本批已观察 Issue 的 `#号` | 明确区分官方关闭关系和文字提及；先识别完整编号，再检查评论证据窗口。单对象不为推测关系查其他对象，也不从旧快照补关系 |
| 提交比较 | 开放且有文件的 PR 请求 `baseRefOid...baseRefName`，将上游重命名前后路径都纳入交集；同一批次复用相同仓库/基点/目标的比较 | 没有 PR 提交列表或补丁镜像需求；v18 用的是比较文件，不是完整提交历史。超过上限不报告无变化 |
| 故障和重复观察 | v18 任一错误不推进整个持久基线；本插件不写基线，给批次/对象覆盖和指纹，供上层推进 | 旧结果保留、成功时间、批次接纳和单生产派发仍需上层实施 |
| Workbench GitHub Provider | 已有注册对象读、评论/评审/行内评论/线程、按 head 的 CI、HTTP 证据和预算；未见 v18 的作者发现及上游比较 | 现有 Provider 中的 Workbench 观测/持久契约不搬入 Autoloop，也不建立第二个线上轮询；现有功能保留，不由此命令替代 |

## 评审线程与 CI 重跑证据

- `reviewThreads` 包含文件、当前/原始行号、解决及过期状态，以及行内评论和回复。线程列表和单线程回复各自独立续页；任一页身份不符、失败或检查到版本变化时，保留已获证据但对象为 `partial`。
- `ci.checks` 携带检查 ID、应用、开始/完成时间、工作流 ID、运行 ID、触发事件及运行创建时间。`workflowRun.latestAttempt` 是工作流这轮读取时的最新尝试；`attempt` 是这一项检查的实际归属。重跑时通过同仓同运行 Jobs 列表中的 `check_run_url` 匹配检查数字 ID，再读 `run_attempt`；验证不了则保留原检查，不猜尝试号，并标记部分覆盖。无 Actions 工作流的检查不适用。不同运行 ID 的同名检查不相互覆盖；不在这里决定 PR 的最终 CI 结论。
- 独立复核后增加防线：已到期的预算不再启动远端调用，缺总数不算读全，同一运行的尝试次数冲突或缺失时不发完整指纹。

## Hub 集成边界

`source.ts` 仍只同步验签、翻译。Hub 的既有 `command` worker 可执行 `node <绝对路径>/plugins/github/hub-collect.ts '{"repo":"HKUDS/DeepTutor","author":"LaiYongqiang"}'`。同一条 cron 规则收到 `schedule.tick` 就做作者发现；本人使用 `agent-autoloop run <规则> --subject github:hkuds/deeptutor:pr:2475` 则只核实该对象。不读手动理由、webhook 内容或外部链接来决定采集范围；空主体、错误对象键及跨仓主体会拒绝，不退回到整仓采集。可为规则设置 `parallel: 1`，一次只运行一个任务，并把定时、各单对象分到不同事项，防止互相合并。

接入 Hub 可参考 [`rules.example.json`](rules.example.json)。配置参数后加 `--receipt`，在对应规则中允许 `emits.source: "github-observation"` 和 `emits.types: ["github.collection.observed", "github.collection.evidence"]`。手动自助入口可以使用仅能提交 `github-request` 的来源密钥，规则只接 `github.verify.requested`，主体仍必须是授权范围内的对象键；不需要把本人密钥交给界面。

回执由一条 `github.collection.observed` 和若干 `github.collection.evidence` 组成，同一轮的 `subject` 为 `github:run:<轮次>`。`readGitHubReceipt` 核对分块完整性和哈希后恢复版本化报告。超出单轮回执容量只回报 `partial / receipt_capacity`，不发布截断的成功结果。应先核准私有仓库内容的留存范围：证据是 Base64 编码，不是加密。省略 `--receipt` 仍可在本机用第二行 JSON 调试。

Hub 的 `done` 不代表 GitHub 核实成功；领域状态必须读回执。当前没有将报告接入 Workbench、持久化基线或替换现网 Tracker。不要在旧定时仍运行时开启生产定时；先验收受理与成功时间区分、失败保留旧结果、订阅生命周期、单派发及回退。

## 隔离 Hub 联调（2026-11-19）

使用现有 Hub 与 worker、临时状态目录和本机随机端口；无通知通道，无生产配置变更。可用 `node tests/github-hub-live.ts <v22 快照绝对路径>` 重跑；该脚本会启动临时 Hub，等待一次真实 cron，并只读访问公开 `HKUDS/DeepTutor`。快照与输出不包含在测试夹具里。运行结束后停止临时 Hub。

- 现网 `tracker-command.json` 已指向 `code-v22`；`source.py`、`tracker_fetchers.py`、`tracker_state.py`、`tracker_text.py` 与之前对照的 `code-v18` 四份文件逐字一致。本次用 `v22` 的 18:05 快照与 18:32（北京时间）的实时结果对照。
- 本人单查 PR #2475、cron 发现 14 对象均完成，同一 PR 的指纹相同；不存在的 Issue 报采集失败，跨仓主体拒绝，匿名不能手动派发。给隔离 Hub 的模拟 webhook 验签通过，坏签名返回 401，重复投递被识别。未从 GitHub 平台主动发起回调。
- 第一轮字段对照发现 CI 检查缺工作流名，已从 GitHub `checkSuite.workflowRun.workflow.name` 补齐。复测无对象增缺或已对照字段差异：基础字段、评论/评审的 ID 与作者和时间、评审状态、旧关联、文件、比较结果及 CI 名称和旧状态均有对应。PR #2501 的 42 条和 #2476 的 46 条原始 CI 记录分别对应 21、23 个唯一名称；旧 Tracker 按名称去重，不能拿原始条数当旧版统计。
- 仅证明这一个公开仓在当时的样本。未对照旧版评论预览文本、CI/分析汇总、行内评审线程、私有仓权限、真实限流或超大分页。保留完整原始 CI 记录，不替消费方选出同名重跑的最终结论。
- 本次定向测试通过 30 项，仓库快速回归通过 743 项、跳过 19 项，类型、格式及差异检查通过。GitHub 源码定向行覆盖为 97.14%，重复检查无候选；Hub 命令的变异测试检出 24/30，仍有 6 项未检出。未跑完整模拟或跨平台 CI。

## 扩展采集复验（2026-11-19）

- 真实只读 `p0deje/Maccy` PR #1262：官方线程总数 34，采集 34 条、46 条行内评论/回复，越过首批 25 条并保留解决状态。子回复续页、作者发现越过 200、CI Jobs 越过 100 则用隔离夹具验证。
- 真实只读 `HKUDS/DeepTutor` PR #2581：23 项检查按 GitHub 检查 ID 匹配到第 2 次执行。模拟同名重跑、不同仓库或运行、计数漂移、重复 ID、证据缺失、预算和页数封顶时，保留已读证据，不报完整或无变化。
- 北京时间 19:18 复跑隔离 Hub：定时和手动同一采集器，同一 PR 指纹一致；仍是 14 对象，与当日 19:00 的发布 Tracker 快照已对照字段无差异。模拟 webhook 验签和重放去重仍通过。未验证私有仓、真实限流、超预算跨轮恢复、Workbench 接纳或现网切换。
- 定向用例 41 项通过；仓库快速回归 750 项通过、19 项跳过，最后新增的 4 个分页边界用例另由定向套件覆盖。类型、格式和差异检查通过。定向行覆盖 96.09%，未发现重复候选；分页和 CI 匹配模块的变异检出 59/76，复杂度阈值 10 尚未全达，最高约 46.4，不作为质量门全绿。

## 实施记录与证据

1. 对照实际命令配置、两份发布 webhook、集成提交、v18 源码和真实快照，仅只读比较 scratch。GitHub 获取字段和 200 上限在 scratch 与 v18 相同；v18 增加列表/对象形状校验、比较结果检查和异常脱敏。生产发布包和快照没有被修改。
2. 在 `f94444d` 的独立工作树先跑通既有 GitHub 验签用例，再补新行为的失败测试和最小实现；独立复核发现的重命名漏报、长编号截断误关联均先复现再修复。隔离测试另覆盖授权参数边界、无变化、内容改动、空发现、失败、部分、分页重复和 CLI 调用。
3. 2026-11-19 18:09（北京时间）真实只读 `HKUDS/DeepTutor`：6 Issue、8 PR，14 个对象的类型、编号和状态与同日 17:00 的 v18 快照逐个匹配；开放 PR #2475、#2730 的重叠文件集合均一致，随后单查 #2475 得 `complete / unchanged`。另一次真实只读请求不存在的 Issue 得 `failed / unknown`。未验证私有仓、真实限流、真实超大分页、Workbench 接纳或平台事件重放。
4. 初版插件的仓库快速回归 737 通过、19 跳过；当时的 GitHub/架构用例 27 通过，类型、格式和差异检查通过。初版插件的行覆盖 99.49%，最高 CRAP 约 9.04，0.8 阈值未见重复候选，变异测试检出 149/198（75.3%）。这些指标针对 Hub 接入之前的版本；未跑全量模拟或跨三平台 CI。
