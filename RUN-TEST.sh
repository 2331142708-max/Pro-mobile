#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
if [ ! -x "$HOME/.bun/bin/bun" ]; then
  echo 'Bun 未安装，请检查 $HOME/.bun/bin/bun'; exit 2
fi
export PORT="${PORT:-3088}"
export PRO_ACCESS_CODE="${PRO_ACCESS_CODE:-10086}"
exec "$HOME/.bun/bin/bun" server.js
