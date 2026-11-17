# 飞书卡片快速更新

默认通过 `lark-cli` 收发卡片。飞书通道可选配 `fastCli`，值是用本目录 `fast-cli.patch` 构建的可执行文件绝对路径。它沿用本机 `lark-cli` 的账户和凭据存取方式。它跳过回调里多余的卡片正文读取，原卡更新通过常驻客户端复用机器人令牌和连接。快速更新失败时，通道仍用普通 `lark-cli` 重试原卡。

构建需要 Go。下面的命令在临时目录构建，不覆盖系统安装的 `lark-cli`。

```sh
patch_file=/absolute/path/to/agent-autoloop/plugins/feishu/fast-cli.patch
build_dir=$(mktemp -d)
git clone --depth 1 --branch v1.0.99 https://github.com/larksuite/cli.git "$build_dir/cli"
git -C "$build_dir/cli" apply "$patch_file"
(cd "$build_dir/cli" && go build -ldflags '-X github.com/larksuite/cli/internal/build.Version=1.0.99' -o "$build_dir/lark-cli-fast" .)
```

将二进制放在本机的稳定路径，配置 `channels.feishu.fastCli` 后重启服务。

同时设置 `channels.feishu.callbackToast: true` 启用回调浮层。它使用同一个飞书应用的长连接，在中台记下确认后直接返回「已收到确认」。重复提交返回卡片已经处理，任务完成仍更新原卡。切换时先停旧监听及该应用的 CLI 事件总线，再启动新监听。新监听启动失败会回到 CLI 的普通回调。去掉 `callbackToast` 并重启可恢复上一种监听，保留快速更新。

验证时用只做模拟工作的测试卡，分别记录桌面端和手机端从点击到浮层可见的时间，再核对原卡最终结果与重复点击对应的执行轮次。
