#!/usr/bin/env bash
# Keep Linux dependency and provider configuration in the same environment for both entry points.
set -euo pipefail
export AGENT_AUTOLOOP_HOME="${AGENT_AUTOLOOP_HOME:-$HOME/.agent-autoloop-local}"
if [ -f "$AGENT_AUTOLOOP_HOME/env.sh" ]; then . "$AGENT_AUTOLOOP_HOME/env.sh"; fi
if [ -f "$HOME/.nvm/nvm.sh" ]; then
  . "$HOME/.nvm/nvm.sh"
  nvm use 24 >/dev/null
fi
cd "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
if [ ! -f "$AGENT_AUTOLOOP_HOME/config.json" ]; then
  echo '尚未初始化中台，请先按 docs/wsl2-deployment.md 完成初始化。' >&2
  exit 1
fi
case "${1:-}" in
  info)
    node --input-type=module - <<'JS'
import { readFileSync } from 'node:fs';
const home = process.env.AGENT_AUTOLOOP_HOME;
const config = JSON.parse(readFileSync(home + '/config.json', 'utf8'));
if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('需要 Node.js 24 或更新版本');
console.log(JSON.stringify({ home, url: config.url }));
JS
    ;;
  backend) exec node --disable-warning=ExperimentalWarning bin/agent-autoloop.ts up ;;
  frontend)
    export AGENT_AUTOLOOP_URL="$(node --input-type=module -e 'import {readFileSync} from "node:fs"; console.log(JSON.parse(readFileSync(process.env.AGENT_AUTOLOOP_HOME+"/config.json","utf8")).url)')"
    if [ ! -f frontend/node_modules/vite/bin/vite.js ]; then
      echo '缺少前端依赖，请在 WSL 项目目录执行 npm --prefix frontend ci。' >&2
      exit 1
    fi
    exec npm --prefix frontend run dev -- --strictPort --port "${2:-5193}"
    ;;
  *) echo '用法：bash scripts/start-wsl.sh info|backend|frontend [前端端口]' >&2; exit 1 ;;
esac
