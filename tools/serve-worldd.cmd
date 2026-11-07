@echo off
rem Supervisor for worldd. Two jobs:
rem   1. keep it up, and
rem   2. record *why* it went away - a node process that disappears with no stack in the log is
rem      otherwise unanswerable. The launch/exit lines below timestamp every death and its code.
rem      (worldd itself also prints a 60 s heartbeat and an exit line; see server/worldd.mjs.)
rem Usage: tools\serve-worldd.cmd            (port 8765, all interfaces, pinned runtime)
rem        tools\serve-worldd.cmd 8766      (different port)
rem        tools\serve-worldd.cmd 8765 "C:\other\node.exe"   (override the runtime on purpose)
setlocal enabledelayedexpansion
set PORT=%1
if "%PORT%"=="" set PORT=8765
set NODE2=%~2
cd /d "%~dp0.."

rem Pin the runtime. PATH here can resolve to a per-tool node shim (pi-node\current) that gets
rem replaced under us; when its DLLs go away node.exe dies with 0xC0000135 (DLL not found) before
rem running a line of our code, which is exactly what build\worldd.log recorded 108 times on 11/05.
rem
rem An inherited NODE env var must NOT decide this. A supervisor started from an agent shell
rem inherits that shell's NODE (its own runtime), and that shim is exactly the thing that gets
rem replaced under us - the 11/07 worldd wedge ran on pi-node for exactly that reason. Only an
rem explicit second argument may override the pin:  tools\serve-worldd.cmd 8765 "C:\path\to\node.exe"
set NODE=!NODE2!
if "!NODE!"=="" set "NODE=C:\Program Files\nodejs\node.exe"
if not exist "!NODE!" (
  echo ==== supervisor: refused to start - no runtime at "!NODE!" ==== >> build\worldd.log
  echo supervisor: no runtime at "!NODE!" - pass one as the second argument. & exit /b 1
)
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
