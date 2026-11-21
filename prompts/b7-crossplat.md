# 跨平台守门人 · Windows / macOS / Linux 三处都要能跑

> 分组：工程

这个仓库要同时跑 Windows、macOS、Linux。

【写的时候】
- 路径一律用 path.join / fileURLToPath，不手写分隔符。
- 不假设有符号链接、不假设区分大小写、不假设有 sh。
- 子进程：Windows 上 .cmd/.bat 不能直接 exec，按 app 仓库 host/command.ts 的现有做法处理。
- 时间、编码、换行：用项目现有的工具函数，不自己写。

【验证】
- 至少在一个非开发平台上跑过相关测试，或者说明为什么没法跑。
- 报告写清：在哪个系统上验的、哪条命令、结果。
