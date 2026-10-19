@echo off
setlocal
set "OUT=%~dp0verify-output.txt"
if exist "%OUT%" del /f /q "%OUT%"

echo === Tianyan verify start === >> "%OUT%"
echo. >> "%OUT%"

echo [1/4] node.exe location: >> "%OUT%"
where node >> "%OUT%" 2>&1
echo. >> "%OUT%"

echo [2/4] tsc via node.exe directly: >> "%OUT%"
"C:\Program Files\nodejs\node.exe" "%~dp0node_modules\typescript\bin\tsc" --version >> "%OUT%" 2>&1
echo. >> "%OUT%"

echo [3/4] tianyan.bat --no-start full output: >> "%OUT%"
call "%~dp0tianyan.bat" --no-start >> "%OUT%" 2>&1
echo. >> "%OUT%"

echo [4/4] build artifact check: >> "%OUT%"
if exist "%~dp0dist\index.js" (
    echo     dist\index.js EXISTS >> "%OUT%"
) else (
    echo     dist\index.js MISSING >> "%OUT%"
)
echo. >> "%OUT%"

echo === verify done, result in %OUT% ===
pause
notepad "%OUT%"
