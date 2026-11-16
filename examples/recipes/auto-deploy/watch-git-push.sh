#!/bin/sh
# 定时看一眼 git 远端分支有没有新提交，有就发事件让中台发布。没有新东西不跑发布、不花 Token。中台在家里、
# 仓库 Webhook 进不来时也能用。
#
#   "agents": { "watcher": { "name": "看推送", "worker": "my-mac", "use": "command", "command": ["/绝对路径/watch-git-push.sh", "/绝对路径/repo", "main"] } }
#   "rules": [
#     { "name": "看 main 推送", "when": { "cron": "* * * * *" }, "to": "watcher", "cwd": "/绝对路径/repo", "tell": "never", "emits": { "source": "git", "types": ["git.pushed"] } },
#     { "name": "发布", "when": { "source": "git", "types": ["git.pushed"] }, "to": "ship", "cwd": "/绝对路径/repo", "prompt": "把最新提交发布到线上并核实版本。", "parallel": 1 }
#   ]
#
# 第一个参数是仓库目录，第二个参数是分支名（默认 main）。游标存在中台目录里，同一提交重复读到只记一次；
# 事件 id 是「目录名@提交号」，天然去重。提交说明里的引号、换行交给 jq 处理，不经手写 JSON。
set -e
REPO="$1"
BRANCH="${2:-main}"
[ -n "$REPO" ] || { echo "没跑成：用法：watch-git-push.sh <仓库目录> <分支>"; exit 1; }
cd "$REPO"
NAME=$(basename "$REPO")
STATE="${AGENT_AUTOLOOP_HOME:?}/watch-git-$(printf '%s@%s' "$REPO" "$BRANCH" | cksum | awk '{print $1}').txt"

if ! git fetch -q origin "$BRANCH" 2>/dev/null; then
  echo "没跑成：git fetch 失败：$NAME/$BRANCH 拉不到"
  exit 1
fi
NEW=$(git rev-parse --quiet --verify "origin/$BRANCH") || { echo "没跑成：远端没有 $BRANCH 分支"; exit 1; }
OLD=$(cat "$STATE" 2>/dev/null || true)
if [ "$NEW" = "$OLD" ]; then
  echo "看了 $NAME/$BRANCH，没有新提交"
  exit 0
fi

# 先组装好事件再记游标：组装失败（如 jq 不在）下次还能重试这条提交。
BODY=$(git log -1 --format=%s "origin/$BRANCH" | jq -Rnc --arg id "$NAME@$NEW" --arg name "$NAME" 'input as $s | {events: [{id: $id, type: "git.pushed", subject: $name, summary: $s, detail: $s}]}')
printf '%s' "$NEW" > "$STATE"

echo "发现 $NAME/$BRANCH 新提交 $(git log -1 --format=%h "origin/$BRANCH")"
echo
echo '```agent-autoloop'
printf '%s\n' "$BODY"
echo '```'
