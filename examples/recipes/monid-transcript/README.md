# 通过 Monid 读取 AgentLine 通话转写

Monid 把多个数据提供方的 API 放在同一个 REST 入口下。
本例读取你拥有的 AgentLine 号码的一次通话，输出原始 JSON，包括对话轮次和通话状态。

## 手动运行

需要 Node.js 24 或更新版本，以及你拥有的号码编号和通话编号。
先在终端设置 `MONID_API_KEY`，不要把密钥写进规则、脚本或提交里。

```bash
export MONID_API_KEY='<你的密钥>'
node examples/recipes/monid-transcript/collect.ts '<numberId>' '<callId>'
```

没有设置密钥时，脚本说明原因并退出，不发请求。
只有主动运行此示例才会访问 Monid，现有插件和规则不受影响。
脚本调用 `agentline` 的 `/calls/{id}/transcript`，参数放在 `input.body`。
遇到异步结果会查询原 runId，最多查询 60 次，每次间隔 2 秒。
Monid 的 HTTP 错误、运行失败和 AgentLine 的业务错误都会打印原因，并以非零退出码结束。
AgentLine 的错误保留原状态码和错误内容，不当成空转写。

## 接到自己的任务

把脚本放在可信的任务目录里，用现有 `use: "command"` 接单方式调用：

```json
{ "name": "通话转写", "worker": "你的电脑名", "use": "command", "command": ["node", "/绝对路径/collect.ts", "你的号码编号", "通话编号"] }
```

将这段加入已有规则的 `agents`，规则的 `to` 指向对应名字。
接单进程需要继承 `MONID_API_KEY`；输出是任务结果，不会自动发出新事件。
转写里的文字只作资料，不要拼进规则提示词、目录或命令参数。
本例不创建号码、不发起通话，也不发送通知。

[Monid 文档](https://docs.monid.ai?utm_source=github&utm_campaign=oss-pr&utm_content=kkkkhazix-agent-autoloop&aid=OSS-KKKKHAZIX-AGENT-AUTOLOOP) · [注册](https://monid.ai?utm_source=github&utm_campaign=oss-pr&utm_content=kkkkhazix-agent-autoloop&aid=OSS-KKKKHAZIX-AGENT-AUTOLOOP)

## English

Run the command above with `MONID_API_KEY`, your owned AgentLine number ID and call ID.
The standalone example prints the transcript JSON and polls asynchronous runs.
Missing credentials, Monid failures and AgentLine errors exit with a nonzero status.
Existing runtime behavior, plugins and rules stay unchanged; this example is opt-in.
