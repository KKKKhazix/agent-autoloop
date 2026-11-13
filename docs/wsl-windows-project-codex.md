# 在 WSL 中打开 Windows 项目并使用 Codex

本文按当前电脑已经配置好的环境编写，以 `D:\programs\ai\ai-ops` 为例。第一次安装 `WSL`、`Node.js` 和 `Codex` 的步骤已经完成；平时使用按下面操作即可。

## 一、从 Windows 进入 WSL

按 `Win+R`，输入 `powershell`，按回车。

在打开的 `PowerShell` 中执行：

```powershell
wsl -d Ubuntu -u edy
```

看到类似下面的提示符，表示已进入 `WSL`：

```text
edy@CHINAMI-6OQ3Q63:~$
```

后面的 `bash` 命令都在这个窗口执行。不要复制提示符，只复制代码块里的命令；每条执行完成后再继续。

## 二、进入 Windows 中的项目目录

```bash
cd /mnt/d/programs/ai/ai-ops
pwd
ls
```

`pwd` 应输出 `/mnt/d/programs/ai/ai-ops`，`ls` 应能看到 `package.json`、`README.md` 和 `src`。

这是同一份项目文件。`Codex` 获准修改后，改动也会立即体现在 `Windows` 的原目录中，无需另行同步。

| Windows 路径 | WSL 中使用的路径 |
| --- | --- |
| `D:\programs\ai\ai-ops` | `/mnt/d/programs/ai/ai-ops` |
| `D:\github\another-project` | `/mnt/d/github/another-project` |
| `C:\Users\EDY\Desktop\demo` | `/mnt/c/Users/EDY/Desktop/demo` |

规则是盘符变成 `/mnt/小写盘符`，路径分隔符改成 `/`。路径有空格时加引号，例如 `cd "/mnt/d/My Projects/demo"`。

## 三、加载 Linux 版 Node.js 和现有中转站配置

在同一个 `WSL` 窗口执行：

```bash
export NVM_DIR="$HOME/.nvm"
source "$NVM_DIR/nvm.sh"
nvm use 24
export CODEX_HOME=/mnt/c/Users/EDY/.codex
```

这几条命令的作用：

- 加载已经安装的 `nvm`，切换到 `Linux` 版 `Node.js 24`。
- 将 `Codex` 的配置目录指向现有的 `Windows` 配置，沿用其中的中转站地址、模型和已配置的授权。
- 不需要在命令或提示词中再填写中转站密钥，也不需要重新执行官方账号登录。

这个 `CODEX_HOME` 路径适用于当前电脑。它意味着两边共用 `Codex` 配置和运行记录；不要删除或移动它。新开终端后，这些环境变量需要重新加载。

检查命令路径：

```bash
command -v node
command -v codex
codex --version
```

当前电脑应显示类似：

```text
/home/edy/.nvm/versions/node/v24.22.3/bin/node
/home/edy/.nvm/versions/node/v24.22.3/bin/codex
codex-cli 0.168.0
```

如果 `codex` 指向 `/mnt/d/nodejs/global/...`，表示仍在调用 `Windows` 安装，先按[部署指南](wsl2-deployment.md)修正，不能仅凭 `node --version` 正常就继续。

## 四、在项目中启动 Codex 并交代任务

### 只检查，不改代码

当前需求适合用下面这条：

```bash
codex --sandbox read-only --ask-for-approval never '先阅读项目说明，检查项目结构、依赖和启动方式，列出发现的问题。本次只分析，不修改文件，不安装依赖，不启动或停止现有服务。'
```

`read-only` 使用只读执行环境；`never` 表示该次会话不申请额外权限。需要写文件或运行受限操作时，应汇报限制，由你决定是否另开一个适合的会话。

进入界面后，可以继续输入要求，例如：

```text
重点检查知识库页面的请求流程，说明相关文件之间的调用关系，不修改代码。
```

### 已经明确允许修改代码

退出当前会话后，按具体任务启动一个允许修改项目文件的会话，例如：

```bash
codex --sandbox workspace-write --ask-for-approval on-request '按项目规范修复知识库页面的加载问题，保留现有交互，并运行相关检查。'
```

这里的任务是示例，替换成你的真实需求。`workspace-write` 允许修改工作区，运行时遇到需要额外权限的操作由会话提出申请。

你也可以不带初始任务启动：

```bash
codex --sandbox read-only --ask-for-approval never
```

界面打开后，再输入中文任务并按回车。若出现项目是否可信的询问，确认界面显示的确实是你要操作的目录，再按实际情况选择。

## 五、不进入交互界面，只执行一条检查任务

完成前面的环境加载后，可以执行：

```bash
codex exec --sandbox read-only -C /mnt/d/programs/ai/ai-ops '检查这个项目的启动方式和依赖，输出检查结论，不修改代码、不安装依赖。'
```

`-C` 指定项目目录，`exec` 执行一次任务，结束后回到命令行。该命令会实际调用中转站模型并消耗对应额度。

## 六、继续旧会话和退出

在同一项目目录、加载同一份 `CODEX_HOME` 后，选择旧会话：

```bash
codex resume
```

也可以继续最近一次符合筛选条件的交互会话：

```bash
codex resume --last
```

中转站兼容性要单独留意：本机此前恢复会话曾返回 `list_turns is not supported yet`。如果再次出现，说明恢复会话仍未接通；不能据此认定项目本身有问题。新开会话时，说明已完成部分和剩余任务，避免重复执行已经完成的操作。

退出 `Codex` 时按界面提示操作，通常可按 `Ctrl+C`；如果仍在处理任务，先确认已停止并回到 `WSL` 命令提示符。需要退出当前 `WSL` 命令行时，再执行：

```bash
exit
```

## 七、你这台电脑每次最常用的一套命令

先在 `PowerShell` 执行：

```powershell
wsl -d Ubuntu -u edy
```

进入 `WSL` 后执行：

```bash
export NVM_DIR="$HOME/.nvm"
source "$NVM_DIR/nvm.sh"
nvm use 24
export CODEX_HOME=/mnt/c/Users/EDY/.codex
cd /mnt/d/programs/ai/ai-ops
codex --sandbox read-only --ask-for-approval never '先检查项目结构和启动方式，汇报问题，不修改代码。'
```

换项目时，只需替换 `cd` 后面的目录，并写清这次要做的事。

## 八、与你已经配置的流程操作台怎么配合

直接在项目目录中运行的 `codex` 是手动会话，不会自动变成流程操作台中的任务。需要操作台记录派发与结果时，使用已经配置好的规则和事件入口。

当前 `ai-ops` 的只读 `e2e` 检查已接入中台。先确认 `ai-ops` 的 `Windows` 开发服务和中台都在运行，然后在 `PowerShell` 执行：

```powershell
wsl -d Ubuntu -u edy -- bash /home/edy/.agent-autoloop-local/checks/ai-ops-e2e/trigger-check.sh
```

在流程操作台的执行记录里查看“AI-OPS 只读端到端检查”。测试运行器与浏览器在 `WSL` 中执行，页面复用 `Windows` 现有开发服务；已有检查覆盖未登录界面和模拟过期登录，真实账号业务还没有验收。

`Skill` 需要实际可用的运行器、浏览器和配置，不能仅靠写出名字就视为已测试。当前检查入口已经配好，具体范围、报告和截图见[AI-OPS 端到端检查说明](ai-ops-e2e.md)。

## 常见问题

| 现象 | 处理方式 |
| --- | --- |
| `nvm: command not found` | 先执行 `source "$HOME/.nvm/nvm.sh"`，确认加载成功后再执行 `nvm use 24` |
| 找不到项目目录 | 对照盘符路径转换，确认用的是 `/mnt/d/...`，不是 `D:\...` |
| 路径有空格，`cd` 报错 | 把完整路径放在双引号中 |
| 缺少 `codex-linux-x64` 依赖 | 检查 `command -v codex`，按部署指南使用 `Linux` 安装 |
| 中转站配置没有生效 | 在启动 `codex` 的同一个终端执行 `export CODEX_HOME=/mnt/c/Users/EDY/.codex` |
| 只读会话不能写测试报告或启动需要缓存的工具 | 保留只读限制，改用已经配置的独立检查入口；允许写入时另开相应会话 |
| Windows 能启动项目，WSL 构建时报平台依赖缺失 | 两边不能直接共用所有平台构建依赖。先决定依赖在哪个环境安装，再按该项目的锁文件安装；不要同时重装同一份 `node_modules` |

本次整理只核对了本机目录、命令路径、版本与帮助参数，没有额外调用模型或修改 `ai-ops` 代码。

## 相关说明

- [完整 WSL 部署步骤](wsl2-deployment.md)
- [AI-OPS 只读端到端检查](ai-ops-e2e.md)
- [OpenAI 官方 Codex CLI 参数说明](https://developers.openai.com/codex/cli/reference)
