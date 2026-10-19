#!/usr/bin/env bash
# ============================================================
# 天衍 (Tianyan) — 一键启动 (Linux / macOS)
# 用法: bash tianyan.sh   |   ./tianyan.sh   |   bash tianyan.sh --port 8080
#       bash tianyan.sh --no-start   # 只装环境与依赖, 不启动
#
# 逐段对齐 tianyan.bat:
#   环境检测(Node/npm/TS/Python, 缺则自动拉取安装)
#   → 依赖自检(5 镜像轮换, 成功即停) → tsc 就绪 → 编译(失败必停)
#   → Playwright Chromium → Python 侧车 Scrapling → 启动
#
# 兼容 macOS 自带 bash 3.2: 不用关联数组 / mapfile / readlink -f / ${var,,}
# ============================================================

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR" || { echo "找不到目录: $DIR"; exit 1; }

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; DIM='\033[2m'; NC='\033[0m'
ok()   { printf "  ${GREEN}✓${NC} %s\n" "$*"; }
bad()  { printf "  ${RED}✗${NC} %s\n" "$*"; }
warn() { printf "  ${YELLOW}!${NC} %s\n" "$*"; }
info() { printf "  ${DIM}i${NC} %s\n" "$*"; }

OS="$(uname -s)"
ARCH="$(uname -m)"

# 便携运行时: 装在项目内, 不污染系统, 不需要 sudo
RUNTIME="$DIR/.runtime"
NODE_WANT="22.23.3"
NODE_MIN="22"
DLDIR="${TMPDIR:-/tmp}/tianyan-dl"
mkdir -p "$DLDIR" 2>/dev/null

# 剔除 --no-start, 其余参数原样透传给 CLI (用位置参数重建, 含空格的参数不会被拆词)
NO_START=0
_n=$#
_i=0
while [ "$_i" -lt "$_n" ]; do
    _a="$1"; shift
    if [ "$_a" = "--no-start" ]; then
        NO_START=1
    else
        set -- "$@" "$_a"
    fi
    _i=$((_i + 1))
done
unset _n _i _a

echo ""
echo "  天衍【Tianyan】- 一键启动"
echo "  ============================================"
echo ""
info "平台: ${OS} ${ARCH}   目录: ${DIR}"

# ── 0. 下载工具 ──
if command -v curl >/dev/null 2>&1; then
    DL_TOOL="curl"
elif command -v wget >/dev/null 2>&1; then
    DL_TOOL="wget"
else
    bad "系统缺少 curl / wget，无法自动下载运行时"
    echo "    Debian/Ubuntu: sudo apt-get install -y curl"
    echo "    macOS 自带 curl，若缺失请重装系统工具"
    exit 1
fi

# download <url> <outfile>  → 0 成功
download() {
    _u="$1"; _o="$2"
    rm -f "$_o" 2>/dev/null
    if [ "$DL_TOOL" = "curl" ]; then
        curl -fL --retry 2 --connect-timeout 20 --max-time 900 -o "$_o" "$_u" >/dev/null 2>&1
    else
        wget -q -T 20 -t 2 -O "$_o" "$_u" >/dev/null 2>&1
    fi
    [ -f "$_o" ] || return 1
    _sz="$(wc -c <"$_o" 2>/dev/null | tr -d ' ')"
    case "$_sz" in ''|*[!0-9]*) return 1 ;; esac
    [ "$_sz" -gt 1000000 ]
}

# ── 1. 环境检测: Node.js / npm / TypeScript / Python ──
echo "  [环境检测]"
echo "  --------------------------------------------"

node_major_of() {
    _v="$("$1" -v 2>/dev/null)"
    _v="${_v#v}"
    _m="${_v%%.*}"
    case "$_m" in ''|*[!0-9]*) echo 0 ;; *) echo "$_m" ;; esac
}

find_node() {
    NODE_EXE=""; NPM_EXE=""; NPX_EXE=""; NODE_DIR=""; NODE_VER=""

    # (1) 项目内置便携版
    if [ -x "$RUNTIME/node/bin/node" ]; then
        NODE_EXE="$RUNTIME/node/bin/node"
        NODE_DIR="$RUNTIME/node/bin"
    fi
    # (2) PATH
    if [ -z "$NODE_EXE" ] && command -v node >/dev/null 2>&1; then
        NODE_EXE="$(command -v node)"
        NODE_DIR="$(dirname "$NODE_EXE")"
    fi
    # (3) 常见安装位置 (Homebrew / MacPorts / volta / fnm / nvm)
    if [ -z "$NODE_EXE" ]; then
        for d in /opt/homebrew/bin /usr/local/bin /opt/local/bin \
                 "$HOME/.volta/bin" "$HOME/.fnm/aliases/default/bin"; do
            if [ -z "$NODE_EXE" ] && [ -x "$d/node" ]; then
                NODE_EXE="$d/node"; NODE_DIR="$d"
            fi
        done
    fi
    if [ -z "$NODE_EXE" ] && [ -d "$HOME/.nvm/versions/node" ]; then
        for d in "$HOME/.nvm/versions/node"/*/bin; do
            [ -x "$d/node" ] && { NODE_EXE="$d/node"; NODE_DIR="$d"; }
        done
    fi

    if [ -n "$NODE_EXE" ]; then
        NODE_VER="$("$NODE_EXE" -v 2>/dev/null)"
        if [ -z "$NODE_VER" ]; then
            # 拿不到版本 = 这个 node 根本跑不起来，视为未安装
            NODE_EXE=""; NODE_DIR=""
        else
            [ -x "$NODE_DIR/npm" ] && NPM_EXE="$NODE_DIR/npm"
            [ -x "$NODE_DIR/npx" ] && NPX_EXE="$NODE_DIR/npx"
        fi
    fi
}

install_node() {
    # 目标平台串
    case "$ARCH" in
        x86_64|amd64) A="x64" ;;
        aarch64|arm64) A="arm64" ;;
        armv7l) A="armv7l" ;;
        *) bad "不支持的 CPU 架构: $ARCH"; return 1 ;;
    esac
    case "$OS" in
        Darwin) P="darwin-$A" ;;
        Linux)
            if [ -f /etc/alpine-release ]; then P="linux-$A-musl"; else P="linux-$A"; fi
            ;;
        *) bad "不支持的系统: $OS"; return 1 ;;
    esac

    TARNAME="node-v${NODE_WANT}-${P}.tar.gz"
    TARBALL="$DLDIR/$TARNAME"

    got=0
    for base in \
        "https://registry.npmmirror.com/-/binary/node/v${NODE_WANT}" \
        "https://mirrors.huaweicloud.com/nodejs/v${NODE_WANT}" \
        "https://nodejs.org/dist/v${NODE_WANT}"
    do
        [ "$got" -eq 1 ] && break
        echo "    下载 ${base}/${TARNAME}"
        if download "${base}/${TARNAME}" "$TARBALL"; then got=1; fi
    done
    if [ "$got" -ne 1 ]; then
        bad "全部下载源失败"
        return 1
    fi
    echo "    + 下载完成，解压中..."

    mkdir -p "$RUNTIME" 2>/dev/null
    rm -rf "$RUNTIME/node" 2>/dev/null
    if ! tar -xzf "$TARBALL" -C "$RUNTIME" >/dev/null 2>&1; then
        bad "解压失败"
        return 1
    fi
    if [ -d "$RUNTIME/node-v${NODE_WANT}-${P}" ]; then
        mv "$RUNTIME/node-v${NODE_WANT}-${P}" "$RUNTIME/node"
    fi
    if [ -x "$RUNTIME/node/bin/node" ]; then
        echo "    + Node.js 便携版就绪: $RUNTIME/node"
        return 0
    fi
    bad "解压后未找到 node 可执行文件"
    return 1
}

find_node
if [ -z "$NODE_EXE" ]; then
    echo "  Node.js    未安装 - 开始自动下载安装..."
    install_node
    find_node
fi
if [ -n "$NODE_EXE" ] && [ "$(node_major_of "$NODE_EXE")" -lt "$NODE_MIN" ]; then
    echo "  Node.js    $NODE_VER 版本过低 (需要 ≥ ${NODE_MIN})，安装便携版..."
    install_node
    find_node
fi
if [ -z "$NODE_EXE" ]; then
    echo ""
    bad "Node.js 自动安装失败"
    echo "    手动安装 Node.js 22 LTS: https://nodejs.org/zh-cn/download"
    echo "    macOS: brew install node@22"
    echo "    Ubuntu/Debian: curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs"
    exit 1
fi
ok "Node.js ${NODE_VER}"

# 让 tianyan.js 内部 spawn 的子进程也能找到 node
export PATH="$NODE_DIR:$PATH"

if [ -z "$NPM_EXE" ] || ! "$NPM_EXE" -v >/dev/null 2>&1; then
    echo "  npm        缺失 - 重新安装完整便携版..."
    install_node
    find_node
    export PATH="$NODE_DIR:$PATH"
fi
if [ -z "$NPM_EXE" ] || ! "$NPM_EXE" -v >/dev/null 2>&1; then
    bad "未检测到 npm，当前 Node.js 安装不完整"
    echo "    请安装完整版 Node.js 22 LTS: https://nodejs.org/zh-cn/download"
    exit 1
fi
ok "npm $("$NPM_EXE" -v 2>/dev/null)"

# ── Python 检测 (可选依赖: 缺失只降级抓取, 不阻断启动) ──
find_python() {
    PY_EXE=""; PY_VER=""
    if [ -x "$RUNTIME/python/bin/python3" ]; then
        PY_EXE="$RUNTIME/python/bin/python3"
    fi
    if [ -z "$PY_EXE" ]; then
        for c in python3.12 python3.13 python3.11 python3.10 python3 python; do
            if command -v "$c" >/dev/null 2>&1; then PY_EXE="$(command -v "$c")"; break; fi
        done
    fi
    if [ -n "$PY_EXE" ]; then
        PY_VER="$("$PY_EXE" -c 'import sys;print("%d.%d"%sys.version_info[:2])' 2>/dev/null)"
        pma="${PY_VER%%.*}"; pmi="${PY_VER#*.}"
        case "$pma" in ''|*[!0-9]*) pma=0 ;; esac
        case "$pmi" in ''|*[!0-9]*) pmi=0 ;; esac
        if [ "$pma" -lt 3 ] || { [ "$pma" -eq 3 ] && [ "$pmi" -lt 10 ]; }; then
            PY_EXE=""; PY_VER=""
        fi
    fi
}

find_python
if [ -z "$PY_EXE" ]; then
    echo "  Python     未检测到 3.10+，尝试自动安装..."
    PY_INSTALLED=0
    if [ "$OS" = "Darwin" ] && command -v brew >/dev/null 2>&1; then
        brew install python@3.12 >/dev/null 2>&1 && PY_INSTALLED=1
    elif [ "$OS" = "Linux" ]; then
        # 仅在免密 sudo 可用时尝试, 不交互卡住脚本
        if command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
            if command -v apt-get >/dev/null 2>&1; then
                sudo -n apt-get install -y python3 python3-venv >/dev/null 2>&1 && PY_INSTALLED=1
            elif command -v dnf >/dev/null 2>&1; then
                sudo -n dnf install -y python3 >/dev/null 2>&1 && PY_INSTALLED=1
            elif command -v yum >/dev/null 2>&1; then
                sudo -n yum install -y python3 >/dev/null 2>&1 && PY_INSTALLED=1
            elif command -v pacman >/dev/null 2>&1; then
                sudo -n pacman -S --noconfirm python >/dev/null 2>&1 && PY_INSTALLED=1
            fi
        fi
    fi
    find_python
fi
if [ -n "$PY_EXE" ]; then
    ok "Python ${PY_VER}"
else
    warn "Python 3.10+ 未就绪 - Scrapling 抓取侧车将降级 (不影响启动)"
    echo "    macOS: brew install python@3.12"
    echo "    Ubuntu/Debian: sudo apt-get install -y python3 python3-venv"
fi

echo "  --------------------------------------------"
echo ""

# ── 2. 依赖自检 + 多镜像源安装 (成功即停) ──
# 不只看目录在不在: 真去 require 一次 typescript 和 better-sqlite3。
# better-sqlite3 是原生模块, 装了一半(缺 .node)时目录齐全但 require 会炸, 只有真 require 才看得出来。
deps_ok() {
    [ -f "node_modules/typescript/package.json" ] || return 1
    "$NODE_EXE" --input-type=commonjs \
        -e "require('typescript');try{require('better-sqlite3')}catch(e){process.exit(1)}" >/dev/null 2>&1
}

M_NAMES=(npmmirror 华为云 腾讯云 清华 "官方 npmjs")
M_URLS=(
    "https://registry.npmmirror.com"
    "https://repo.huaweicloud.com/repository/npm/"
    "https://mirrors.cloud.tencent.com/npm/"
    "https://mirrors.tuna.tsinghua.edu.cn/npm/"
    "https://registry.npmjs.org"
)
NPMLOG="${TMPDIR:-/tmp}/tianyan-npm-install.log"

if deps_ok; then
    ok "依赖已就绪"
else
    warn "依赖未就绪, 逐个尝试镜像源安装, 成功即停"
    DEPS_OK=0
    i=0
    while [ "$i" -lt 5 ]; do
        m_name="${M_NAMES[$i]}"
        m_url="${M_URLS[$i]}"
        echo "  [$((i + 1))/5] 从 ${m_name} 拉取..."
        # --ignore-scripts: better-sqlite3 自带各平台预编译 .node, 跳过 node-gyp 本机编译
        # (没装 Xcode Command Line Tools 的 Mac 上 node-gyp 必失败); Playwright 浏览器和
        # Scrapling 侧车由本脚本后面单独安装。
        "$NPM_EXE" install --ignore-scripts --registry "$m_url" \
            --fetch-timeout 300000 --fetch-retries 2 --no-audit --no-fund >"$NPMLOG" 2>&1
        if deps_ok; then
            ok "依赖安装完成, 来源: ${m_name}"
            DEPS_OK=1
            break
        fi
        bad "${m_name} 失败, 清理残留后切换下一个源"
        rm -rf node_modules 2>/dev/null
        i=$((i + 1))
        if [ "$i" -lt 5 ]; then sleep 3; fi
    done

    if [ "$DEPS_OK" -ne 1 ]; then
        bad "5 个镜像源全部安装失败"
        echo "    ---- npm 真实报错 (最后 30 行) ----"
        tail -30 "$NPMLOG" 2>/dev/null | sed 's/^/    /'
        echo "    ----------------------------------"
        echo "    完整日志: ${NPMLOG}"
        echo "    可手动执行: \"$NPM_EXE\" install --registry https://registry.npmmirror.com"
        exit 1
    fi
fi

# ── 3. TypeScript 编译器就绪检查 ──
# 直接 node.exe 跑 typescript/bin/tsc, 不走 .bin/tsc shim, 彻底绕开 PATH:
# shim 内部写的是裸 node, PATH 没注入时就报 '"node"' is not recognized
TSC_JS="$DIR/node_modules/typescript/bin/tsc"
if [ ! -f "$TSC_JS" ]; then
    bad "TypeScript 编译器不可用 (node_modules/typescript/bin/tsc 不存在)"
    echo "    可手动执行: \"$NPM_EXE\" install typescript --save-dev"
    exit 1
fi
ok "TypeScript $("$NODE_EXE" "$TSC_JS" --version 2>&1 | sed 's/^Version //')"

# ── 4. 编译 TypeScript ──
echo "  编译 TypeScript..."
TSC_LOG="${TMPDIR:-/tmp}/tianyan-tsc.log"
"$NODE_EXE" "$TSC_JS" >"$TSC_LOG" 2>&1
if [ $? -ne 0 ]; then
    bad "编译失败, TypeScript 报错如下:"
    sed 's/^/    /' "$TSC_LOG" | tail -40
    echo "    手动复现: \"$NODE_EXE\" \"$TSC_JS\""
    exit 1
fi
if [ ! -f "dist/index.js" ]; then
    bad "编译未产出 dist/index.js"
    echo "    手动复现: \"$NODE_EXE\" \"$TSC_JS\""
    exit 1
fi
ok "编译完成"

if [ "$NO_START" -eq 1 ]; then
    echo ""
    ok "环境与依赖已就绪 (--no-start, 不启动)"
    exit 0
fi

# ── 5. Playwright Chromium (可选, 失败自动降级) ──
# 不去猜缓存目录 —— macOS 是 ~/Library/Caches/ms-playwright, Linux 是 ~/.cache,
# Windows(Git Bash) 是 %LOCALAPPDATA%\ms-playwright, 猜错就会每次启动都重装一遍。
# 直接问 playwright 要可执行文件路径, 再看文件在不在, 跨平台唯一正确的做法。
pw_path() {
    "$NODE_EXE" --input-type=commonjs \
        -e "try{console.log(require('playwright').chromium.executablePath())}catch(e){}" 2>/dev/null
}
PW_BIN="$(pw_path)"
if [ -n "$PW_BIN" ] && [ -f "$PW_BIN" ]; then
    ok "Playwright Chromium 已就绪"
else
    echo "  安装 Playwright Chromium (约百 MB, 失败不影响启动)..."
    "$NPM_EXE" exec -- playwright install chromium >/dev/null 2>&1
    if [ $? -ne 0 ]; then
        echo "  官方源不通, 改用 npmmirror 镜像重试..."
        PLAYWRIGHT_DOWNLOAD_HOST="https://cdn.npmmirror.com/binaries/playwright" \
            "$NPM_EXE" exec -- playwright install chromium >/dev/null 2>&1
    fi
    PW_BIN="$(pw_path)"
    if [ -n "$PW_BIN" ] && [ -f "$PW_BIN" ]; then
        ok "Playwright Chromium 就绪"
    else
        info "Playwright 安装失败, 浏览器抓取功能自动降级"
    fi
fi

# ── 6. Python 侧车 Scrapling (可选, 失败自动降级) ──
# 每次都跑 installer: 它内部用 import scrapling 做真实校验 (marker 只做加速), 装好时秒退,
# 包丢了会自动重装。旧逻辑只在 .venv-scrapling 不存在时才跑, 一旦 marker 在、包不在就
# 静默跳过 —— 用户看到的现象就是"抓取压根没启用"。
if [ -n "$PY_EXE" ]; then
    TIANYAN_SCRAPLING_PY="$PY_EXE" "$NODE_EXE" scripts/install-scrapling.js \
        || info "Scrapling 侧车初始化失败, 抓取自动降级 dom-sim/fetch 层"
else
    info "Scrapling 侧车不可用, 抓取自动降级"
fi

# ── 7. 启动 CLI (随机端口 8000~9000 + 自动打开浏览器) ──
echo ""
exec "$NODE_EXE" bin/tianyan.js "$@"
