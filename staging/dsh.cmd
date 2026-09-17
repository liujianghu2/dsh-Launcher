@echo off
rem DeepSeek Harness command line helper.
rem Usage: dsh.cmd [start^|stop^|restart^|status^|data^|check^|update^|autostart^|open^|logs^|console]
rem
rem This file stays pure ASCII on purpose: cmd.exe parses a batch file in the
rem OEM code page, and non-ASCII bytes there can decode into characters such as
rem a pipe or an ampersand and split a line into bogus commands.
chcp 65001 > nul
setlocal
set "NODE=%~dp0runtime\node\node.exe"

rem A packaged install ships runtime\node-runtime.json and must use only the
rem runtime it carries: its dependencies are native builds for one exact Node
rem version, so falling back to whatever Node.js the machine happens to have is
rem what makes the same package work on one computer and fail on another.
rem A source install has no manifest and no bundled runtime, so it may use PATH.
if not exist "%~dp0runtime\node-runtime.json" goto use_path_node
if exist "%NODE%" goto run
echo.
echo [DeepSeek Harness] The bundled Node.js runtime is missing:
echo   %NODE%
echo The installation is incomplete or has been modified.
echo Re-run the installer to repair it, then try again.
echo.
exit /b 1

:use_path_node
if not exist "%NODE%" set "NODE=node"

:run
"%NODE%" "%~dp0bin\dsh-app.mjs" %*
exit /b %ERRORLEVEL%
