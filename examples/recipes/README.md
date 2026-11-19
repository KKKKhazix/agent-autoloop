# 样板目录：什么时候用哪套

这 8 个目录不是"玩具"，是 8 种常见情况的现成做法；第 9 套（`../skills/weekly-sweep/`）是一个只带说明的 Skill。
**不用全装**，用的时候按"我遇到的是哪种情况"找。每套的规则都通过了 `agent-autoloop check`。

目录里的脚本一律用 `node` 写，Windows 上也能直接跑。需要的外部程序（`gh`、`lark-cli`、Codex）写在表里。

## 一、按场景找

| 我遇到的事 | 用这套 | 它替你做什么 | 你先要有 |
|---|---|---|---|
| 每天想知道"今天有什么要紧的" | `morning-brief` | 读本地笔记/提交，写一份早报或发一张卡 | 无 |
| 想有人盯着某个仓库的新 issue | `github-issues` | 每 5 分钟查一次，有新 issue 先改好再告诉你 | 已登录的 `gh` |
| 线上服务报错，要人查原因 | `ops-alerts` | 收报错 → 对照代码查 → 需要重启时问你 | 告警系统能发 HTTP；你的重启命令 |
| 有人给你提反馈/工单 | `feedback` | 重读反馈 → 修 → 核实 → 起草回复 | 你反馈系统的读取入口 |
| 网站挂了怕没人知道 | `website-watch` | 每 5 分钟探一次，异常才叫 Agent，恢复后结案 | 无（本地假服务也能测） |
| 每周要交周报 | `feishu-brief` | 按你的权限读汇报和表格，生成摘要，完整稿留本机 | `lark-cli` + 读权限 |
| 邮箱堆着没人看 | `inbox-triage` | 读最近 24 小时，分"必须回/知道就行/可疑"，顺手起草 | 邮件能导出成本地文件 |
| 网页上的事只有浏览器能做 | `browser-handoff` | 主任务把网页步骤交给浏览器助手，人只处理登录/验证码 | Claude Code + 一个 Codex 浏览器入口 |
| 代码越堆越乱 | `../skills/weekly-sweep` | 每周把上批合进来的烂代码删掉、重复合并 | 无（只有说明，挂到已有规则上） |

## 二、每套要装什么、改什么

| 样板 | 要复制的文件 | Skill 放到 | 要建的来源密钥 | 铁定要改 | 验证到哪一步 |
|---|---|---|---|---|---|
| `morning-brief` | 不复制（只有 Skill 和规则） | `~/.codex/skills/morning-brief/` | 不用 | `worker`、`cwd`（你的笔记目录）、`cron` | 规则 check 过；本机没真跑过 |
| `github-issues` | 不复制（脚本在仓库 `examples/`，规则直接用程序目录） | `~/.codex/skills/handle-issue/` | 不用（事件由轮询脚本在本机发） | 两处 `worker`、`owner/repo`、`YYYY-MM-DD`、处理规则的 `cwd` | 脚本在本机用真 `gh` 跑通；Agent 那半没跑过 |
| `ops-alerts` | 不复制目录；`restart.mjs` 放到服务代码目录 | `~/.codex/skills/ops-alerts/` | `key new source shop` | 两处 `worker`、两处 `cwd`、`restart.mjs` 的实际位置 | 规则 check 过；未真跑 |
| `feedback` | 不复制（只有 Skill 和规则） | `~/.codex/skills/handle-feedback/` | `key new source feedback` | `worker`、`cwd`、`ou_REPLACE_ME`、通道名 | 规则 check 过；未真跑 |
| `website-watch` | 整个目录 → `~/.agent-autoloop/work/website-watch` | `~/.codex/skills/website-watch/` | 不用 | 两处 `worker`、`site.json`、排查规则的 `cwd`、`ou_REPLACE_ME` | 探测和回执有单测；未真跑 |
| `feishu-brief` | 整个目录 → `~/.agent-autoloop/work/feishu-brief` | `~/.codex/skills/feishu-brief/` | 不用 | 两处 `worker`、`sources.json`、`ou_REPLACE_ME` | 读取脚本有单测；未真跑 |
| `inbox-triage` | 整个目录 → `~/.agent-autoloop/work/inbox-triage` | `~/.codex/skills/inbox-triage/` | 不用 | 两处 `worker`、`sources.json`、`ou_REPLACE_ME` | 读取脚本有单测；未真跑 |
| `browser-handoff` | 整个目录 → `~/.agent-autoloop/work/browser-handoff` | `~/.claude/skills/claude-browser-handoff/` | 不用 | `worker`、`browser.json`、`ou_REPLACE_ME`；不想用 Claude 就换成 `use: "codex"` | 交接脚本有单测；未真跑 |
| `../skills/weekly-sweep` | 只要 Skill | `~/.codex/skills/weekly-sweep/` | 不用 | 在你选的规则里加 `skill: weekly-sweep` | 只有说明，没有可跑的东西 |

## 三、占位符字典（看到就换）

| 占位符 | 换成什么 | 从哪查 |
|---|---|---|
| `"worker": "mac-mini"` / `"my-computer"` | 接单电脑的名字 | `agent-autoloop status` 顶部，或 `config.json` 的 `worker.name` |
| `~/notes`、`~/code/app`、`~/code/my-project`、`~/code/shop` | 你自己的目录，必须真实存在 | 自己确认；`spec-check` 会报不存在的 |
| `ou_REPLACE_ME` | 本人飞书 open_id | 你的飞书配置 |
| `"channels": { "feishu": … }` | 本机通道名。本机叫 `feishu-text` | `config.json` 的 `channels` 键 |
| `owner/repo`、`YYYY-MM-DD` | 仓库名、启用日期 | 你自己定 |
| `site.json` / `sources.json` / `browser.json` 里的示例值 | 你的站点、邮箱、浏览器入口 | 对应 README 有字段说明 |
| `{cwd}`、`{prompt}`、`{id}`、`{subject}` | **不要手改**，中台运行时替换 | — |

## 四、六步作业单（照做就行）

1. 备份：`Copy-Item rules.json rules.json.bak-<日期>`。
2. 复制：只有 `website-watch`、`feishu-brief`、`inbox-triage`、`browser-handoff` 要复制目录；其余只放 Skill，不复制目录。
3. Skill：放到上表位置；**目录名、`SKILL.md` 里的 `name:`、规则的 `skill` 必须是同一个词**。
4. 合并：把样板 `rules.json` 的 `sources` / `agents` / `channels` / `rules` 四段并进本机 `rules.json`，只加不改已有的。
5. 改占位符：按字典逐项替换；`channels` 的键名改成本机通道名；外部事件先 `agent-autoloop key new source <名字>`。
6. 自查：
   ```powershell
   agent-autoloop check
   node --disable-warning=ExperimentalWarning ~/.agent-autoloop/spec-check.mjs
   agent-autoloop rules explain
   ```
   三条都过，再真跑一轮（`agent-autoloop run <规则名>` 或等定时），`agent-autoloop why <轮次>` 看到"领取→结束"才算跑通。

## 五、出事了对着这张表查

| 症状 | 原因 |
|---|---|
| 卡片没发出来 | `channels` 里的名字和 `config.json` 不一致（最常见：样板写 `feishu`，本机是 `feishu-text`） |
| 一直排队没人接 | `worker` 还是 `mac-mini` / `my-computer` |
| 一轮立刻失败 | `cwd` 不存在；或者 `SKILL.md` 的 `name:` 和 `skill` 不同名 |
| 外部事件发不出去 | 没写 `emits`，或者没建来源密钥 |
| 脚本找不到 | `{cwd}` 指向的目录里没有那个脚本（`github-issues` 的脚本在仓库 `examples/`，所以它不能搬目录） |
| 脚本报 `ENOENT gh` | 这台电脑没装 GitHub CLI，或没登录：`gh auth login` |

## 六、这些事还没验证

规则都过 `check`；`website-watch`、`feishu-brief`、`inbox-triage`、`browser-handoff` 的脚本有单测；`github-issues` 的轮询脚本在本机用真 `gh` 跑通过。
**没有任何一套在真实账号上跑完整业务**（真飞书、真邮箱、真线上服务）。表里"验证到哪一步"就是实情，别当成"已经能用了"。