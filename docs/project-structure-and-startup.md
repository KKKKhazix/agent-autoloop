# Agent Autoloop 项目结构与启动指南

本文基于当前仓库 `D:\github\agent-autoloop` 的源码、`README.md`、`INSTALL.md`、`docs/protocol.md` 和 `docs/architecture.svg` 整理，说明项目结构、启动依赖和可执行的启动步骤。

## 一、项目定位

`Agent Autoloop` 是一个轻量的 Agent 自动化中台。它接收外部事件，依据本机规则把任务交给命令行 Agent，保存每一轮的事实日志；Agent 需要人工判断时，中台通过桌面通知、飞书或其他通道发出卡片，用户回答后再继续原事项。

架构图体现了四类插件和一个内核：

- 事件插件：把定时任务、GitHub、GitLab、业务系统或轮询结果变成标准事件。
- 内核：只负责收事件、按规则分派、接收回执、记录事实和维护事项状态。
- Agent 插件：调用 Claude Code、Codex、ACP、DeepSeek Harness 或任意命令行程序。
- 通道插件：把卡片发送到桌面通知、飞书、钉钉、企微、Slack 或 Discord。
- 交付插件：把代码审查、检查、合并、发布和健康核实接成一条流水线。

项目没有 Web 管理界面，也没有单独的数据库服务器。状态保存在本机 SQLite 数据库中，外部系统通过 `HTTP + JSON` 协议接入。

## 二、项目结构

```text
agent-autoloop/
├── bin/
│   └── agent-autoloop.ts       CLI 启动薄封装，转到 `cli/main.ts`
├── cli/                        用户命令实现
│   ├── main.ts                 init、up、try、status、answer、check 等命令
│   ├── mcp.ts                  通过标准输入输出提供 MCP 工具
│   ├── backup.ts               数据、配置和密钥备份恢复
│   ├── update.ts               更新到最新 Release
│   ├── uninstall.ts            停服务并卸载程序
│   ├── explain.ts、why.ts      规则预演和事实时间线查询
│   └── spend.ts、try.ts        用量统计和试跑辅助
├── kernel/                     纯内核，确定性处理业务事实
│   ├── decide.ts               根据视图和输入生成事实
│   ├── evolve.ts               把事实演进为投影
│   ├── store.ts                追加日志、事务提交和视图读取
│   ├── rules.ts                规则匹配和事项归并
│   ├── due.ts、cron.ts         到期表、重试和 Cron 调度
│   ├── http.ts                 协议入口和请求分发
│   ├── query.ts                状态查询
│   ├── card-page.ts            卡片回答页面
│   └── credentials.ts          密钥归属和权限边界
├── host/                       Node.js 外壳和运行时
│   ├── runtime.ts              SQLite、日志、规则重载和内核装配
│   ├── server.ts               HTTP Handler、Webhook 适配和长轮询
│   ├── http.ts                 Node HTTP Server
│   ├── up.ts                   单进程启动 Hub、Worker 和通道
│   ├── service.ts              Linux `systemd` 和 macOS `launchd` 服务
│   ├── config.ts、home.ts      配置和数据目录
│   ├── plugins.ts              插件发现和加载
│   └── state.ts、channels.ts   状态汇总和通道管理
├── protocol/                   HTTP/JSON 协议和类型
│   ├── schema.ts、schema.json  数据结构和 JSON Schema
│   ├── validate.ts              输入校验
│   ├── client.ts                Hub HTTP 客户端
│   ├── job.ts、rules.ts         Job 和规则协议类型
│   └── conformance.ts           协议一致性检查
├── worker/                     接单程序和 Agent 进程管理
│   ├── worker.ts                领活、心跳、停止、重启恢复和回执提交
│   ├── agents.ts                Agent 适配器加载
│   ├── contract.ts              提示词、回执和重写协议
│   └── usage.ts                 Token/费用增量统计
├── plugins/                    内置插件
│   ├── claude/、codex/          Claude Code 和 Codex Agent
│   ├── acp/                     ACP Agent 桥接
│   ├── command/                 任意命令行 Agent
│   ├── dsh/                     DeepSeek Harness
│   ├── github/、gitlab/         Webhook 事件来源
│   ├── desktop/                 桌面通知通道
│   ├── feishu/                  飞书通道
│   ├── webhook/                 钉钉、企微、Slack、Discord 模板
│   └── delivery/                PR 审查、合并、发布和健康核实
├── examples/                   最小插件和业务场景模板
│   ├── plugins/                 Agent、通道、来源的最小示例
│   ├── recipes/                 feedback、github-issues、website-watch 等场景
│   ├── skills/                  可复用任务 Skill
│   ├── worker.sh、channel.sh    curl/jq 协议示例
│   └── watch-github-issues.sh   GitHub Issue 轮询示例
├── skills/agent-autoloop/       正式配置和操作手册
├── sim/                         随机模拟、穷举、强杀和变异检查
├── tests/                       行为测试、协议测试和插件测试
├── scripts/                     性能、真实 Agent、真实协议和安装冒烟脚本
├── docs/                        协议、插件和架构文档
├── package.json                 Node 版本、开发依赖和测试命令
├── package-lock.json            锁定开发依赖版本
├── tsconfig.json                TypeScript 类型检查配置
├── install.sh                   安装到用户目录的安装器
├── INSTALL.md                   安装和验证说明
├── README.md                    项目总览和快速上手
└── SECURITY.md                  安全边界和凭据说明
```

关键运行关系如下：

```text
事件来源 / 定时器 / Webhook
            │
            ▼
     host/server.ts
            │
            ▼
 kernel/http.ts → kernel/decide.ts → kernel/evolve.ts → SQLite hub.db
            │
            ▼
       worker/worker.ts
            │
            ▼
       Agent CLI 进程
            │
            ▼
      回执、卡片、后续事件
```

`kernel/` 不主动访问网络，也不读取系统时钟、随机数或文件；这些能力由 `host/` 传入。插件通过协议接入，内核不认识具体产品名称。这是项目的主要边界。

## 三、依赖项清单

### 3.1 运行时必需依赖

1. **Node.js `24` 或更高版本**
   - `package.json` 的 `engines.node` 要求 `>=24`。
   - 项目直接使用 Node 内置的 `node:sqlite`、TypeScript 类型擦除和原生 ESM，不需要运行时数据库驱动或第三方 ORM。
   - 验证：

     ```bash
     node --version
     ```

2. **Git**
   - `install.sh` 使用 Git 克隆、更新和切换 Release。
   - GitHub Issue/PR 场景也需要 Git 访问目标仓库。
   - 验证：`git --version`。

3. **Bash 或兼容的 POSIX Shell**
   - `install.sh`、示例脚本和部分测试使用 Shell 语法。
   - macOS/Linux 原生支持；Windows 需要 WSL2、Git Bash 或其他 Linux 兼容层。仓库当前安装说明将 Windows 直接运行标为待支持，推荐 WSL2。

4. **`curl`**
   - 远程安装命令从 GitHub 下载 `install.sh`。
   - 使用本地仓库直接运行 Node CLI 时不是硬性依赖，但官方安装方式需要它。
   - 验证：`curl --version`。

5. **至少一个已登录的命令行 Agent**
   - `init` 默认检测 `Claude Code` 和 `Codex`。
   - 也可以通过 `--command` 指定任意能接收提示词并打印最终回复的程序，例如 Hermes、Cursor Agent、CodeBuddy 或自定义脚本。
   - 验证示例：

     ```bash
     codex --version
     claude --version
     ```

   - Agent 的登录状态和凭据由 Agent 自己管理，`Agent Autoloop` 不替用户登录，也不复制凭据。

6. **本地可写数据目录**
   - 默认是 `~/.agent-autoloop`。
   - 目录权限会被设置为仅当前用户可读写。
   - 主要文件包括：`config.json`、`rules.json`、`secrets.env`、`hub.db`、`master.key`、`logs/` 和运行产物。

7. **可用本地端口**
   - Hub 默认监听 `127.0.0.1:3350`。
   - 可以在初始化时通过 `--port` 修改。
   - 对外使用飞书等通道时，需要把 `hub.publicUrl` 配成通道和手机可访问的地址，并自行提供 HTTPS 反向代理。

### 3.2 开发和质量检查依赖

这些依赖不是普通运行必需的，但执行测试、类型检查和格式检查需要它们。项目没有运行时 `dependencies`，只有以下 `devDependencies`：

- `@types/node@26.6.4`：Node.js 类型定义。
- `prettier@3.9.10`：格式化和格式检查。
- `typescript@7.0.2`：`npm run typecheck` 类型检查。

安装方式：

```bash
npm ci
```

常用检查命令：

```bash
npm run typecheck
npm run format:check
npm run test:quick
```

如果修改了 `kernel/`、`protocol/` 或 `sim/`，按仓库约定运行完整测试：

```bash
npm test
```

`npm test` 会运行固定种子的 20 万步模拟和有界穷举，耗时明显高于 `test:quick`。

### 3.3 可选依赖

- **系统服务管理器**：macOS 使用 `launchd`，Linux 使用用户级 `systemd`。没有服务管理器时使用 `--no-service`，手动运行 `agent-autoloop up`。
- **桌面通知命令**：macOS 使用 `osascript`，Linux 使用 `notify-send`。没有图形会话时卡片仍会保存在中台，可用 `status` 查看。
- **GitHub CLI `gh`**：GitHub Issue 轮询和 PR 交付场景需要已登录的 `gh`；基础 Hub 和本地试跑不需要。
- **`jq`**：`examples/worker.sh` 和 `examples/channel.sh` 使用它；核心运行不依赖。
- **飞书、钉钉、企微、Slack、Discord 凭据**：只有启用对应通道时需要。
- **MCP 客户端**：只有使用 `agent-autoloop mcp` 时需要客户端本身；项目提供的是标准输入输出 MCP 服务。

## 四、推荐启动方式

### 4.1 macOS/Linux：使用仓库内源码直接启动

这种方式适合阅读、调试和修改当前工作树。它不会把当前源码复制到 `~/.agent-autoloop/app`，数据目录仍可单独指定。

#### 第一步：准备环境

```bash
node --version       # 需要 24 或更高
npm --version
git --version
curl --version
codex --version      # 或 claude --version
```

确保所选 Agent 已经完成登录。

#### 第二步：安装开发依赖

```bash
cd /path/to/agent-autoloop
npm ci
```

如果只是启动，不跑类型检查和测试，`npm ci` 可以省略；Node.js 本身已经包含项目运行所需的内置模块。

#### 第三步：初始化本地配置

为了避免覆盖已有的 `~/.agent-autoloop`，下面使用仓库内的独立数据目录。该目录不要提交到 Git：

```bash
cd /path/to/agent-autoloop
export AGENT_AUTOLOOP_HOME="$PWD/.agent-autoloop-dev"
node bin/agent-autoloop.ts init --agent codex --port 3350 --no-service
```

如果使用 Claude Code，将 `--agent codex` 改成 `--agent claude`。如果使用其他 CLI，可以指定命令：

```bash
node bin/agent-autoloop.ts init \
  --command 'hermes chat -Q -q {prompt}' \
  --port 3350 \
  --no-service
```

初始化会创建：

- Hub 地址：`http://127.0.0.1:3350`。
- Worker 密钥、来源密钥和本人密钥。
- 默认 `rules.json`，包括试跑规则。
- 默认桌面通知通道。
- SQLite 数据库 `hub.db` 和主密钥 `master.key`。

如果看到“已经装过了”，说明指定的 `AGENT_AUTOLOOP_HOME` 已经存在配置；可以继续使用它，或删除该临时目录后重新初始化。

#### 第四步：启动中台和 Worker

在同一个终端中运行：

```bash
export AGENT_AUTOLOOP_HOME="$PWD/.agent-autoloop-dev"
node bin/agent-autoloop.ts up
```

`up` 是前台进程，会同时启动 Hub、Worker 和配置中的通道。保持这个终端运行。

如果没有使用 `export`，每一条命令都必须显式传环境变量：

```bash
AGENT_AUTOLOOP_HOME="$PWD/.agent-autoloop-dev" node bin/agent-autoloop.ts up
```

#### 第五步：在另一个终端做试跑

```bash
cd /path/to/agent-autoloop
export AGENT_AUTOLOOP_HOME="$PWD/.agent-autoloop-dev"
node bin/agent-autoloop.ts try
```

试跑会让 Agent 提问一次。按终端提示回答后查看状态：

```bash
node bin/agent-autoloop.ts status
```

还可以检查规则和诊断信息：

```bash
node bin/agent-autoloop.ts check
node bin/agent-autoloop.ts doctor
node bin/agent-autoloop.ts rules explain
```

停止前台进程使用 `Ctrl+C`。再次启动时，直接重新运行 `node bin/agent-autoloop.ts up`，数据库和规则会复用。

### 4.2 macOS/Linux：使用官方安装器和系统服务

官方安装器会把程序安装到 `~/.agent-autoloop/app`，把配置和 SQLite 数据保存在 `~/.agent-autoloop`，并根据系统安装 `launchd` 或 `systemd` 服务。

```bash
curl -fsSL https://raw.githubusercontent.com/KKKKhazix/agent-autoloop/main/install.sh | sh
```

安装器会：

1. 检查 `git`、`node` 和 Node 主版本。
2. 拉取最新 Release；如果设置了 `AGENT_AUTOLOOP_REPO`，则从指定仓库安装。
3. 在 `PATH` 中寻找可写目录，创建 `agent-autoloop` 命令链接。
4. 运行 `init`，自动检测本机的 Claude Code 或 Codex。
5. 安装并启动系统服务。

安装完成后执行：

```bash
agent-autoloop doctor
agent-autoloop try
agent-autoloop status
```

如果不希望安装系统服务：

```bash
curl -fsSL https://raw.githubusercontent.com/KKKKhazix/agent-autoloop/main/install.sh | sh -s -- --agent codex --no-service
```

对于当前本地仓库，建议直接使用本地安装脚本，并让安装器从当前仓库的 `HEAD` 安装：

```bash
AGENT_AUTOLOOP_REPO=/path/to/agent-autoloop \
  sh /path/to/agent-autoloop/install.sh --agent codex --no-service
```

然后手动启动：

```bash
agent-autoloop up
```

### 4.3 WSL2：Windows 环境启动

仓库的 `INSTALL.md` 当前说明 Windows 直接运行尚未作为原生目标支持，WSL2 按 Linux 方式可以运行。推荐使用 WSL2 Ubuntu，不要在 PowerShell 中直接执行 `install.sh`。

1. 安装 WSL2 Ubuntu。
2. 如果要使用自动系统服务，在 `/etc/wsl.conf` 中启用：

   ```ini
   [boot]
   systemd=true
   ```

   修改后执行 `wsl --shutdown`，再重新打开 Ubuntu。
3. 在 WSL2 中安装 Node.js `24+`、Git 和 `curl`。
4. 把仓库放在 WSL 文件系统，或从 `/mnt/d/github/agent-autoloop` 访问。
5. 确认 Agent CLI 也能在 WSL 中执行并已登录。
6. 按 4.1 或 4.2 的 Linux 步骤启动。

如果不启用 `systemd`，使用手动模式：

```bash
cd /mnt/d/github/agent-autoloop
export AGENT_AUTOLOOP_HOME="$PWD/.agent-autoloop-dev"
node bin/agent-autoloop.ts init --agent codex --port 3350 --no-service
node bin/agent-autoloop.ts up
```

WSL2 中的桌面通知通常不会显示到 Windows 桌面，应使用 `agent-autoloop status`，或配置飞书、钉钉、企微等远程通道。WSL2 还会额外占用约 1 GB 内存。

## 五、配置文件和运行顺序

初始化后，默认数据目录是 `~/.agent-autoloop`；使用 `AGENT_AUTOLOOP_HOME` 时会切换到指定目录。

| 文件 | 作用 |
| --- | --- |
| `config.json` | Hub 地址、Worker、来源、本人和通道密钥 |
| `rules.json` | 事件匹配、Agent、工作目录、Skill、并发和通知规则 |
| `secrets.env` | Webhook 验签等插件私密配置，不进入规则文件 |
| `hub.db` | SQLite 事实日志、投影、卡片、事项和运行状态 |
| `master.key` | 本机密钥加密和卡片链接保护 |
| `logs/` | 系统服务输出日志 |
| `runs/` | Worker 运行上下文和输出保留目录 |

推荐的首次配置顺序：

1. 初始化 Hub 和 Worker。
2. 运行 `agent-autoloop doctor`。
3. 运行 `agent-autoloop try`，完成一次提问和回答。
4. 使用 `agent-autoloop status` 确认试跑通过。
5. 根据 `examples/recipes/` 选择业务模板。
6. 将模板规则合入 `rules.json`，修改 Agent 名称、工作目录和凭据。
7. 运行 `agent-autoloop check` 和 `agent-autoloop rules explain`。
8. 最后再接入 GitHub、飞书或其他外部系统。

规则中的 `cwd`、Agent、权限和 Skill 来自可信的本地配置；外部事件中的文字只作为资料，不应被当成指令。

## 六、常见启动问题

### 找不到 Node.js 或版本过低

确认：

```bash
node --version
```

必须是 `24` 或更高。macOS 使用 Homebrew 的 `node@24` 时，可能需要把它加入 `PATH`：

```bash
export PATH="$(brew --prefix node@24)/bin:$PATH"
```

### 初始化时找不到 Agent

`init` 会检测 `claude` 或 `codex` 命令。确认程序在 `PATH` 中并且已经登录；或者使用 `--command` 指定其他程序：

```bash
node bin/agent-autoloop.ts init \
  --command 'your-agent --prompt {prompt}' \
  --no-service
```

### 已经装过，无法再次初始化

这是为了避免覆盖已有配置。指定新的数据目录：

```bash
export AGENT_AUTOLOOP_HOME="$PWD/.agent-autoloop-dev"
node bin/agent-autoloop.ts init --agent codex --no-service
```

### CLI 能运行但连不上中台

确认另一个终端中的 `agent-autoloop up` 仍在运行，并且 Hub 端口一致：

```bash
agent-autoloop doctor
agent-autoloop status
```

### 系统服务安装失败

没有 `systemd` 或 `launchd` 时不要强行安装服务，初始化时加 `--no-service`，然后手动运行：

```bash
agent-autoloop up
```

### 桌面通知没有弹出

桌面通知是可选通道。Linux 检查 `notify-send`，macOS 检查图形会话；也可以直接运行：

```bash
agent-autoloop status
```

### 运行时是否需要 `npm install`

普通运行不需要。项目运行时依赖为 `0`，Node.js `24+` 自带所需模块。只有执行 `npm run typecheck`、`npm run format:check` 或测试时才需要先运行：

```bash
npm ci
```

## 七、验证命令

按照仓库约定，代码改动后至少执行：

```bash
npm run typecheck
npm run format:check
npm run test:quick
```

修改 `kernel/`、`protocol/` 或 `sim/` 时执行：

```bash
npm test
```

涉及日志、到期表或并发时，再执行：

```bash
npm run test:nightly
```

真实 Agent 和真实协议脚本需要额外凭据；真实交付脚本会创建测试仓库，只有明确需要时才运行。

## 八、相关文档

- `README.md`：项目定位、快速上手和场景模板。
- `INSTALL.md`：安装、服务、临时 `HOME` 和试跑验证。
- `docs/protocol.md`：HTTP/JSON 协议、事件、Job、回执、卡片和恢复语义。
- `docs/plugins.md`：Agent、来源和通道插件开发说明。
- `docs/architecture.svg`：系统架构图。
- `skills/agent-autoloop/SKILL.md`：规则、密钥、通道和交付配置手册。
- `SECURITY.md`：密钥、执行权限和交付边界。

