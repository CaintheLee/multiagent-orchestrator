@echo off
title MultiAgent
cd /d "%~dp0"
rem keep a read-only copy on the Desktop in sync
copy /y "ui\index.html" "%USERPROFILE%\Desktop\MultiAgent.html" >nul 2>&1
node --disable-warning=ExperimentalWarning src\host\server.ts
pause
