# Windows 一键启动流程操作台

## 每次怎么启动

在资源管理器打开 `D:\github\agent-autoloop`，双击仓库根目录的 `start.cmd`。

脚本会依次：

1. 进入当前电脑的 `Ubuntu`，使用 `edy` 用户加载既有运行环境。
2. 读取 `~/.agent-autoloop-local/config.json`，检查后端；已运行则复用，没有运行才启动。
3. 检查并启动前端，默认使用 `http://127.0.0.1:5193`。
4. 验证前端代理能使用本人密钥读取当前中台。
5. 将本人密钥复制到 `Windows` 剪贴板，自动打开浏览器。

在网页“本人密钥”输入框按 `Ctrl+V`，点击“连接中台”。密钥仍需由你提交，脚本不会把密钥写进网址或网页资源。刷新网页后重新粘贴连接；重复双击也会重新复制密钥。

启动成功后，启动窗口会关闭，前后端进程继续在后台运行。它没有注册系统服务或开机自启，电脑重启后再次双击即可。如果失败，窗口会保留错误提示。

这个入口启动的是 `agent-autoloop` 的中台和流程操作台；`ai-ops` 等被测项目仍按自己的启动方式运行。

## 使用前提

当前电脑已经完成[WSL 部署](wsl2-deployment.md)。入口沿用已有数据、规则和中转站配置，不重新初始化，也不自动安装依赖。

初次换电脑或发行版时，先完成部署。当前默认参数为 `Ubuntu`、`edy`、前端端口 `5193`；其他环境可以在 `PowerShell` 指定：

```powershell
cd D:\github\agent-autoloop
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\start-console.ps1 -Distribution Ubuntu -LinuxUser edy -FrontendPort 5193
```

仓库路径由启动脚本位置确定。中台数据目录优先沿用 `AGENT_AUTOLOOP_HOME`，默认 `~/.agent-autoloop-local`；存在该目录下的 `env.sh` 时会加载它，包含本机已有的 `CODEX_HOME`。

## 看起来卡住时检查什么

- **输入框显示密钥，但之前连接按钮点不了：** 页面已修正为提交时读取实际输入值，浏览器自动填充后也能提交。更新后刷新页面，再粘贴本人密钥。
- **端口被占用：** 脚本不会结束占用端口的其他项目。当前 `5173` 已由 `ai-ops` 使用，操作台使用 `5193`。
- **前端能打开但代理验证失败：** 有一个旧前端连到了不同中台，停止这个旧前端后重新双击；后端地址来自本次实例的配置。
- **前端依赖缺失：** 进入 `WSL` 项目目录执行 `npm --prefix frontend ci` 后，再双击。
- **修改了源码但页面仍是旧版：** 本机项目放在 `Windows` 盘符中，`WSL` 的文件监听可能未收到改动。停止本项目前端后重新启动，或在原来的前台启动窗口按 `Ctrl+C` 后再次双击。

日志在 `Windows` 的 `%LOCALAPPDATA%\AgentAutoloop\logs`：

| 文件 | 内容 |
| --- | --- |
| `backend.log`、`backend.error.log` | 后端运行输出和错误 |
| `frontend.log`、`frontend.error.log` | 前端运行输出和错误 |

若复用的是之前手动启动的服务，其输出仍在原启动窗口；新日志只来自本脚本启动的进程。

## 停止本次后台服务

如果仍有运行中的任务，先在网页请求停止并等待执行端确认。后台中台停止后，真实 Agent 子进程仍可能继续运行，不能把“中台退出”当作任务已经停止。

后台运行时可先在 `PowerShell` 打开 `WSL`：

```powershell
wsl -d Ubuntu -u edy
```

停止中台，在 `WSL` 中执行：

```bash
kill -TERM "$(cat "$HOME/.agent-autoloop-local/up.pid")"
```

该命令使用当前数据目录记录的中台进程号。停止前确认该实例仍在运行；如果以前的前台窗口还开着，优先在原窗口按 `Ctrl+C`。前端可以继续保留，后端再次启动后页面可重新连接。下次需要时重新双击 `start.cmd`。

## 验证命令

启动器的端口与服务识别检查：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\tests\start-console.test.ps1
```

连接表单的浏览器回归（在前端已运行时）：

```powershell
npx --yes --package @playwright/cli playwright-cli -s=connection-check open http://127.0.0.1:5193
npx --yes --package @playwright/cli playwright-cli -s=connection-check run-code --filename frontend/tests/connection.browser.js
npx --yes --package @playwright/cli playwright-cli -s=connection-check close
```

该回归使用测试用假密钥和模拟拒绝响应，不会提交业务操作。

## 本机验证结果

`2026-11-13` 已验证停止后的首次启动、重复启动复用进程、其他应用占用端口时拒绝启动，以及 `start.cmd` 实际打开浏览器并复制密钥。自动填充不触发输入事件的失败场景已先复现、修正后通过；真实本人密钥连接和实时同步也通过。

快速测试 `635` 项通过、`3` 项跳过；前端 `14` 项测试、构建、类型和格式检查通过。根项目类型与格式检查沿用当前 `Windows` 工具环境通过。
