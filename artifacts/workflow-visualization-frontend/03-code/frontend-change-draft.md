---
task_id: 2026-11-11-workflow-visualization-frontend
stage: TASK-03
author: 前端开发
run_mode: auto
date: 2026-11-11
---

# 前端实现草稿

独立 `frontend/` 已创建：`Vue 3`、`Vite 7`、`TypeScript 5.9`，独立锁文件。无路由、图编辑器、组件库、状态库；根依赖未改。

## 变更文件

- `frontend/package.json`、`package-lock.json`、`tsconfig.json`、`vite.config.ts`、`index.html`、`nginx.conf`、`README.md`。
- `frontend/src/main.ts`、`App.vue`、`style.css`、`types/console.ts`、`model.ts`、`service/hub.ts`、`hooks/useConsole.ts`。
- `frontend/src/components/ConnectionPanel.vue`、`FlowOverview.vue`、`RunList.vue`、`RunDetail.vue`、`CardInbox.vue`、`EventComposer.vue`。
- `frontend/tests/console.test.ts`、`fixture.ts`。

## 实现及验收

- 暖灰、陶橙中文流程总览，四段节点与闭环、运行指标、轮次搜索筛选及分页、详情侧栏、原文折叠时间线，手机断点堆叠。
- 所有数据来自真实 `state/why`，未连接用占位符；事项不伪造数量，卡片用事实中的 `run_id` 关联。
- 回答、结案、停止、独立来源事件使用正确现有端点；确认界面标记目标；提交期间禁用重复动作，写请求不自动重试。
- 凭据仅内存，`Bearer` 请求头；同源固定目标代理，不向浏览器注入后端密钥。链接只允许 `http/https`，文字用插值渲染。
- 单一轮询生命周期，每次读取后间隔 `3` 秒；取消和代次拒绝旧连接/旧详情；分页不丢已加载历史，分页结束重新安排轮询；外部卡片变化刷新当前详情；请求 `15` 秒截止。刷新失败保留旧数据显示陈旧提示，不将已成功写请求改成失败。
- 窄屏网格、文本换行、可见焦点、`aria-pressed` 与表单标签已实现；真实浏览器证据留给 `TASK-04`，不冒称已通过。

## 测试证据

实现前写 `console.test.ts`，执行 `node --test frontend/tests/console.test.ts`，因为尚无 `src/service/hub.ts`，得到 `ERR_MODULE_NOT_FOUND`，测试文件失败。随后实现模块并执行测试。

当前 `npm --prefix frontend test`：`7 passed`，覆盖凭据分离及写请求不重发、历史合并、安全链接/轮次关联、旧连接响应、分页跨定时期限、旧详情响应、外部卡片改变刷新详情。

`npm --prefix frontend run typecheck` 通过；`npm --prefix frontend run build` 通过（约 `92 KB` 脚本、`11 KB` 样式，数字为实测非门槛）。`npm --prefix frontend run format:check` 首次全过，后续标题修改引起 `index.html` 格式告警，已重新格式化并复查。中文经协调者修复为正确 `UTF-8`。

官方 `npm view` 查询确认 `vue 3.5.45`，`vite 8.3.8` 为查询时版本；本次选兼容 `vite 7`、`plugin-vue 6`、`TypeScript 5.9` 组合，实际解析均写入锁文件。网页工具官方文档查询未返回内容，不将其算文档核验成功。

## 实际中台验收入口

`npm --prefix frontend run fixture` 创建隔离临时目录和随机端口真实中台，种下问题、通知、运行中轮次，不启动实际 Agent 或通道。运行时输出 `url/owner/source/worker`，将另一终端的 `AGENT_AUTOLOOP_URL` 设为 `url` 再启动前端。`owner` 用于页面连接，`source` 用于事件，规则匹配 `feedback.*`。按 `Ctrl+C` 关闭会清理临时目录。

本轮 fixture 实际启动成功于 `http://127.0.0.1:51502`。临时密钥仅进程输出，不写入仓库文档。fixture 会话暂由开发代理保持供验收复用，结束后必须关闭；如果需要独立复现，重新运行命令会创建新端口及新凭据。

## 已知边界

未连接真实业务部署，未发送外部消息，未执行真实交付。停止运行中轮次仅提交请求，仍需接单程序确认；fixture 自身没有长期执行程序，验收可用输出的 worker 密钥完成确认。凭据不持久化，重新打开页面需重新连接。无 `SSE` 推送，刷新口径如实标明。
## 最终类型与事实名称核对

`Fact.at` 已按真实事实模型改为毫秒 `number`，时间格式化接受 `string | number`。现有安全/事实测试加入固定数字时间断言，确认非无效日期。时间线中文标题使用真实输入类型 `work/result/answer/event`，其余保留原事实类型。修改后 `7` 条测试、类型检查与格式检查再次通过，生产构建再次通过。
## 独立审查修复（CR-001 至 CR-004）

先新增两条回归行为测试并实际运行：旧活动轮次从新首页消失、前轮提问卡片的回答唤醒新轮次；原实现得到 `7` 条通过、`2` 条失败。之后才实现修复。

- `CR-001`：只查先前活动且在新首页缺失的轮次；使用其 `why` 最新 `runs` 投影，集中 `runFromFacts` 把真实 `snake_case` 映射到已有查询字段（含状态、摘要、错误、次数、时间、停止及用量）。不猜测终态，不扫描完整历史；补查使用原连接快照与取消信号，代次变化即丢弃，失败保留旧行并明确报错。
- `CR-002`：时间线同时保留本轮创建的卡片，以及 `answer_event` 属于本轮 `run_events` 的前轮卡片，仍过滤无关卡片和轮次；新测试同时核对前一轮原提问及回答仍可见。
- `CR-003`：中文事实名称采用真实的 `claimNext/started/finish/ingest/answer/cancel/resolve/rules`。
- `CR-004`：连接切换或断开时递增本地会话键，重建卡片及事件表单并清空草稿；正常定时刷新不重建表单。

修复后 `9` 条行为测试、类型检查、格式检查及构建全部通过。文件仍在既定前端白名单，未改后端或协议。
## 同事实多次投影与表单键复核

复审发现真实 `finish` 会在同一事实内多次写同一轮次。先新增同一事实中 `claimed → cancelled → cancelled` 三次投影测试，得到 `9 passed / 1 failed`（旧实现误取 `claimed`）。随后将 `runFromFacts` 改为最新事实中最后一条匹配变更，测试验证最终状态及最终摘要。另将事件表单与卡片列表的会话键加各自前缀，消除同层重复 `key`。修改后 `10` 条测试、类型检查、格式检查及构建通过。