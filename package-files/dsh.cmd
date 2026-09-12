@echo off
rem DeepSeek Harness command line helper.
rem Usage: dsh.cmd [start^|stop^|restart^|status^|open^|logs^|console]
chcp 65001 > nul
setlocal
set "NODE=%~dp0runtime\node\node.exe"
if not exist "%NODE%" set "NODE=node"
"%NODE%" "%~dp0bin\dsh-app.mjs" %*
exit /b %ERRORLEVEL%
