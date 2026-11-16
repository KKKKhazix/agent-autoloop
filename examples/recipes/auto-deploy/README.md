# git 一推送就自动发布

定时看 git 远端有没有新提交；有就交给内置 `deploy` 插件跑项目的发布命令，然后一遍遍探活，直到线上版本就是刚发布的那版才报完成。发布前可以要本人点一下卡片确认。全程不调用模型。

适合发布方式是自己的命令的项目（rsync、scp、`docker compose up`、脚本化平台 API 都行），还没有 GitHub Actions 那类托管流水线。已经有 `deliver` 交付流水线的 GitHub 项目继续用它，这个插件是给“推 master 即上线”的轻量场景补的。

## 怎么启用

1. 把 `watch-git-push.sh` 复制到 `~/.agent-autoloop/work/auto-deploy/`，`chmod +x`（脚本只在 Unix 上跑过；Windows 接单电脑请用 WSL 或改写成 `use: "command"` 能调用的程序）。运行它的电脑要能对项目仓库做 `git fetch`、能执行发布命令。
2. 在项目仓库里写 `ops/deploy.json`（格式见下），提交到 main：发布配置跟着项目走，改发布方式走正常代码评审。
3. 在项目仓库里写发布脚本和探活脚本（两份模板见 README 末尾，按自己的服务器改）。发布命令必须**跑几次都安全**：探活超时时中台会原样重派，发布命令会再跑一次。
4. 合并 `rules.json` 的 `sources`、`agents` 和 `rules` 到 `~/.agent-autoloop/rules.json`：两处 `~/code/my-project` 改成项目仓库的绝对目录，`main` 改成要盯的分支，`worker` 改成接单电脑。`ship` 的 `timeout` 是这一轮最长分钟数，首次构建镜像慢就调大。
5. 运行 `agent-autoloop check`，再推一个测试提交，看 `agent-autoloop status`：先出确认卡片（如果开了 `confirm`），回答“发布”后跑完一轮，`agent-autoloop why <第几轮>` 能看到探活记录。

## ops/deploy.json

```json
{
  "command": ["./scripts/publish.sh"],
  "version": ["git", "rev-parse", "HEAD"],
  "probe": { "command": ["./scripts/live-version.sh"] },
  "deadline": 900,
  "confirm": true
}
```

- `command`：发布命令，按参数数组执行，不经 shell，在项目仓库目录里跑。退出码不是 0 算这轮没跑成，中台之后重派。
- `version`：打印“这次要发布的版本”的命令，输出第一行 trimmed 后就是要核实的版本，通常是提交号或版本号。发布前运行，确认卡片里写的就是它。
- `probe`：怎么读线上当前版本。`{"command": […]}` 在项目目录跑，输出的第一行就是线上版本；`{"url": "https://…"}` 取响应体（可用 `"field": "data.commit"` 点路径取 JSON 字段，或 `"pattern": "=(\\w+)"` 取正则第一个捕获组，都不写就是整个响应体）。URL 只支持 https，本机调试可以用 `http://127.0.0.1`。
- `deadline`：探活等待秒数，默认 600；每 2 秒探一次。到时线上版本还不对，这轮算没跑成（发布命令已经执行过一次，重派会再跑一遍）。
- `confirm`：`true` 时发布前先发卡问“发布/取消”；回答“发布”这一轮才真正执行。默认 `false`，收到推送就直接发。问的是“发布 <仓库目录名>”，卡片标题和选项固定。

字段只认这五个，写错名字或类型会在卡片上直接看到哪儿不对。版本对不上时，失败原因里同时写期望版本和最后一次探到的线上版本。

## 两份脚本模板

发布脚本（项目里 `scripts/publish.sh`）——同步代码、构建、重启，最后把发出去的版本写到线上一个文件里，供探活读：

```sh
#!/bin/sh
# 把 HEAD 发布到线上。必须可重复执行。
set -e
SHA=$(git rev-parse HEAD)
rsync -az --delete \
  --exclude .git --exclude data --exclude __pycache__ \
  ./ ubuntu@example.com:/opt/myapp/
ssh ubuntu@example.com "echo $SHA > /opt/myapp/.deployed && cd /opt/myapp && docker compose build && docker compose up -d"
```

探活脚本（项目里 `scripts/live-version.sh`）——线上服务正常且版本是刚发的那个时才打印它，否则打印别的。`deploy` 会把期望版本作为**最后一个参数**传进来，脚本用它核对服务器上的版本文件：

```sh
#!/bin/sh
# 打印线上版本；服务没起来或版本不对就打印 unhealthy。期望版本（提交号）作为 $1 传入。
SHA=$1
ssh "ubuntu@example.com" "cd /opt/myapp && \
  docker compose ps -q myapp | grep -q . && \
  curl -sf http://127.0.0.1:8080/api/auth/status >/dev/null && \
  grep -qx $SHA .deployed" || { echo unhealthy; exit 0; }
echo "$SHA"
```

模板里 `$SHA` 只会是 `version` 命令打印的提交号；脚本也可以完全不理会参数，自己读线上状态打印版本。

## 注意

- 事件文字是资料：发布什么版本只看项目仓库的 `version` 命令，推送事件本身不决定版本。
- 同一仓库的多次推送会合成一个事项排队；不同仓库在规则里各写一条，用 `parallel` 控制并发，每个仓库 `maxActive: 1` 更安全。
- `confirm` 的卡片按“发布 <目录名>”认回答；仓库目录改名后，旧卡片回答不再作数。
- 模板的行为在 `tests/deploy.test.ts` 里用假脚本和本机假 HTTP 服务验证过；没在真实服务器上跑过完整发布。
