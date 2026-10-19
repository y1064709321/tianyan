@echo off
setlocal EnableDelayedExpansion

set "DIR=%~dp0"
cd /d "%DIR%"

rem Portable runtime lives inside the project. No admin rights required.
set "RUNTIME=%DIR%.runtime"
set "NODE_WANT=22.23.3"
set "PY_WANT=3.12.10"
set "NODE_MIN=22"
set "DLDIR=%TEMP%\tianyan-dl"
set "NPMLOG=%TEMP%\tianyan-npm-install.log"
if not exist "%DLDIR%" mkdir "%DLDIR%" >nul 2>&1

rem --no-start: detect and install everything, do not launch.
set "NO_START=0"
set "APP_ARGS="
:ParseArgs
if "%~1"=="" goto :ArgsDone
if /i "%~1"=="--no-start" (
    set "NO_START=1"
) else (
    set "APP_ARGS=!APP_ARGS! %1"
)
shift
goto :ParseArgs
:ArgsDone

echo.
echo   Tianyan Launcher
echo   ============================================
echo.

rem ----------------------------------------------------------
rem  1. Detect Node.js / npm / Python, install what is missing
rem ----------------------------------------------------------
echo   [environment]
echo   --------------------------------------------

call :FindNode
if not defined NODE_EXE (
    echo   Node.js    not found - downloading portable build...
    call :InstallNode
    call :FindNode
    if not defined NODE_EXE goto :NeedNodeFail
)
call :NodeVersionOk
if "!NODE_OK!"=="0" (
    echo   Node.js    !NODE_VER! too old ^(need ^>= %NODE_MIN%^), installing portable build...
    call :InstallNode
    call :FindNode
    if not defined NODE_EXE goto :NeedNodeFail
    call :NodeVersionOk
)
if not defined NODE_EXE goto :NeedNodeFail

echo   Node.js    !NODE_VER!  OK
call :NpmVersion
if not defined NPM_VER (
    echo   npm        missing - installing full portable build...
    call :InstallNode
    call :FindNode
    call :NpmVersion
)
if not defined NPM_VER goto :NeedNpmFail
echo   npm        !NPM_VER!  OK

rem PATH injection as fallback for shims spawned by tianyan.js
if defined NODE_DIR set "PATH=!NODE_DIR!;!PATH!"
call :MakeNpmCmd

call :FindPython
if not defined PY_EXE (
    echo   Python     not found - installing...
    call :InstallPython
    call :FindPython
)
if defined PY_EXE (
    echo   Python     !PY_VER!  OK
) else (
    echo   Python     not available - scraping sidecar will degrade ^(launch continues^)
)

echo   --------------------------------------------
echo.

goto :CheckDeps

:NeedNodeFail
echo.
echo   [ERROR] Node.js install failed
echo   Install Node.js 22 LTS manually and retry:
echo     https://nodejs.org/en/download
echo   China mirror:
echo     https://registry.npmmirror.com/-/binary/node/v%NODE_WANT%/
pause
exit /b 1

:NeedNpmFail
echo.
echo   [ERROR] Node.js found but npm is missing
echo   This means the Node.js install is incomplete ^(e.g. only node.exe was unpacked^)
echo   Reinstall full Node.js 22 LTS: https://nodejs.org/en/download
echo   Or remove the .runtime folder and run start.bat again
pause
exit /b 1

rem ----------------------------------------------------------
rem  2. Dependency check + multi-mirror install (stop on first OK)
rem ----------------------------------------------------------
:CheckDeps
set "N1=npmmirror"      & set "M1=https://registry.npmmirror.com"
set "N2=huaweicloud"    & set "M2=https://repo.huaweicloud.com/repository/npm/"
set "N3=tencent"        & set "M3=https://mirrors.cloud.tencent.com/npm/"
set "N4=tsinghua"       & set "M4=https://mirrors.tuna.tsinghua.edu.cn/npm/"
set "N5=npmjs official" & set "M5=https://registry.npmjs.org"

call :MakeNpmCmd

set "DEPS_OK=0"
call :DepsCheck

if !DEPS_OK! equ 0 (
    echo   dependencies missing, trying mirrors in order ^(stop on first success^)
    echo   npm progress is shown below - a slow mirror is NOT a freeze.
    echo.
    for /L %%i in (1,1,5) do (
        if !DEPS_OK! equ 0 (
            echo   [%%i/5] fetching from !N%%i! ...
            rem --ignore-scripts: better-sqlite3 ships prebuilt binaries, so no node-gyp
            rem compile is needed; this avoids requiring VS C++ build tools.
            rem Output is TEE'd: visible in the console AND saved to the log file.
            call !NPM_CMD! install --ignore-scripts --registry "!M%%i!" --fetch-timeout 300000 --fetch-retries 2 --no-audit --no-fund 2>&1 | powershell -NoProfile -Command "$input | Tee-Object -FilePath '%NPMLOG%'"
            call :DepsCheck
            if !DEPS_OK! equ 1 (
                echo   + dependencies installed from !N%%i!
            ) else (
                echo   x !N%%i! failed, cleaning up and trying next mirror
                if exist "node_modules" rmdir /s /q "node_modules" 2>nul
                if not %%i==5 timeout /t 3 /nobreak >nul
            )
        )
    )
)

if !DEPS_OK! equ 0 (
    echo   [ERROR] all 5 mirrors failed
    echo   ---- real npm error ^(last 30 lines^) ----
    powershell -NoProfile -ExecutionPolicy Bypass -Command "if(Test-Path '%NPMLOG%'){Get-Content -LiteralPath '%NPMLOG%' -Tail 30}" 2>nul
    if errorlevel 1 type "%NPMLOG%" 2>nul
    echo   ----------------------------------------
    echo   full log: %NPMLOG%
    echo   manual retry: call !NPM_CMD! install --registry https://registry.npmmirror.com
    pause
    exit /b 1
)

rem ----------------------------------------------------------
rem  3. TypeScript compiler check
rem     Run typescript\bin\tsc through node.exe directly so PATH is irrelevant
rem ----------------------------------------------------------
set "TSC_JS=%DIR%node_modules\typescript\bin\tsc"
if not exist "%TSC_JS%" (
    echo   [ERROR] TypeScript compiler missing ^(node_modules\typescript\bin\tsc not found^)
    echo   manual fix: call !NPM_CMD! install typescript --save-dev
    pause
    exit /b 1
)

set "TS_VER="
set "VER_TMP=%TEMP%\tianyan-tsver.txt"
del /f /q "!VER_TMP!" >nul 2>&1
"%NODE_EXE%" "%TSC_JS%" --version >"!VER_TMP!" 2>&1
if exist "!VER_TMP!" for /f "usebackq tokens=1,2" %%a in ("!VER_TMP!") do set "TS_VER=%%b"
del /f /q "!VER_TMP!" >nul 2>&1
if not defined TS_VER (
    echo   [ERROR] TypeScript compiler cannot run
    echo   manual check: "%NODE_EXE%" "%TSC_JS%" --version
    pause
    exit /b 1
)
echo   TypeScript %TS_VER%  OK

rem ----------------------------------------------------------
rem  4. Compile TypeScript
rem ----------------------------------------------------------
echo   compiling TypeScript...
set "TSCLOG=%TEMP%\tianyan-tsc.log"
"%NODE_EXE%" "%TSC_JS%" >"%TSCLOG%" 2>&1
if errorlevel 1 (
    echo   [ERROR] compile failed, TypeScript output:
    type "%TSCLOG%"
    echo   manual retry: "%NODE_EXE%" "%TSC_JS%"
    pause
    exit /b 1
)
if not exist "dist\index.js" (
    echo   [ERROR] compile produced no dist\index.js
    echo   manual retry: "%NODE_EXE%" "%TSC_JS%"
    pause
    exit /b 1
)
echo   + build done

if "!NO_START!"=="1" (
    echo.
    echo   + environment ready ^(--no-start, not launching^)
    exit /b 0
)

rem ----------------------------------------------------------
rem  5. Playwright Chromium (optional, degrade on failure)
rem     Run playwright\cli.js through node.exe directly, no npx shim
rem ----------------------------------------------------------
set "PW_BIN="
call :PlaywrightPath
if defined PW_BIN if exist "!PW_BIN!" (
    echo   + Playwright Chromium ready
) else (
    echo.
    echo   ============================================================
    echo    Installing Playwright Chromium ^(~100 MB, optional^)
    echo    Download progress is shown below. This may take 1-5 minutes
    echo    on a slow connection. No progress bar = still downloading,
    echo    NOT frozen. To skip it, close this window and use the app
    echo    WITHOUT browser scraping ^(everything else works fine^).
    echo   ============================================================
    echo.
    set "PLAY_CLI=%DIR%node_modules\playwright\cli.js"
    if exist "%PLAY_CLI%" (
        "%NODE_EXE%" "%PLAY_CLI%" install chromium
    ) else (
        call !NPM_CMD! exec -- playwright install chromium
    )
    if errorlevel 1 (
        echo.
        echo   official host unreachable, retrying via npmmirror mirror...
        echo.
        set "PLAYWRIGHT_DOWNLOAD_HOST=https://cdn.npmmirror.com/binaries/playwright"
        if exist "%PLAY_CLI%" (
            "%NODE_EXE%" "%PLAY_CLI%" install chromium
        ) else (
            call !NPM_CMD! exec -- playwright install chromium
        )
    )
    echo.
    set "PW_BIN="
    call :PlaywrightPath
    if defined PW_BIN if exist "!PW_BIN!" (
        echo   + Playwright Chromium ready
    ) else (
        echo   [i] Playwright install failed, browser scraping will degrade
        echo       ^(the app still starts normally - just no real-browser scraping^)
    )
)

rem ----------------------------------------------------------
rem  6. Python sidecar: Scrapling (optional, degrade on failure)
rem ----------------------------------------------------------
if defined PY_EXE (
    echo   + Python !PY_VER! - checking Scrapling sidecar...
    rem Always run the installer: it verifies with a real import, so it
    rem exits instantly when healthy and reinstalls when packages are gone.
    set "TIANYAN_SCRAPLING_PY=!PY_EXE!"
    "%NODE_EXE%" scripts/install-scrapling.js
) else (
    echo   [i] Python 3.10+ not available, Scrapling sidecar disabled
    echo   install from python.org ^(3.10-3.13^) with "Add to PATH" checked
)

rem ----------------------------------------------------------
rem  7. Launch
rem ----------------------------------------------------------
echo.
call "%NODE_EXE%" bin\tianyan.js!APP_ARGS!
pause
exit /b 0

rem ----------------------------------------------------------
rem  Subroutines
rem ----------------------------------------------------------

:DepsCheck
set "DEPS_OK=0"
if exist "node_modules\typescript\package.json" (
    "%NODE_EXE%" --input-type=commonjs -e "require('typescript');try{require('better-sqlite3')}catch(e){process.exit(1)}" >nul 2>&1
    if not errorlevel 1 set "DEPS_OK=1"
)
goto :eof

:MakeNpmCmd
rem Prefer node.exe + npm-cli.js (no PATH dependency), fall back to npm.cmd
set "NPM_CLI=%NODE_DIR%\node_modules\npm\bin\npm-cli.js"
if not exist "%NPM_CLI%" set "NPM_CLI="
if defined NPM_CLI (
    set "NPM_CMD="%NODE_EXE%" "!NPM_CLI!""
) else (
    set "NPM_CMD="!NPM_EXE!""
)
goto :eof

:NodeVersionOk
set "NODE_OK=0"
if not defined NODE_VER goto :eof
set "NODE_MAJOR=!NODE_VER:v=!"
for /f "tokens=1 delims=." %%a in ("!NODE_MAJOR!") do set "NODE_MAJOR=%%a"
if !NODE_MAJOR! geq %NODE_MIN% set "NODE_OK=1"
goto :eof

:FindNode
set "NODE_EXE="
set "NPM_EXE="
set "NPX_EXE="
set "NODE_DIR="
set "NODE_VER="

rem (1) portable runtime bundled in the project
if exist "%RUNTIME%\node\node.exe" (
    set "NODE_EXE=%RUNTIME%\node\node.exe"
    set "NODE_DIR=%RUNTIME%\node"
    goto :FindNode_Resolve
)

rem (2) PATH
for /f "delims=" %%i in ('where node 2^>nul') do (
    if not defined NODE_EXE (
        set "NODE_EXE=%%i"
        for %%d in ("%%i") do set "NODE_DIR=%%~dpd"
    )
)

rem (3) common install locations (official installer / fnm / nvm-windows)
if not defined NODE_EXE (
    for %%D in (
        "%LOCALAPPDATA%\Programs\nodejs"
        "C:\Program Files\nodejs"
        "C:\Program Files (x86)\nodejs"
        "%LOCALAPPDATA%\fnm\node-alias"
        "%APPDATA%\nvm"
        "%NVM_HOME%"
    ) do (
        if not defined NODE_EXE if exist "%%~D\node.exe" (
            set "NODE_EXE=%%~D\node.exe"
            set "NODE_DIR=%%~D"
        )
    )
)
if not defined NODE_EXE if defined NVM_SYMLINK if exist "%NVM_SYMLINK%\node.exe" (
    set "NODE_EXE=%NVM_SYMLINK%\node.exe"
    set "NODE_DIR=%NVM_SYMLINK%"
)

:FindNode_Resolve
if defined NODE_DIR if "!NODE_DIR:~-1!"=="\" set "NODE_DIR=!NODE_DIR:~0,-1!"
if defined NODE_DIR (
    if exist "!NODE_DIR!\npm.cmd" set "NPM_EXE=!NODE_DIR!\npm.cmd"
    if exist "!NODE_DIR!\npx.cmd" set "NPX_EXE=!NODE_DIR!\npx.cmd"
)
if defined NODE_EXE (
    rem Redirect to a file and read it back: a for /f with nested quotes lets
    rem cmd swallow the inner quotes and treat error text as a version number.
    set "VER_TMP=%TEMP%\tianyan-ver.txt"
    del /f /q "!VER_TMP!" >nul 2>&1
    "%NODE_EXE%" -v >"!VER_TMP!" 2>nul
    if exist "!VER_TMP!" for /f "usebackq delims=" %%v in ("!VER_TMP!") do set "NODE_VER=%%v"
    del /f /q "!VER_TMP!" >nul 2>&1
)
rem No version reported means this node.exe cannot run: treat as not installed
if not defined NODE_VER (
    set "NODE_EXE="
    set "NPM_EXE="
    set "NODE_DIR="
)
goto :eof

:InstallNode
set "ARCH=x64"
if /i "%PROCESSOR_ARCHITECTURE%"=="ARM64" set "ARCH=arm64"
if /i "%PROCESSOR_ARCHITECTURE%"=="x86" set "ARCH=x86"

set "ZIPNAME=node-v%NODE_WANT%-win-%ARCH%.zip"
set "ZIP=%DLDIR%\%ZIPNAME%"
if exist "%ZIP%" del /f /q "%ZIP%" >nul 2>&1

set "GOT=0"
for %%U in (
    "https://registry.npmmirror.com/-/binary/node/v%NODE_WANT%/%ZIPNAME%"
    "https://mirrors.huaweicloud.com/nodejs/v%NODE_WANT%/%ZIPNAME%"
    "https://nodejs.org/dist/v%NODE_WANT%/%ZIPNAME%"
) do (
    if !GOT! equ 0 (
        echo     downloading %%~U
        call :Download "%%~U" "%ZIP%"
        if !GOT! equ 1 echo     + download complete
    )
)
if !GOT! equ 0 (
    echo     x every mirror failed
    goto :eof
)

echo     extracting to %RUNTIME%\node ...
if exist "%RUNTIME%\node" rmdir /s /q "%RUNTIME%\node" >nul 2>&1
if not exist "%RUNTIME%" mkdir "%RUNTIME%" >nul 2>&1

tar.exe -xf "%ZIP%" -C "%RUNTIME%" >nul 2>&1
if exist "%RUNTIME%\node-v%NODE_WANT%-win-%ARCH%" (
    move "%RUNTIME%\node-v%NODE_WANT%-win-%ARCH%" "%RUNTIME%\node" >nul 2>&1
)

if not exist "%RUNTIME%\node\node.exe" (
    echo     falling back to PowerShell extraction...
    powershell -NoProfile -ExecutionPolicy Bypass -Command "Expand-Archive -LiteralPath '%ZIP%' -DestinationPath '%RUNTIME%' -Force" >nul 2>&1
    if exist "%RUNTIME%\node-v%NODE_WANT%-win-%ARCH%" (
        move "%RUNTIME%\node-v%NODE_WANT%-win-%ARCH%" "%RUNTIME%\node" >nul 2>&1
    )
)

if exist "%RUNTIME%\node\node.exe" (
    echo     + portable Node.js ready
) else (
    echo     x extraction failed
)
goto :eof

:Download
rem %1=URL  %2=target file  sets GOT=1 on success
set "GOT=0"
where curl.exe >nul 2>&1
if not errorlevel 1 (
    curl.exe -fL --retry 2 --connect-timeout 20 --max-time 900 -o "%~2" %1 >nul 2>&1
) else (
    powershell -NoProfile -ExecutionPolicy Bypass -Command "try{Invoke-WebRequest -Uri '%~1' -OutFile '%~2' -UseBasicParsing}catch(e){exit 1}" >nul 2>&1
)
if exist "%~2" (
    for %%F in ("%~2") do if %%~zF GTR 1000000 set "GOT=1"
)
goto :eof

:PlaywrightPath
set "PW_BIN="
set "VER_TMP=%TEMP%\tianyan-pw.txt"
del /f /q "!VER_TMP!" >nul 2>&1
"%NODE_EXE%" --input-type=commonjs -e "try{console.log(require('playwright').chromium.executablePath())}catch(e){}" >"!VER_TMP!" 2>nul
if exist "!VER_TMP!" for /f "usebackq delims=" %%p in ("!VER_TMP!") do set "PW_BIN=%%p"
del /f /q "!VER_TMP!" >nul 2>&1
goto :eof

:NpmVersion
set "NPM_VER="
if not defined NPM_EXE goto :eof
set "VER_TMP=%TEMP%\tianyan-npmver.txt"
del /f /q "!VER_TMP!" >nul 2>&1
call "%NPM_EXE%" -v >"!VER_TMP!" 2>nul
if exist "!VER_TMP!" for /f "usebackq delims=" %%v in ("!VER_TMP!") do set "NPM_VER=%%v"
del /f /q "!VER_TMP!" >nul 2>&1
goto :eof

:FindPython
set "PY_EXE="
set "PY_VER="
set "PY_MAJOR=0"
set "PY_MINOR=0"

if exist "%RUNTIME%\python\python.exe" (
    set "PY_EXE=%RUNTIME%\python\python.exe"
    goto :FindPython_Verify
)
for /f "delims=" %%i in ('where python 2^>nul') do (
    if not defined PY_EXE set "PY_EXE=%%i"
)
if not defined PY_EXE (
    for /d %%D in ("%LOCALAPPDATA%\Programs\Python\Python3*") do (
        if not defined PY_EXE if exist "%%~D\python.exe" set "PY_EXE=%%~D\python.exe"
    )
)

:FindPython_Verify
if not defined PY_EXE goto :eof
set "VER_TMP=%TEMP%\tianyan-pyver.txt"
del /f /q "!VER_TMP!" >nul 2>&1
"%PY_EXE%" -c "import sys;print(sys.version_info[0],sys.version_info[1])" >"!VER_TMP!" 2>nul
if exist "!VER_TMP!" for /f "usebackq tokens=1,2" %%a in ("!VER_TMP!") do (
    set "PY_MAJOR=%%a"
    set "PY_MINOR=%%b"
    set "PY_VER=%%a.%%b"
)
del /f /q "!VER_TMP!" >nul 2>&1
rem Wrong version means unusable: Scrapling needs 3.10 or newer
if !PY_MAJOR! lss 3 set "PY_EXE="
if !PY_MAJOR! equ 3 if !PY_MINOR! lss 10 set "PY_EXE="
if not defined PY_EXE set "PY_VER="
goto :eof

:InstallPython
set "PYARCH=amd64"
if /i "%PROCESSOR_ARCHITECTURE%"=="ARM64" set "PYARCH=arm64"

set "PYNAME=python-%PY_WANT%-%PYARCH%.exe"
set "PYINST=%DLDIR%\%PYNAME%"
if exist "%PYINST%" del /f /q "%PYINST%" >nul 2>&1

set "GOT=0"
for %%U in (
    "https://registry.npmmirror.com/-/binary/python/%PY_WANT%/%PYNAME%"
    "https://mirrors.huaweicloud.com/python/%PY_WANT%/%PYNAME%"
    "https://www.python.org/ftp/python/%PY_WANT%/%PYNAME%"
) do (
    if !GOT! equ 0 (
        echo     downloading %%~U
        call :Download "%%~U" "%PYINST%"
        if !GOT! equ 1 echo     + download complete
    )
)
if !GOT! equ 0 (
    echo     x Python installer download failed, skipping ^(launch continues^)
    goto :eof
)

echo     silent install for current user ^(no admin rights needed^)...
start /wait "" "%PYINST%" /quiet InstallAllUsers=0 PrependPath=1 Include_pip=1 Include_test=0 Include_launcher=1
echo     + Python installer finished
goto :eof
