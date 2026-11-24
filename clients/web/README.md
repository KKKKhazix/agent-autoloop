# Agent Autoloop 本地控制台

这是当前仓库配套的中文 React + TypeScript 客户端。Vite 构建静态页面，一个本机 Node 进程把页面操作转给原生 Hub、CLI 和配置文件。客户端依赖单独安装。

## Windows 启动

1. 安装 Node.js 24 或更高版本。在已初始化的 Agent Autoloop 主机上，可直接使用现有配置。第一次使用时，在仓库根目录运行下列命令，按原生提示配置已安装的 Agent。

   ```powershell
   node bin/agent-autoloop.ts init --no-service
   ```

2. 双击本目录的 **start.cmd**。它会安装客户端依赖、构建页面并打开默认浏览器。保留启动窗口。默认地址为 `127.0.0.1:4317`，完整链接中的随机值仅在本次客户端启动期间有效。更换浏览器时，请从窗口复制完整链接。
3. 已运行的 Hub 会自动连接。手动安装的 Hub 可在「系统设置 → 启动原生进程」启动。在「任务管理 → 发布任务」选择一个生效的规则，填写本轮说明，提交后可打开轮次详情。Agent 提问时到「审核与审批」作答。

手动启动时，在本目录运行：

```powershell
npm ci
npm run build
npm start
```

客户端遵循原生 `AGENT_AUTOLOOP_HOME` 和 `AGENT_AUTOLOOP_RULES`。要使用另一套本机配置，请在同一个终端设置环境变量后启动。可用 `AGENT_AUTOLOOP_WEB_PORT` 调整控制台端口。Hub 连接取自 `config.json` 的 `url`。本人密钥保存在本机配置中。首次使用 GitHub 详情查询前，在本机完成 `gh auth login`。

## 页面与原生能力

| 页面 | 可用操作 | 数据及操作入口 |
| --- | --- | --- |
| 运行看板 | 查看 Hub、Worker 心跳、关联 Agent、任务统计、今日及近七天用量、待处理与异常 | `GET /v1/state` 的 agents、totals、spending、cards、channels、runs |
| 任务管理 | 用自然语言说明本轮任务、执行已有规则、停止轮次、按规则翻查历史、打开时间线和会话 | `POST /v1/rules/:rule/run`、`POST /v1/runs/:id/cancel`、原生 `readRuns`、`GET /v1/runs/:id/why` |
| 工作流 | 编辑名称、Agent、目录、触发条件、提示词及执行参数，暂停、恢复、补跑、立即运行，查看外部定时任务 | 本机 `rules.json`、原生 `parseRules`、`/v1/rules/:rule/{pause,resume,replay,run}` |
| Agent 管理 | 登记 Agent、选择本机插件和 Worker、配置插件实际读取的模型、推理强度、权限、启动参数及原生超时和并发 | `rules.json.agents`、原生插件目录、`GET /v1/state` 的 agents 字段 |
| 审核与审批 | 回答问题卡片、提交文字、确认通知、按说明结案、查看处理结果 | `state.cards/recentCards`、`POST /v1/cards/:id/{answer,resolve}` |
| GitHub 交付 | 查看 delivery Agent 指定的仓库、规则、回执和链接，按需读取 main 项目配置及指定 PR 的审核和 CI，在确认后运行已有规则 | `rules.json`、原生轮次与卡片、插件所用的已登录 `gh`（只读查询）、原生规则 `run` |
| 运行日志 | 实时查看最近收到的 160 条事实，展开原文、查看历史执行与单轮详情 | 快照 `seq` 后接 `GET /v1/stream`，断线从最后一条序号续读；历史复用 CLI 的 `readRuns` 与 `formatWhy` |
| 系统设置 | 环境诊断、配置 Hub 地址与监听、编辑完整规则、调整 Worker 并发与失联通知命令、启动和停止本客户端拉起的进程、调用更新 | `GET /healthz`、`config.json`、原生 CLI 的 `doctor`、`up`、`update` |

## 使用边界

- 自然语言说明作为 `run --reason` 进入事件资料。请先选定规则，Agent、工作目录与权限取自规则。原生引擎管理重派和退避。等待重派的轮次可从详情发起同规则、同事项的手动运行。终态轮次没有按原编号重试的原生接口。
- 恢复规则后，如原生响应包含跳过的来源事件，可当场选择补跑，也可在工作流中填写起始时间。定时规则错过的时间点由原生机制跳过。
- Worker 状态来自接单心跳。同一 Worker 上的 Agent 共享在线状态，插件登录诊断请使用「环境诊断」。用量仅统计原生上报值，缺报轮次单列。
- 可视化编辑保留完整配置里的其他字段。高级选项、第三方插件和外部定时任务可用「完整 JSON」编辑。保存前调用与 CLI `check` 相同的校验器，成功后由原生文件监听器加载。检测到其他编辑时，请关闭草稿、刷新后重试。Worker 配置在下次启动时生效。
- GitHub 页面只在主动查询时访问配置仓库的 `main:ops/delivery.json` 或指定的 PR。按 Agent 插件 `use: "delivery"` 识别项目。用任意脚本封装的交付规则在工作流、轮次和日志中查看。审核决策、PR 创建、分支、合并、Ship 及复查均遵循已有交付流程。需要 GitHub 写权限的操作由原生插件负责。
- 关闭客户端会结束它启动的 `up` 子进程；已安装的登录服务继续由系统管理。Hub 停止和停止某一轮是两个独立操作。`update` 针对本仓库检出，沿用 CLI 的发布版本或分支更新策略。更新客户端源码后重新启动并构建页面。
- 插件安装、密钥、加入远端 Worker、备份恢复、系统服务安装及卸载等运维命令继续使用原生 CLI。密钥与通道凭据在本机配置中维护。仅接活、没有 owner 密钥的机器可以查看本机设置，查看全局运行情况需要本人身份。

## 验证

在本目录运行 `npm run typecheck`、`npm test` 和 `npm run build`。仓库根目录的 CLI、依赖与测试照常使用。协议细节见[原生协议](../../docs/protocol.md)，引擎安装见[安装说明](../../INSTALL.md)。
