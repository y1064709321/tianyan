@echo off
chcp 65001 >nul 2>&1
setlocal EnableDelayedExpansion

set "DIR=%~dp0"
cd /d "%DIR%"

echo.
echo   天衍【Tianyan】- 一键启动
echo   ============================================
echo.

rem ==========================================================
rem  1. 定位 Node.js / npm / npx (PATH -> 用户级 -> 系统级 -> nvm -> fnm)
rem ==========================================================
set "NODE_EXE=node"
set "NPM_EXE=npm"
set "NPX_EXE=npx"
set "NODE_HOME="
set "LAD=%LOCALAPPDATA%"
if not defined LAD set "LAD=%USERPROFILE%\AppData\Local"

where node >nul 2>&1
if errorlevel 1 (
    for %%D in ("%LAD%\Programs\nodejs" "C:\Program Files\nodejs" "%LAD%\fnm\node-alias") do (
        if not defined NODE_HOME if exist "%%~D\node.exe" set "NODE_HOME=%%~D"
    )
    if not defined NODE_HOME for /d %%V in ("%LAD%\nvm\*") do (
        if not defined NODE_HOME if exist "%%~V\node.exe" set "NODE_HOME=%%~V"
    )
) else (
    for /f "delims=" %%D in ('where node 2^>nul') do (
        if not defined NODE_HOME set "NODE_HOME=%%~dpD"
    )
)

if defined NODE_HOME if "!NODE_HOME:~-1!"=="\" set "NODE_HOME=!NODE_HOME:~0,-1!"

if defined NODE_HOME (
    if exist "!NODE_HOME!\node.exe" set "NODE_EXE=!NODE_HOME!\node.exe"
    if exist "!NODE_HOME!\npm.cmd"  set "NPM_EXE=!NODE_HOME!\npm.cmd"
    if exist "!NODE_HOME!\npx.cmd"  set "NPX_EXE=!NODE_HOME!\npx.cmd"
    echo   + Node.js 目录: !NODE_HOME!
)

set "NODE_VER="
for /f "tokens=*" %%i in ('"%NODE_EXE%" -v 2^>^&1') do set "NODE_VER=%%i"
if not defined NODE_VER (
    echo   [错误] 未检测到 Node.js
    echo   请先安装 Node.js 18 及以上版本: https://nodejs.org/
    pause
    exit /b 1
)
echo   + Node.js %NODE_VER%

set "NPM_VER="
for /f "tokens=*" %%i in ('call "%NPM_EXE%" -v 2^>^&1') do set "NPM_VER=%%i"
if not defined NPM_VER (
    echo   [错误] 未检测到 npm，它通常随 Node.js 一起安装
    pause
    exit /b 1
)
echo   + npm %NPM_VER%

rem ==========================================================
rem  2. 依赖自检 + 多镜像源安装 (成功即停)
rem ==========================================================
set "N1=npmmirror"    & set "M1=https://registry.npmmirror.com"
set "N2=华为云"       & set "M2=https://repo.huaweicloud.com/repository/npm/"
set "N3=腾讯云"       & set "M3=https://mirrors.cloud.tencent.com/npm/"
set "N4=清华"         & set "M4=https://mirrors.tuna.tsinghua.edu.cn/npm/"
set "N5=官方 npmjs"   & set "M5=https://registry.npmjs.org"
set "NPMLOG=%TEMP%\tianyan-npm-install.log"

set "DEPS_OK=0"
if exist "node_modules\typescript\package.json" (
    "%NODE_EXE%" --input-type=commonjs -e "require('typescript');try{require('better-sqlite3')}catch(e){process.exit(1)}" >nul 2>&1
    if not errorlevel 1 set "DEPS_OK=1"
)

if !DEPS_OK! equ 0 (
    echo   依赖未就绪，逐个尝试镜像源安装，成功即停
    for /L %%i in (1,1,5) do (
        if !DEPS_OK! equ 0 (
            echo   [%%i/5] 从 !N%%i! 拉取...
            rem  --ignore-scripts: better-sqlite3 自带各平台预编译 .node，跳过 node-gyp
            rem  本机编译（避免在没有 VS C++ 生成工具的机器上失败）；Playwright 浏览器与
            rem  Scrapling 侧车由本脚本在后面单独安装。
            call "%NPM_EXE%" install --ignore-scripts --registry "!M%%i!" --fetch-timeout 300000 --fetch-retries 2 --no-audit --no-fund >"%NPMLOG%" 2>&1
            if exist "node_modules\typescript\package.json" (
                "%NODE_EXE%" --input-type=commonjs -e "require('typescript');try{require('better-sqlite3')}catch(e){process.exit(1)}" >nul 2>&1
                if not errorlevel 1 (
                    echo   + 依赖安装完成，来源: !N%%i!
                    set "DEPS_OK=1"
                )
            )
            if !DEPS_OK! equ 0 (
                echo   x !N%%i! 失败，清理残留后切换下一个源
                if exist "node_modules" rmdir /s /q "node_modules" 2>nul
                if not %%i==5 timeout /t 3 /nobreak >nul
            )
        )
    )
)

if !DEPS_OK! equ 0 (
    echo   [错误] 5 个镜像源全部安装失败
    echo   可能原因: 网络不通 / 代理未配置 / npm 缓存损坏
    echo   完整日志: %NPMLOG%
    echo   可手动执行: call "%NPM_EXE%" install --registry https://registry.npmmirror.com
    pause
    exit /b 1
)

rem ==========================================================
rem  3. TypeScript 编译器就绪检查
rem ==========================================================
set "TSC_CMD=call "%NPX_EXE%" tsc"
if exist "node_modules\.bin\tsc.cmd" set "TSC_CMD=call "node_modules\.bin\tsc.cmd""

set "TS_VER="
for /f "tokens=*" %%i in ('%TSC_CMD% --version 2^>^&1') do set "TS_VER=%%i"
if not defined TS_VER (
    echo   [错误] TypeScript 编译器不可用
    echo   可手动执行: call "%NPM_EXE%" install typescript --save-dev
    pause
    exit /b 1
)
echo   + %TS_VER%

rem ==========================================================
rem  4. 编译 TypeScript
rem ==========================================================
echo   编译 TypeScript...
set "TSCLOG=%TEMP%\tianyan-tsc.log"
%TSC_CMD% >"%TSCLOG%" 2>&1
if errorlevel 1 (
    echo   [错误] 编译失败，TypeScript 报错如下:
    type "%TSCLOG%"
    echo   手动复现: %TSC_CMD%
    pause
    exit /b 1
)
if not exist "dist\index.js" (
    echo   [错误] 编译未产出 dist\index.js
    echo   手动复现: %TSC_CMD%
    pause
    exit /b 1
)
echo   + 编译完成

rem ==========================================================
rem  5. Playwright Chromium (可选，失败自动降级)
rem ==========================================================
if not exist "%USERPROFILE%\.cache\ms-playwright" (
    echo   安装 Playwright Chromium（约百 MB，失败不影响启动）...
    call "%NPX_EXE%" playwright install chromium >nul 2>&1
    if errorlevel 1 (
        echo   官方源不通，改用 npmmirror 镜像重试...
        set "PLAYWRIGHT_DOWNLOAD_HOST=https://cdn.npmmirror.com/binaries/playwright"
        call "%NPX_EXE%" playwright install chromium >nul 2>&1
    )
    if errorlevel 1 echo   [i] Playwright 安装失败，抓取功能自动降级
    if not errorlevel 1 echo   + Playwright Chromium 就绪
)

rem ==========================================================
rem  6. Python 侧车 Scrapling (可选，失败自动降级)
rem ==========================================================
set "pycmd="
set "pv="
for %%P in (python3 python) do (
    if not defined pycmd (
        %%P --version >nul 2>&1
        if not errorlevel 1 (
            set "pma=0"
            set "pmi=0"
            for /f "tokens=1,2" %%a in ('%%P -c "import sys;print(sys.version_info[0], sys.version_info[1])" 2^>^&1') do (
                set /a pma=%%a
                set /a pmi=%%b
                set "pv=%%a.%%b"
            )
            if !pma! gtr 3 set "pycmd=%%P"
            if !pma! equ 3 if !pmi! geq 10 set "pycmd=%%P"
        )
    )
)
if defined pycmd (
    echo   + Python !pv!，检查 Scrapling 抓取侧车...
    rem 每次都跑 installer: 它内部用 import scrapling 做真实校验 (marker 只做加速),
    rem 已装好时秒退; 包丢了会自动重装。旧逻辑只看 marker 是否存在,
    rem 一旦 marker 在、包不在, 就静默跳过 → 用户看到的就是"抓取压根没启用"。
    "%NODE_EXE%" scripts/install-scrapling.js
) else (
    echo   [i] 未检测到 Python 3.10+，Scrapling 侧车不可用，抓取自动降级
    echo   需要时安装: python.org 下载 3.10~3.13，安装时勾选 Add to PATH
)

rem ==========================================================
rem  7. 启动
rem ==========================================================
echo.
call "%NODE_EXE%" bin\tianyan.js
pause
