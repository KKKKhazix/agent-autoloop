# 流程运行台

从零启动请按[前后端启动步骤](../docs/frontend-backend-startup.md)操作，包含 `Windows PowerShell` 演示模式和 `WSL2` 完整运行。

独立的 `Vue 3` 客户端，通过原有 `/v1` 接口读取状态、查看轮次时间线、回答卡片、结案、停止及发送来源事件。不改中台内核，不提供规则编辑或拖拽编排。

## 本地运行

需要 `Node 24` 或以上，在仓库根目录执行：

```powershell
npm --prefix frontend ci
$env:AGENT_AUTOLOOP_URL = "http://127.0.0.1:7317"
npm --prefix frontend run dev
```

打开终端输出的本机地址（通常为 `http://127.0.0.1:5173`），在“连接设置”输入中台本人密钥。后端地址固定在服务端环境变量 `AGENT_AUTOLOOP_URL`，默认 `http://127.0.0.1:7317`；需要先启动自己的中台。开发与预览服务器均只监听回环地址，浏览器不会直连任意后端。

本人密钥可查询、回答、结案和停止。发送事件表单需要独立的来源密钥，不能使用本人密钥。所有密钥仅在页面内存中保存，不写入网址、磁盘或构建产物；刷新页面后需重新输入。断开连接会清空当前连接及页面数据，关闭发送事件表单会丢弃该表单的来源密钥。

界面采用 `Vue Flow` 只读运行画布、轮次列表和执行轨迹面板。连接后通过带本人鉴权的 `fetch` 订阅 `/v1/stream`，收到事实时合并触发状态读取，时间线按轮次或卡片变化更新。首次从日志序号 `0` 流式追读（页面只保留最近 `12` 条动态），断线从已接收序号续传；当前接口没有最新游标端点，大历史实例首次订阅需要追读历史。实时连接失败会保留旧数据并明确标记过期，暂停连线和节点动画，随后自动重连。可以手动刷新状态。写操作不自动重发；网络错误后应先刷新核对。停止请求被接收不等于子进程已停止，以后端最终状态为准。

## 验证与构建

```powershell
npm --prefix frontend test
npm --prefix frontend run typecheck
npm --prefix frontend run build
npm --prefix frontend run format:check
npm --prefix frontend run preview
```

`preview` 仅用于本机验收。正式部署将 `dist/` 交给静态服务器，同时将 `/v1/` 代理到固定中台，参考 [nginx.conf](nginx.conf)，公网部署须配置 `HTTPS`，关闭反向代理的流缓冲并允许长连接（示例已包含 `proxy_buffering off` 和读取超时），不要启用通配跨域、任意目标代理或自动注入密钥。

## 隔离的浏览器验收

```powershell
npm --prefix frontend run fixture
```

该命令创建临时数据目录与随机端口的真实中台，种下问题卡片、通知和运行中的轮次，不启动真实 Agent，不发真实通道消息。终端输出临时 `url`、`owner`、`source` 和 `worker`。在另一个终端把 `AGENT_AUTOLOOP_URL` 设置为输出的 `url` 后启动前端。用输出的 `owner` 连接；可测试回答、结案、停止（运行中停止需接单程序确认）、发送 `feedback.new` 类型事件。按 `Ctrl+C` 结束并清理临时目录。所有输出密钥仅用于这个测试中台。
