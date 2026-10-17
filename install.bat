@echo off
chcp 65001 >nul 2>&1
cd /d "%~dp0"
echo * 天衍 - 一键安装 (npm + Scrapling 侧车)
where node >nul 2>nul || (echo [错误] 未检测到 Node.js，请先安装: https://nodejs.org/ & exit /b 1)
where npm  >nul 2>nul || (echo [错误] 未检测到 npm & exit /b 1)

rem  --ignore-scripts: better-sqlite3 自带各平台预编译 .node，跳过 node-gyp 本机编译，
rem  避免在没有 VS C++ 生成工具的机器上失败
call npm install --ignore-scripts --no-audit --no-fund
if not exist "node_modules\typescript\package.json" (
    echo * 默认源不通，改用 npmmirror 重试...
    call npm install --ignore-scripts --registry https://registry.npmmirror.com --no-audit --no-fund
)
if not exist "node_modules\typescript\package.json" (
    echo [错误] 依赖安装失败，请检查网络或代理设置
    exit /b 1
)

if not exist ".venv-scrapling\.scrapling-installed" (
  echo / 补装 Scrapling 侧车
  node scripts\install-scrapling.js
)
call npm run build
echo [完成] 启动: na.bat 或 npm start
