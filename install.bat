@echo off
cd /d "%~dp0"

rem ----------------------------------------------------------
rem  Tianyan - install / repair environment
rem  All detection and auto-install logic lives in tianyan.bat so
rem  there is exactly one place to maintain. This file just calls it
rem  with --no-start. The old version bailed out when "where node"
rem  failed, which was one of the reasons the launcher never started.
rem ----------------------------------------------------------
call "%~dp0tianyan.bat" --no-start
exit /b %errorlevel%
