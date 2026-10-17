#!/usr/bin/env bash
# ============================================================
# 天衍 (Tianyan) — 一键启动 (OpenClaw 风格)
# 用法: bash tianyan.sh   |   ./tianyan.sh
# TypeScript 环境自动检测 + 多镜像源自动切换安装
# ============================================================
set -e
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'

echo ""
echo -e "  ${CYAN}✦ 天衍 (Tianyan) — 一键启动${NC}"
echo "  ============================================"
echo ""

# ── 镜像源列表 (挂了自动换下一个, 每个源超时 15 秒) ──
MIRRORS=(
  "npmmirror|https://registry.npmmirror.com"
  "华为云|https://repo.huaweicloud.com/repository/npm/"
  "腾讯云|https://mirrors.cloud.tencent.com/npm/"
  "清华|https://registry.npmmirror.com"
  "官方|https://registry.npmjs.org"
)

# ── 1. 检查 Node.js ──
if ! command -v node &> /dev/null; then
    echo -e "  ${RED}[错误] 未检测到 Node.js${NC}"
    echo "  请安装 Node.js ≥ 18: https://nodejs.org/"
    exit 1
fi
echo -e "  ${GREEN}✓${NC} Node.js $(node -v)"

# ── 2. 检查 npm ──
if ! command -v npm &> /dev/null; then
    echo -e "  ${RED}[错误] 未检测到 npm${NC}"
    exit 1
fi
echo -e "  ${GREEN}✓${NC} npm $(npm -v)"

# ── 3. 实时检测 TypeScript 是否可用 ──
TS_OK=false
if npx tsc --version &> /dev/null 2>&1; then
    TS_VER=$(npx tsc --version 2>/dev/null)
    echo -e "  ${GREEN}✓${NC} TypeScript $TS_VER"
    TS_OK=true
fi

# ── 4. TypeScript 不可用 → 自动安装, 多镜像源轮换 ──
if [ "$TS_OK" = false ]; then
    echo -e "  ${YELLOW}⚠ TypeScript 未安装, 自动安装中...${NC}"
    INSTALLED=false

    for MIRROR_ENTRY in "${MIRRORS[@]}"; do
        MIRROR_NAME="${MIRROR_ENTRY%%|*}"
        MIRROR_URL="${MIRROR_ENTRY##*|}"

        echo -e "  ${CYAN}⟳${NC} 尝试 ${MIRROR_NAME} (${MIRROR_URL}) ..."

        if npm install typescript --save-dev \
            --registry "$MIRROR_URL" \
            --fetch-timeout 15000 \
            --fetch-retries 1 \
            --no-audit --no-fund \
            > /dev/null 2>&1; then

            # 验证安装结果
            if npx tsc --version &> /dev/null 2>&1; then
                TS_VER=$(npx tsc --version 2>/dev/null)
                echo -e "  ${GREEN}✓${NC} TypeScript $TS_VER ${GREEN}(${MIRROR_NAME} 安装成功)${NC}"
                INSTALLED=true
                break
            fi
        fi

        echo -e "  ${YELLOW}✗${NC} ${MIRROR_NAME} 失败, 切换下一个..."
    done

    if [ "$INSTALLED" = false ]; then
        echo -e "  ${RED}[错误] 所有镜像源均安装失败${NC}"
        echo "  请手动执行: npm install typescript"
        exit 1
    fi
fi

# ── 5. 安装 npm 依赖 ──
if [ ! -d "node_modules" ]; then
    echo "  📦 安装依赖..."
    for MIRROR_ENTRY in "${MIRRORS[@]}"; do
        MIRROR_NAME="${MIRROR_ENTRY%%|*}"
        MIRROR_URL="${MIRROR_ENTRY##*|}"
        echo -e "  ${CYAN}⟳${NC} 从 ${MIRROR_NAME} 安装依赖..."
        if npm install --registry "$MIRROR_URL" --no-audit --no-fund 2>/dev/null; then
            echo -e "  ${GREEN}✓${NC} 依赖安装完成"
            break
        fi
        echo -e "  ${YELLOW}✗${NC} ${MIRROR_NAME} 失败, 换下一个..."
    done
fi

# ── 6. 编译 TypeScript ──
echo "  🔨 编译 TypeScript..."
npx tsc 2>/dev/null || npx tsc

# ── 7. Playwright Chromium (可选, 非必需) ──
if [ ! -d "$HOME/.cache/ms-playwright" ]; then
    echo "  🌐 安装 Playwright Chromium (用于扫榜抓取)..."
    npx playwright install chromium 2>/dev/null || \
        echo -e "  ${YELLOW}⚠ Playwright 安装失败, 浏览器抓取功能降级${NC}"
fi

# ── 7.5 Python 环境 (Scrapling 抓取侧车) ──
# 代码引用了开源 Scrapling (BSD-3-Clause, Copyright 2024 Karim shoair), 需 Python 3.10-3.13 才能启用最强抓取层.
# 自动检测系统 python3/python; 缺 或 版本 < 3.10 → 提示手动安装 (电脑端), 抓取自动降级 dom-sim/fetch 层, 不阻断启动.
pycmd=""
for c in python3 python; do
    if command -v "$c" &> /dev/null; then
        pver="$("$c" -c 'import sys; print("%d.%d" % sys.version_info[:2])' 2>/dev/null)"
        pma="${pver%%.*}"; pmi="${pver#*.}"
        if [ -n "$pver" ] && { [ "$pma" -gt 3 ] || { [ "$pma" -eq 3 ] && [ "$pmi" -ge 10 ]; }; }; then
            pycmd="$c"; break
        fi
    fi
done
if [ -n "$pycmd" ]; then
    echo -e "  ${GREEN}✓${NC} Python $("$pycmd" --version 2>&1 | cut -d" " -f1) (Scrapling 抓取侧车可用)"
    if [ ! -d ".venv-scrapling" ]; then
        echo -e "  ${YELLOW}↓${NC} 初始化 Scrapling 侧车 (node scripts/install-scrapling.js, 可能 1~2 分钟)..."
        node scripts/install-scrapling.js 2>/dev/null || true
    fi
else
    echo -e "  ${YELLOW}⚠ 未检测到 Python 3.10-3.13 (Scrapling 抓取侧车不可用, 自动降级 dom-sim/fetch 层)${NC}"
    echo "  电脑端安装 (详见 README.md「Python 环境标签」): python.org 下载 3.10-3.13 并勾选 Add to PATH, 之后重跑 bash tianyan.sh"
fi
# ── 8. 启动 CLI (随机端口 8000~9000 + 自动打开浏览器) ──
echo ""
exec node bin/tianyan.js
