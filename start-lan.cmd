@echo off
title MultiAgent (LAN)
cd /d "%~dp0"
rem 对外开放：同网段设备用 http://<本机IP>:3400/?token=<令牌> 打开。
rem 这个界面能建任务、能跑本地命令，所以对外监听时所有非回环请求都要令牌。
rem 令牌在启动后打印在本窗口里，也存于 .data\hub.token（可用 MA_TOKEN 覆盖）。
rem 本机 http://127.0.0.1:3400 免令牌；只在可信网络里这么开。
set MA_HOST=0.0.0.0
node --disable-warning=ExperimentalWarning src\host\server.ts
pause
