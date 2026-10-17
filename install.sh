#!/usr/bin/env bash
# 一键安装: npm 依赖 + Scrapling 抓取侧车 (python venv + pip)
set -e
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"
echo "✦ 天衍 — 一键安装 (npm + Scrapling 侧车)"
if ! command -v node &> /dev/null; then echo "  [错误] 未检测到 Node.js"; exit 1; fi
if ! command -v npm &> /dev/null; then echo "  [错误] 未检测到 npm"; exit 1; fi
# 1. npm 依赖 (postinstall 会自动调 scripts/install-scrapling.js 装 Python 侧车)
npm install --no-audit --no-fund
# 2. 确认 Python 侧车 (postinstall 失败时手动补跑一次, 不阻断)
if ! node -e "require('node:fs').existsSync('.venv-scrapling/.scrapling-installed')" 2>/dev/null; then
  echo "↓ 补装 Scrapling 侧车 (npm postinstall 未生效)"
  node scripts/install-scrapling.js || echo "⚠ Scrapling 侧车装不上, 抓取自动降级 dom-sim/fetch 层"
fi
# 3. 编译
npm run build || true
echo "✓ 安装完成. 启动: ./na  或  npm start"
