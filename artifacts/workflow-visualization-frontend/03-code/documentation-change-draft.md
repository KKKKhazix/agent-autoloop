---
task_id: 2026-11-11-workflow-visualization-frontend
stage: TASK-03
author: 文档子开发者
date: 2026-11-11
run_mode: auto
---

# 文档与边界调整草稿

## 改动范围

仅修改计划 `PT-02` 白名单：

- `AGENTS.md`：明确内核不提供界面，独立 `frontend/` 只走现有协议；零运行时依赖指根中台，前端单独管理。
- `docs/protocol.md`：增加独立客户端说明、每 `3` 秒自动刷新、操作与凭据边界、固定代理和部署入口、目录说明；删除过时的无总览声明，保留现有 `/v1` 兼容约定。
- `docs/architecture.svg`：标题承认独立客户端，在“你”的框外标明命令行与流程操作台，不改变内核或插件连接。
- `README.md`、`README.en.md`：替换无界面声明，提供独立安装/启动/构建步骤、内存凭据、来源身份与固定代理说明，新增操作台文档入口及目录行；性能表的零依赖限定为中台。
- `INSTALL.md`：新增可选操作台步骤，不让安装器默认启动或安装前端，不改变中台平台支持声明。
- `skills/agent-autoloop/SKILL.md`：将“替用户重写页面”改成使用独立操作台，说明命令、刷新、权限及部署。
- `SECURITY.md`：说明本人密钥写权限、来源凭据分离、内存凭据、纯文本显示、停止状态、固定同源代理与对外 `HTTPS`。
- `.gitignore`：忽略 `frontend/dist/` 和本轮浏览器生成的 `.playwright-cli/`；不忽略 `.devflow/`。
- `.prettierignore`：忽略 `frontend/dist/`、本地 `artifacts/`、安装器生成的 `.devflow/` 和浏览器生成的 `.playwright-cli/`，源码仍受格式检查。

未修改前端实现、后端、接口、测试预期、根依赖或工作流状态。

## 验收结果

| 验收项 | 结果 | 依据 |
|---|---|---|
| 全部目标文档与架构图表述一致 | `PASS` | 已替换无界面、无总览与重写页面的旧约定，明确客户端边界 |
| 权限、代理及部署说明 | `PASS` | 本人和来源分离，固定服务端目标，内存凭据，同源部署及 `HTTPS` |
| 不改变后端与旧协议 | `PASS` | 仅文档与忽略配置改动；保留 `/v1`、插件和根零依赖 |
| 构建和工作流资料忽略、源码仍检查 | `PASS` | 格式忽略仅添加 `frontend/dist/`、`artifacts/`、`.devflow/` 和 `.playwright-cli/` |

## 已执行检查

- 定向 `rg` 检索所有目标文档中的“没有界面”“没有后台界面”“没有总览页”“这里没有网页”“No web dashboard”“不进这个仓库”，无残留。
- 用 `Python` 严格读取全部目标为 `UTF-8`，检查无替换字符和连续问号损坏，通过。
- `xml.etree.ElementTree.parse` 解析 `docs/architecture.svg`，通过。
- 校验两份 `README`、`INSTALL`、`SECURITY`、协议和正式 `SKILL` 均含操作台文档入口与 `AGENT_AUTOLOOP_URL`，通过。
- 校验 `.prettierignore` 只含四条目标规则，通过。主线程根格式检查发现安装器生成的 `.devflow/install-state.json` 是额外警告，按协调者授权将 `.devflow/` 排除，不修改该生成文件。按主线程后续授权，将本轮浏览器生成的 `.playwright-cli/` 同时加入格式与版本控制忽略，不扩大到其他工作流资产。

根测试与全仓格式检查由主协调统一执行。前端文档链接目标由并行前端任务创建，最终需一并核对；此阶段未声称已完成浏览器验收。
