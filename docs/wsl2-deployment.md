# 在 WSL2 中启动真实 Agent 和前端

这份文档可以独立使用：在本机 `WSL2` 中运行真实后端、命令行 `Agent` 和前端流程操作台。采用前台运行方式，关闭终端后不会作为系统服务自动启动。

## 启动前准备

- 使用 `Windows 11` 或 `Windows 10 2004`（内部版本 `19041`）及以上版本。尚未安装 `WSL2` 时，先按下面的“第零步”安装。
- 仓库位于 `D:\github\agent-autoloop`，对应 `WSL2` 路径 `/mnt/d/github/agent-autoloop`。仓库在其他位置时，替换下文的 `cd` 路径。
- 在 `WSL2` 中准备 `Node.js 24+`、`npm` 和已登录的命令行 `Agent`。第一步包含检查及缺少工具时的安装方法。
- 准备三个 `WSL2` 终端窗口：窗口一运行后端，窗口二运行前端，窗口三触发试跑或查询状态。

| 配置 | 本文使用的值 |
| --- | --- |
| 仓库路径 | `/mnt/d/github/agent-autoloop` |
| 持久数据目录 | `~/.agent-autoloop-local` |
| 后端地址 | `http://127.0.0.1:3350` |
| 前端地址 | 通常为 `http://127.0.0.1:5173`，以启动输出为准 |
| 默认命令行 `Agent` | `codex`，也可选择 `claude` |

## 第零步：打开并进入 `WSL2`

### 0.1 打开 `Windows PowerShell`

按 `Win+R`，输入 `powershell`，再按回车。看到类似下面的提示符，说明当前还在 `Windows PowerShell`：

```text
PS C:\Users\EDY>
```

下文标注“在 `Windows PowerShell` 执行”的命令，就粘贴在这个窗口中。只复制命令代码块里的内容，不要复制示例提示符或代码块的语言名称；每条命令粘贴后按回车，等待完成后再执行下一条。

### 0.2 检查有没有安装 `Linux` 发行版

**在 `Windows PowerShell` 执行：**

```powershell
wsl --list --verbose
```

已经安装时，输出类似：

```text
  NAME      STATE           VERSION
* Ubuntu    Stopped         2
```

- `NAME` 是发行版名称。本文以 `Ubuntu` 为例；如果你看到的是 `Ubuntu-24.04` 等名字，将下文所有命令里的 `Ubuntu` 换成这个实际名称。
- `VERSION` 为 `2`，表示使用 `WSL2`。
- `Stopped` 表示当前没有运行，执行下一步的进入命令就会启动它。
- 已有可用的 `WSL2` 发行版，直接跳到 `0.3`，不必重复安装。

如果提示没有安装发行版，或尚未启用 `WSL`：右键开始菜单，选择“终端（管理员）”或“Windows PowerShell（管理员）”，在管理员窗口执行：

```powershell
wsl --install -d Ubuntu
```

等待安装完成，按提示重启电脑。重启后从开始菜单打开 `Ubuntu`，按提示创建一个 `Linux` 用户名和密码。这组用户名和密码由你设置，可以与 `Windows` 账号不同；输入密码时不显示字符是正常的。完成后重新执行 `wsl --list --verbose` 检查。

如果已经安装的发行版显示 `VERSION` 为 `1`，先结束其中运行的程序，备份重要文件，再在 `Windows PowerShell` 执行转换，等完成后重新检查：

```powershell
wsl --set-version Ubuntu 2
wsl --list --verbose
```

### 0.3 进入 `WSL`，作为窗口一

**在 `Windows PowerShell` 执行：**

```powershell
wsl -d Ubuntu
```

这条命令会启动指定发行版，并把当前窗口切换到它的 `Linux` 命令行。提示符通常会变成类似下面的样子，用户名、电脑名和当前目录可能不同：

```text
edy@DESKTOP:~$
```

**接着在这个已经进入 `WSL` 的窗口执行：**

```bash
uname -s
cd /mnt/d/github/agent-autoloop
pwd
ls
```

按以下结果核对：

1. `uname -s` 输出 `Linux`，说明已经进入 `WSL`。
2. `pwd` 输出 `/mnt/d/github/agent-autoloop`，说明已进入项目目录。
3. `ls` 能看到 `bin`、`frontend`、`docs` 和 `package.json` 等项目内容。

`Windows` 的 `D:\github\agent-autoloop` 在这里写成 `/mnt/d/github/agent-autoloop`：盘符 `D:` 变为 `/mnt/d`，反斜杠变为正斜杠。这里操作的仍是同一份项目文件，无需再次下载仓库。

从现在开始，这个窗口就是“窗口一”。后文标注 `bash` 的命令都在进入 `WSL` 后执行，直接粘贴代码块中的命令即可；不要在 `PS C:\...>` 提示符下执行 `export` 等命令。

### 0.4 后面需要新窗口时怎么打开

需要“窗口二”或“窗口三”时，再按一次 `Win+R`，输入 `powershell` 并回车，在新窗口执行：

```powershell
wsl -d Ubuntu
```

等进入 `Linux` 提示符后，再执行对应步骤中的 `bash` 命令。三个窗口都要进入同一个发行版、使用同一个 `Linux` 用户；窗口一、窗口二启动服务后要保持打开，在其他窗口继续操作。

## 第一步：检查环境并安装前端依赖

以下命令都在已经进入 `WSL` 的窗口一执行。

### 1.1 检查 `Node.js` 和 `npm`

```bash
node --version
npm --version
command -v node
command -v npm
```

需要 `Node.js 24+`。`node` 和 `npm` 的路径应指向当前 `Linux` 环境，例如 `/home/你的用户名/.nvm/...` 或 `/usr/bin/...`。如果指向 `/mnt/c/...` 中的 `Windows` 安装，或提示 `command not found`，请先在 `WSL` 中安装。

已经有可用的 `Linux` 版 `Node.js 24+` 和 `npm`，跳到 `1.2`。否则，以下安装方法适用于本文的 `Ubuntu`：

```bash
sudo apt-get update
sudo apt-get install -y curl ca-certificates git
curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.41.0/install.sh | bash
source ~/.bashrc
nvm install 24
nvm alias default 24
nvm use 24
node --version
npm --version
```

`sudo` 要求输入的是创建 `Ubuntu` 用户时设置的密码，输入时不显示字符。`nvm` 用来在当前 `Linux` 用户下安装和管理 `Node.js`；上面使用固定版本的官方安装脚本。每条命令成功后再执行下一条，遇到下载失败先解决网络问题。

### 1.2 检查并登录命令行 `Agent`

本文默认使用 `Codex CLI`，在 `WSL` 中检查：

```bash
codex --version
command -v codex
```

如果还没有在当前 `WSL` 环境安装，在完成 `1.1` 后执行：

```bash
npm install -g @openai/codex
codex --version
```

然后检查登录状态：

```bash
codex login status
```

已经登录就继续。尚未登录时执行下面的命令，由你在浏览器中完成登录：

```bash
codex login
```

如果没有自动打开浏览器，可以改用设备码登录，按终端提示在 `Windows` 浏览器打开它给出的地址并输入设备码：

```bash
codex login --device-auth
```

完成后重新执行 `codex login status` 确认。不要直接把 `Windows` 的安装或登录状态当作 `WSL` 中已经可用。

若改用已经安装并登录的 `Claude Code`，检查 `claude --version`，并在第二步将 `--agent codex` 换成 `--agent claude`；不必同时安装两种 `Agent`。

### 1.3 安装前端依赖

```bash
cd /mnt/d/github/agent-autoloop
npm --prefix frontend ci
```

这条命令按 `frontend/package-lock.json` 安装前端依赖，首次运行、锁文件更新或切换运行环境后执行；平时启动不用重复安装。只运行本文的前后端，不需要安装根项目的开发依赖。

仓库文件与 `Windows` 共享：如果之前在 `Windows` 中装过前端依赖，现在切换到 `WSL`，要在这里重新执行 `npm --prefix frontend ci`，避免使用另一平台的构建工具依赖。

## 第二步：只在第一次初始化

在已经进入 `WSL` 并完成环境准备的窗口一执行：

```bash
cd /mnt/d/github/agent-autoloop
export AGENT_AUTOLOOP_HOME="$HOME/.agent-autoloop-local"
node --disable-warning=ExperimentalWarning bin/agent-autoloop.ts init --agent codex --port 3350 --no-service
```

使用 `Claude Code` 时，把 `--agent codex` 换成 `--agent claude`。

这里使用单独的数据目录 `~/.agent-autoloop-local`，不覆盖默认的 `~/.agent-autoloop` 安装。若提示“已经装过了”，不要删除原数据，跳过初始化，直接执行下一步。

## 第三步：启动后端，保留窗口一

继续在窗口一执行：

```bash
export AGENT_AUTOLOOP_HOME="$HOME/.agent-autoloop-local"
node --disable-warning=ExperimentalWarning bin/agent-autoloop.ts up
```

看到 `listening on 127.0.0.1:3350`，表示后端已监听。这个进程同时负责中台、接单程序和已配置通道，保持窗口运行。

## 第四步：查看本人密钥并启动前端，保留窗口二

按 `0.4` 的方法新开一个 `PowerShell` 窗口，先执行下面的命令进入同一个发行版，作为窗口二：

```powershell
wsl -d Ubuntu
```

等进入 `Linux` 提示符后，在窗口二执行：

```bash
cd /mnt/d/github/agent-autoloop
export AGENT_AUTOLOOP_HOME="$HOME/.agent-autoloop-local"
node --input-type=module -e 'import { readFileSync } from "node:fs"; const c = JSON.parse(readFileSync(process.env.AGENT_AUTOLOOP_HOME + "/config.json", "utf8")); console.log("后端地址：", c.url); console.log("本人密钥：", c.owner);'
export AGENT_AUTOLOOP_URL="http://127.0.0.1:3350"
npm --prefix frontend run dev
```

保持窗口二运行，在 `Windows` 的浏览器地址栏中输入前端打印的 `Local` 地址，通常为 `http://127.0.0.1:5173`。这个地址在浏览器里打开，不是粘贴进终端执行。

在页面的“本人密钥”输入框粘贴窗口二输出的本人密钥，点击“连接中台”。页面通过实时事实订阅更新流程状态。如果你的中台使用其他端口，`AGENT_AUTOLOOP_URL` 必须改成实际后端地址。

## 第五步：触发一次真实试跑

再开一个 `PowerShell` 窗口，先进入同一个发行版，作为窗口三：

```powershell
wsl -d Ubuntu
```

等进入 `Linux` 提示符后，在窗口三执行：

```bash
cd /mnt/d/github/agent-autoloop
export AGENT_AUTOLOOP_HOME="$HOME/.agent-autoloop-local"
node --disable-warning=ExperimentalWarning bin/agent-autoloop.ts try
```

这一步会实际调用已配置的 `Agent`，消耗对应模型额度。页面会出现事件、执行轮次和问题卡片，可以在页面回答，也可以按终端提示回答；选一种方式即可。回答后观察新一轮执行，最终查看试跑结果。

需要核对状态时，在试跑结束的窗口三执行；试跑尚未结束时，按 `0.4` 的方法另开窗口并进入同一个发行版，再执行：

```bash
cd /mnt/d/github/agent-autoloop
export AGENT_AUTOLOOP_HOME="$HOME/.agent-autoloop-local"
node --disable-warning=ExperimentalWarning bin/agent-autoloop.ts status
node --disable-warning=ExperimentalWarning bin/agent-autoloop.ts doctor
```

`--no-service` 模式没有安装系统服务，诊断提示服务未安装是正常的。默认桌面通知按配置运行，`WSL2` 通知可能不会显示到 `Windows` 桌面，网页仍可处理卡片。

## 以后再次启动

不用重新 `init`，也不必每天重新安装依赖。每次启动仍需要两个窗口，分别运行后端和前端。

**窗口一：** 按 `Win+R` 打开 `powershell`，先进入 `WSL`：

```powershell
wsl -d Ubuntu
```

进入后执行：

```bash
cd /mnt/d/github/agent-autoloop
export AGENT_AUTOLOOP_HOME="$HOME/.agent-autoloop-local"
node --disable-warning=ExperimentalWarning bin/agent-autoloop.ts up
```

**窗口二：** 再按 `Win+R` 打开另一个 `powershell`，先进入 `WSL`：

```powershell
wsl -d Ubuntu
```

进入后执行：

```bash
cd /mnt/d/github/agent-autoloop
export AGENT_AUTOLOOP_HOME="$HOME/.agent-autoloop-local"
node --input-type=module -e 'import { readFileSync } from "node:fs"; const c = JSON.parse(readFileSync(process.env.AGENT_AUTOLOOP_HOME + "/config.json", "utf8")); console.log("后端地址：", c.url); console.log("本人密钥：", c.owner);'
export AGENT_AUTOLOOP_URL="http://127.0.0.1:3350"
npm --prefix frontend run dev
```

然后在 `Windows` 浏览器打开窗口二打印的前端地址，粘贴同一窗口刚输出的本人密钥，点击“连接中台”。

## 停止和退出

前端和后端窗口分别按 `Ctrl+C` 可以结束本次前台服务。真实运行的 `Agent` 可能继续执行，后端重启会重新接管；若要停止某一轮，先在网页请求停止并等待执行端确认。

等服务停止、终端重新出现命令提示符后，可以执行下面的命令退出当前 `WSL` 命令行，回到 `PowerShell`：

```bash
exit
```

`exit` 只退出当前命令行。日常停止本项目按上面的方式处理即可；`~/.agent-autoloop-local` 是保留运行记录的持久数据目录，下次启动会继续使用。

## 连不上时按顺序检查

| 现象 | 检查方式 |
| --- | --- |
| 执行 `export` 提示无法识别 | 当前还在 `PowerShell`；先执行 `wsl -d Ubuntu`，进入 `Linux` 提示符后再执行 |
| 进入 `WSL` 提示找不到指定发行版 | 在 `PowerShell` 执行 `wsl --list --verbose`，将命令中的 `Ubuntu` 换成实际名称 |
| `cd` 提示目录不存在 | 确认项目在 `D:\github\agent-autoloop`；在 `WSL` 中使用 `/mnt/d/github/agent-autoloop` |
| 新窗口提示 `node` 或 `nvm` 不存在 | 确认进入同一发行版、同一用户；在 `WSL` 执行 `source ~/.bashrc` 后重新检查 |
| 页面打不开 | 窗口二是否仍运行；在浏览器打开它实际打印的前端地址 |
| 页面能打开，中台连接失败 | 窗口一是否仍运行；`AGENT_AUTOLOOP_URL` 是否与配置中的后端地址一致 |
| 修改后端地址后没生效 | 在窗口二按 `Ctrl+C`，重新设置 `AGENT_AUTOLOOP_URL` 并启动前端；只刷新网页不会改变代理目标 |
| 本人密钥无效 | 从 `~/.agent-autoloop-local/config.json` 重新读取 `owner`，不要填来源密钥或演示模式的密钥 |
| 页面没有业务数据 | 尚未收到匹配事件时为空是正常的；按第五步运行 `try` |
| 刷新页面后需要重新连接 | 密钥只保存在页面内存中，刷新后重新粘贴本人密钥即可 |
| 找不到命令行 Agent 或未登录 | 在运行后端的同一个 `WSL2` 环境检查命令和登录状态；不要混用 `Windows` 与 `WSL2` 的安装 |
| 查询到其他实例或提示未初始化 | 每个操作后端的终端都要设置相同的 `AGENT_AUTOLOOP_HOME` |
| 切换运行环境后前端依赖报错 | 在当前 `WSL2` 环境重新执行 `npm --prefix frontend ci` |
| 诊断提示系统服务未安装 | 本文使用 `--no-service`，需要手动保持后端窗口运行 |

## 相关说明

- [前后端启动总览与 Windows 演示模式](frontend-backend-startup.md)
- [前端配置、构建与静态部署](../frontend/README.md)
- [后端安装说明](../INSTALL.md)
- [协议及权限](protocol.md)
- [架构图](architecture.svg)

## 官方参考资料

- [Microsoft：安装 WSL](https://learn.microsoft.com/en-us/windows/wsl/install)
- [Microsoft：WSL 基本命令](https://learn.microsoft.com/en-us/windows/wsl/basic-commands)
- [Microsoft：设置 Linux 用户名和密码](https://learn.microsoft.com/en-us/windows/wsl/setup/environment#set-up-your-linux-username-and-password)
- [nvm：官方安装与使用说明](https://github.com/nvm-sh/nvm#installing-and-updating)
- [OpenAI：Codex CLI](https://developers.openai.com/codex/cli)
- [OpenAI：Codex CLI 登录命令](https://developers.openai.com/codex/cli/reference#codex-login)
