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

rem Pin the runtime. PATH here can resolve to a per-tool node shim (pi-node\current) that gets
rem replaced under us; when its DLLs go away node.exe dies with 0xC0000135 (DLL not found) before
rem running a line of our code, which is exactly what build\worldd.log recorded 108 times on 11/05.
set NODE=%NODE%
if "!NODE!"=="" set "NODE=C:\Program Files\nodejs\node.exe"
if not exist "!NODE!" set NODE=node
echo ==== supervisor: runtime "!NODE!" at %DATE% %TIME% ==== >> build\worldd.log

set STUCK=0
:loop
echo ==== launch port %PORT% at %DATE% %TIME% ==== >> build\worldd.log
"!NODE!" server\worldd.mjs --port %PORT% >> build\worldd.log 2>&1
set CODE=%ERRORLEVEL%
echo ==== node exited code %CODE% at %DATE% %TIME% ==== >> build\worldd.log

rem A Windows loader death (DLL missing, bad exe, quick abort) is not a crash in worldd: the process
rem never started. Re-launching it 50 times a second buries the log and steals CPU, so stop.
if %CODE%==-1073741205 set /a STUCK+=1
if %CODE%==-1073741701 set /a STUCK+=1
if %CODE%==1 set /a STUCK+=1
if not %STUCK% LSS 5 goto stuck
set STUCK=0

rem Sleep without a console. `timeout /t` errors out when stdin is not a console ("Input redirection
rem is not supported") and returns at once, so the old 3 s pause was really 20 ms.
ping /n 4 127.0.0.1 >nul
goto loop

:stuck
echo ==== giving up: %STUCK% exits in a row never reached our code (loader/PATH problem). ==== >> build\worldd.log
echo ==== check: "C:\Program Files\nodejs\node.exe" -v   or set NODE= to override. ==== >> build\worldd.log
exit /b 1
