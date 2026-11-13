---
task_id: 2026-11-11-workflow-visualization-frontend
stage: TASK-03
author: 开发协调者
date: 2026-11-11
run_mode: auto
---

# 实时流程操作台变更报告

本批新增独立 `frontend/` 客户端：真实流程总览、轮次搜索筛选和历史分页、详情时间线，以及回答卡片、结案、停止任务和独立来源发送事件。每次读取完成后间隔 `3` 秒刷新；凭据只留内存。内核和现有业务接口未改，根运行时依赖未改。

## 并行任务及所有权

- `PT-01`：独立前端工程与测试，由前端实现者完成；协调者补正 `UTF-8` 中文、中文页面标题和内联图标，并核对请求生命周期。全部文件位于 `frontend/`。细节见 [前端草稿](frontend-change-draft.md)。
- `PT-02`：维护文档、架构及忽略规则，由文档实现者完成。细节见 [文档草稿](documentation-change-draft.md)。
- 两个白名单互斥。现有目录没有 `.git`，不宣称进行了 `git diff`；以目标路径及任务报告核对修改范围。未回滚其他线程改动，未写后续阶段正式产物。

## 文件清单

新增 `frontend/package.json`、`package-lock.json`、`tsconfig.json`、`vite.config.ts`、`index.html`、`nginx.conf`、`README.md`。

新增 `frontend/src/main.ts`、`App.vue`、`style.css`、`types/console.ts`、`model.ts`、`service/hub.ts`、`hooks/useConsole.ts`，以及 `components/ConnectionPanel.vue`、`FlowOverview.vue`、`RunList.vue`、`RunDetail.vue`、`CardInbox.vue`、`EventComposer.vue`。

新增 `frontend/tests/console.test.ts`、`fixture.ts`。

修改 `AGENTS.md`、`docs/protocol.md`、`docs/architecture.svg`、`README.md`、`README.en.md`、`INSTALL.md`、`skills/agent-autoloop/SKILL.md`、`SECURITY.md`、`.gitignore`；新增 `.prettierignore`。工作流阶段草稿和本报告仅位于本批 `03-code/`。

没有修改 `kernel/`、`host/`、`worker/`、`protocol/`、`sim/`、根 `package.json` 或旧测试预期。复用现有接口，没有新增、删除或改变业务 `HTTP API`，因此无需新 `api-docs.md`。

## 方案映射

- 固定同源代理：开发/预览由服务端 `AGENT_AUTOLOOP_URL` 决定目标；静态发布提供 `nginx` 参考。浏览器不能通过参数选择代理目标。
- `useConsole` 管理单个连接、取消与代次、状态及详情读取、历史合并、操作反馈；翻页后重新安排刷新，结束分页不重启游标，外部卡片状态变化会更新当前轮次详情。
- `hub` 服务以本人凭据调用查询、回答、结案、停止；发送事件使用显式来源凭据，全部鉴权走头部，写请求不自动重发。
- `model` 只关联真正属于选中轮次的事件/卡片事实；没有伪造事项计数或按规则名猜卡片归属。外部资料用文本插值，链接只允许 `http/https`。
- 前端类型集中独立文件，组件使用组合式 `API` 与 `script setup`，不增加路由、状态库或图编辑器。
- 维护资料明确独立客户端不进入内核；根仍是零运行时依赖。忽略项仅为前端构建与本地工作流/浏览器生成记录。

## Acceptance 验证结果

| 任务 | 验收项 | 结果 | 证据及边界 |
|---|---|---|---|
| `PT-01` | 独立安装、启动、构建和锁文件，根零运行时依赖 | `PASS` | 独立依赖安装、类型检查与构建通过，预览及临时中台已启动 |
| `PT-01` | 流程、筛选及轮次历史详情使用真实状态 | `PASS` | 接口类型与实现对照；真实 fixture 连接成功，完整操作旅程留后续阶段 |
| `PT-01` | 四类写操作权限、端点正确且不自动重发 | `PASS` | 服务与组件对照，凭据隔离及单次写请求测试通过 |
| `PT-01` | 定时刷新、旧响应、分页、失败和恢复 | `PASS` | 生命周期及分页跨定时器、旧连接/详情响应、外部卡片变化测试通过 |
| `PT-01` | 测试先失败后通过，类型、构建和格式通过 | `PASS` | 首次缺实现模块红灯，完成实现后测试全通过；命令见下文 |
| `PT-01` | 临时真实中台入口与无虚构连接状态 | `PASS` | fixture 真启动，隔离目录/随机端口；未连接显示占位符 |
| `PT-01` | 双栏、窄屏、键盘、文本资料 | `PASS` | 响应断点、按钮及表单语义、焦点样式均实现；真实桌面/窄屏交互验收仍须 `TASK-04` 取证 |
| `PT-02` | 协议与全部目标说明一致 | `PASS` | 旧能力限制检索及全部文档入口核对通过 |
| `PT-02` | 本人/来源权限、固定代理、正式部署 | `PASS` | 协议/安全/安装说明与实际实现相符 |
| `PT-02` | 无后端契约、旧预期和根依赖改动 | `PASS` | 所有改动在文档及独立前端白名单 |
| `PT-02` | 生成记录排除，源码仍检查 | `PASS` | `.prettierignore` 排除 `frontend/dist/`、`artifacts/`、`.devflow/`、`.playwright-cli/` |

这里的通过是开发阶段实现与自检完成，不代表后续独立审查或完整浏览器旅程已经完成。

## 执行验证

`npm --prefix frontend test`：全部通过，覆盖凭据分离、历史合并、安全链接/真实轮次关联、旧连接、分页跨定时器、旧详情响应和外部卡片变化。时间戳类型校正与最终通过数量详见前端草稿。

`npm --prefix frontend run typecheck`、`npm --prefix frontend run build`、`npm --prefix frontend run format:check`：通过。构建资产约 `92 KB` 脚本与 `11 KB` 样式，仅记录实测。源码连续问号乱码检索无残留。修改前先读取，测试先行记录见草稿。

主线程根验证：`npm run typecheck` 通过；`node --test tests/purity.test.ts` 的 `8` 条全部通过。根 `test:quick` 在未改后端的基线已有 `Windows` 上权限、适配器/程序查找和清理失败，随后长期未退出，主线程终止了自己的测试进程树；不能记成全绿。`http/why/stream/purity` 子集也在 `HTTP` 已通过断言后遇到现有清理失败，已停止，不反复跑同样套件。主线程最终再次运行 `npm run typecheck` 与 `npm run format:check`，均通过。

## 遗留与风险

独立审查、真实浏览器完整操作、窄屏与错误恢复验证属于下一阶段。没有运行真实业务部署、外部消息、真实交付、模拟或每日变异；本次不改内核与调度，不需要扩大这些验证。fixture 是临时真实中台，执行程序尚未真正运行；停止请求不等于进程已停，测试需用临时 worker 身份确认。验收后必须结束 fixture 与开发服务器并清理临时资源。


## 独立审查后的本批修复

正式独立审查发现 `CR-001/CR-002` 两项必须修复问题，已各自先加入会失败的回归用例，再修改实现。

- `CR-001`：首页只提供最近 `60` 轮及全部活动轮次。此前活动轮次从首页消失时，仅针对这些缺失的旧活动编号读取 `why`，按最新全量 `runs` 投影精确更新状态、摘要、错误、取消标志、起止时间及用量；不猜测已完成，不查询全历史。请求使用同一连接快照与取消信号，旧连接不能覆盖新数据；补查失败保留原行并显示陈旧错误。
- `CR-002`：卡片关联同时接受本轮创建的卡片与 `answer_event` 属于本轮事件集合的前轮卡片；保留原问题与回答，继续排除无关卡片。新增回归同时检查前轮与续接轮次。
- `CR-003`：时间线中文名称使用真实事实类型 `claimNext/started/finish/ingest/answer/cancel/resolve`，不再按接口路径猜名字。
- `CR-004`：每次连接切换递增表单会话标识，清空卡片回答/理由和事件来源密钥草稿；正常定时刷新不卸载表单，不影响正在填写的内容。

修改均在原 `frontend/` 白名单内，没有新增或修改后端接口，接口文档无需变更。新增两条测试先失败后通过，最终前端共 `9` 条测试；类型、构建与格式检查通过，具体红绿记录见前端草稿。下一步由原独立审查员复审，完整浏览器旅程仍由测试阶段执行。


### 复审补正

复审按真实日志指出同一条 `finish` 事实中可能多次写入相同轮次：第一条仍为 `claimed`，后续才是终态。先新增包含同一事实 `3` 次变更的回归，原实现得到 `9` 条通过、`1` 条失败，明确复现错误的 `claimed`。随后改为最新事实中的最后一条同轮次变更，匹配持久投影顺序。另按真实浏览器告警给事件表单及卡片区的会话键加不同前缀，避免同级重复键。

最终共 `10` 条前端测试；类型、构建与格式检查重新验证通过。没有新增接口或后端改动，原接口文档无需变更。

### 浏览器验收发现的输入校验修复

`TASK-04` 在真实 Chromium 输入事件对象时捕获到无效 `pattern` 的 Console 错误：浏览器使用 `v` 模式解释字符类，原表达式中的斜杠不兼容。根据这一实际失败记录，删除 `EventComposer.vue` 的该属性，保留后端既有 ASCII 标识符校验，不增加新正则。此项已有真实浏览器失败证据，不另建复述属性的测试。`npm --prefix frontend run build`（包含类型检查）通过；单文件格式化后 `npm --prefix frontend run format:check` 通过。测试阶段只需复验输入及 Console，完整已通过旅程无需重复。
