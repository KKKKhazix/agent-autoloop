---
task_id: 2026-11-11-workflow-visualization-frontend
stage: TASK-05
author: 知识沉淀师
date: 2026-11-11
run_mode: auto
---

## `2026-11-11` | `workflow-visualization-frontend` | 独立流程客户端的事实与验收边界

### 事实投影必须保留事务内顺序

`frontend/src/model.ts` 的 `runFromFacts` 应取最大 `seq` 事实内最后一条匹配轮次的变更。真实 `finish` 在同一事实中多次更新同一轮次，第一次仍可能是 `claimed`；回归测试必须包含这种真实格式，才能防住把已结束任务显示为执行中的错误。

### 分页首页不是完整快照

`GET /v1/state` 首页只含最新 `60` 轮及全部活动轮次，旧长任务结束后会从首页消失。`useConsole.refresh` 保留已加载历史时，要对消失的旧活动编号通过既有 `why` 补读准确状态；不能无限保留旧 `claimed`，也不能仅凭消失推断终态。

### 回答关系跨轮次

`frontend/src/model.ts` 的 `timeline` 除接受 `card.run_id` 属于当前轮次，还要接受 `card.answer_event` 属于当前轮次 `run_events` 的前轮卡片。卡片的创建轮次不会因回答而改变，只按创建轮次过滤会丢掉唤醒续接任务的问题和决定；关联应参考 `host/runtime.ts` 与 `cli/why.ts` 的真实关系，不能靠规则名猜测。

### 独立客户端继续使用既有信任边界

`frontend/` 的包、锁文件和构建与根包隔离，固定同源代理只转发浏览器提供的鉴权头，不注入本人密钥或允许请求选择任意上游。本人密钥用于查询和本人操作，来源密钥单独用于 `/v1/events`，均仅保存在页面内存；写操作结果未知时先刷新核对，不自动重发。

### 表单生命周期与刷新生命周期分开

`App.vue` 在连接切换或断开时重建卡片及事件表单，清空前一连接的回答草稿和来源凭据；正常定时刷新保持表单实例，避免打断输入。同一父节点下的会话键要带不同前缀，例如 `event-` 与 `inbox-`，防止相同代次产生重复键警告。

### 真实浏览器验证补足静态检查

`EventComposer.vue` 的原 `pattern` 在真实 `Chromium` 的 `v` 模式下无效，类型检查与构建都无法发现。删除重复的前端正则后，浏览器验证合法 `subject` 成功、非法对象仍由 `protocol/validate.ts` 的 `parseEvent` 返回 `400`；停止旅程也须验证接单端确认后的终态，不能把请求提交成功当作进程已停。

### 验证结果与环境限制分别记录

本批前端 `10` 条测试、类型、构建、格式及临时真实中台浏览器旅程通过；根 `test:quick` 的 `Windows` 权限、程序查找和清理挂起属于已有基线限制，不能因此宣称全仓库全绿。临时进程退出与目录删除也应分别记录：递归删除被自动审批以 `blocked by policy` 拒绝是工具策略限制，应保留路径并报告，不冒称产品权限故障或换工具绕过。

### 证据入口

- [需求及已确认边界](../workflow-visualization-frontend/01-requirement/requirement-report.md)
- [技术方案](../workflow-visualization-frontend/02-design/tech-design.md)
- [实现与先失败后通过记录](../workflow-visualization-frontend/03-code/change-report.md)
- [独立审查与复审](../workflow-visualization-frontend/03-code/review-report.md)
- [真实浏览器验收及清理限制](../workflow-visualization-frontend/04-e2e/test-report.md)
