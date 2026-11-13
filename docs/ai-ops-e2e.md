# AI-OPS 只读端到端检查

被测项目为 `D:\programs\ai\ai-ops`，在 `WSL` 中对应 `/mnt/d/programs/ai/ai-ops`。只检查页面，不修改业务代码、不安装或替换该项目的依赖，不对真实业务接口执行写操作。

## 配置位置

- 中台规则：`/home/edy/.agent-autoloop-local/rules.json`。
- 检查规则与 Agent：`AI-OPS 只读端到端检查`、`ai-ops-e2e`。
- 事件类型：`ai-ops.e2e`，来源：`local`。
- 工作目录：`/mnt/d/programs/ai/ai-ops`。
- 独立测试目录：`/home/edy/.agent-autoloop-local/checks/ai-ops-e2e`。
- 运行器：`e2e 0.23.0` 与 `@e2e-dev/web 0.15.5`。

测试复用 `Windows` 上已经运行的 `ai-ops` 开发服务器，端口为 `5173`。运行时从 `WSL` 默认路由获取宿主地址，通过仅监听回环地址、由运行器管理生命周期的临时转发连接页面。没有改动项目的 `Vite` 配置。

## 再次运行

先确认 `ai-ops` 页面可在 `Windows` 的 `http://127.0.0.1:5173` 打开，并且流程中台在运行。

在 `PowerShell` 进入 `WSL`：

```powershell
wsl -d Ubuntu -u edy
```

进入后执行：

```bash
source "$HOME/.agent-autoloop-local/env.sh"
node "$HOME/.agent-autoloop-local/checks/ai-ops-e2e/run-check.mjs"
```

也可以直接在 `PowerShell` 执行下面这一条，由中台派发检查，不需要手动填写来源密钥：

```powershell
wsl -d Ubuntu -u edy -- bash /home/edy/.agent-autoloop-local/checks/ai-ops-e2e/trigger-check.sh
```
通过操作台触发时，点击“发送事件”，事件类型填 `ai-ops.e2e`，事项对象填 `ai-ops`，事件编号每次换新。来源密钥填写中台配置中的 `source.key`，与连接页面的本人密钥不同。执行记录会显示这条检查规则以及最终检查数量、报告位置。

## 检查范围

- 未登录入口与空表单校验。
- 推荐问题切换、输入框和发送按钮状态，实际不发送问题。
- 问答与知识库页面导航。
- 无效路由回到问答页面。
- 使用隔离的模拟 `401` 检查过期凭证清除和重新连接。
- `390px` 窄屏下连接表单、问答入口和横向溢出。

真实业务接口由测试拦截，不会提交数据。模拟过期登录不代表真实账号登录通过；真实流式问答、上传、文档修改、删除和账号权限均未验收。

报告位于独立测试目录的 `.e2e/report.json`、`.e2e/summary.md`，每项的步骤和截图位于 `.e2e/results/`，运行日志为 `last-run.log`。

## 本次结果

`2026-11-13` 已完成直接执行与中台事件派发验证，补装中文字体后再次通过。最近中台轮次 `#6` 为 `done`，记录“AI-OPS 只读端到端检查完成：6 项通过，0 项失败，0 项跳过”。

WSL 中的测试运行器和 Linux 无头浏览器均已实际启动；被测页面复用的是 Windows 开发服务，并未将项目开发服务器迁移进 WSL。没有修改 `ai-ops` 的业务代码或包文件。

- [本次 e2e 汇总](../output/ai-ops-e2e/summary.md)
- [机器可读报告](../output/ai-ops-e2e/report.json)
- [桌面连接表单截图](../output/ai-ops-e2e/results/readonly-signed-out-entry-shows-884946c9e87ba17e/attempt-1/screenshots/001-signed-out-login.png)
- [窄屏问答截图](../output/ai-ops-e2e/results/readonly-390px-viewport-keeps-login-99a96a5fa725468b/attempt-1/screenshots/002-mobile-chat.png)

这批测试验证了未登录与模拟过期登录的前端行为；真实账号登录、真实模型问答、上传、文档预览和图谱数据等业务流程，仍需专用测试账号和测试数据后再验收。
