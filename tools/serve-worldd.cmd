@echo off
rem Supervisor for worldd. Two jobs:
rem   1. keep it up, and
rem   2. record *why* it went away - a node process that disappears with no stack in the log is
rem      otherwise unanswerable. The launch/exit lines below timestamp every death and its code.
rem      (worldd itself also prints a 60 s heartbeat and an exit line; see server/worldd.mjs.)
rem Usage: tools\serve-worldd.cmd            (port 8765, all interfaces)
rem        tools\serve-worldd.cmd 8766      (different port)
setlocal enabledelayedexpansion
set PORT=%1
if "%PORT%"=="" set PORT=8765
cd /d "%~dp0.."
:loop
echo ==== launch port %PORT% at %DATE% %TIME% ==== >> build\worldd.log
node server\worldd.mjs --port %PORT% >> build\worldd.log 2>&1
echo ==== node exited code %ERRORLEVEL% at %DATE% %TIME% ==== >> build\worldd.log
echo (restart in 3 s; close this window to stop for good)
timeout /t 3 /nobreak >nul
goto loop
