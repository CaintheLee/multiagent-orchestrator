# 待办与优先级

> 最后更新：2026-11-21
> 只记「已经决定要做、但还没做」的事。做完就删，历史看 git。

## P0

| # | 事项 | 状态 | 说明 |
|---|---|---|---|
| 1 | **上线 GitHub（初级版）** | ✅ 已完成（2026-11-21） | https://github.com/CaintheLee/multiagent-orchestrator —— 138 文件、单提交 `7f69898`、MIT、Public。<br>发布方式：`node scripts/publish-public.mjs --git` 生成 `dist-public/` 再推；本地仓库历史保持私有 |
| 2 | **轮次摘要落 SQLite** | **搁置，等触发** | 现在 `runs` 的 summary/artifacts 只存在 json 文件里，接口每次按需读。<br>**触发条件**：单任务轮次 > 100，或 `/api/tasks/:id` p95 > 20ms。<br>**届时做法**：加 nullable 列 → 回填并逐条比对 → `finishRun` 双写 → 读路径切表但保留「表空回落读文件」 → 稳定一周后移除文件读。<br>**依据**：当前 47 任务 / 196 轮，最大单任务 64 轮，平均 4.2 轮，每轮 4.5KB；加缓存后 1.4ms，感知不到。 |

## P1

| # | 事项 | 状态 | 说明 |
|---|---|---|---|
| 3 | 接入 `tsc --noEmit` | ✅ 已完成（2026-11-21） | `typescript@5.9` + `@types/node@22`；`tsconfig.json` 开 `strictNullChecks` + `erasableSyntaxOnly`。**源码层 0 错误**，测试层修了 16 处陈旧字面量。<br>`npm run typecheck` / `npm run verify` 已接；反向验证过：注入未定义标识符立刻报 TS2304。 |
| 4 | 拆 `server.ts`：只拆 `chat` + `artifact` | 待做（1.5 天） | 让这两组路由能在不监听端口的情况下被测试，覆盖鉴权门、CSP、nodeId 校验。`createRouter(ctx)` + `ctx` 注入，`server.ts` 只留 bootstrap。其余路由按需再搬（strangler），不搞大爆炸。 |
| 8 | **暂停 / 恢复任务** | 待设计 | 需求已确认要做。技术现实：CLI 是一次性进程，Windows 没有可靠的「挂起整棵进程树」方案。<br>**待定语义**：①真挂起（NtSuspendProcess，风险高）②「停止即快照，恢复=续跑」（推荐，复用现有续跑链） |
| 9 | **微信通知** | 待接 | 需求已确认（站内 + 微信）。个人微信无官方发消息接口，可选：企业微信群机器人 webhook / 公众号测试号模板消息 / Server酱类服务。<br>**需要你提供一种通道的凭据**（webhook URL 或 key） |
| 10 | **四家 provider 全支持** | 待做 | codex / codebuddy / claude / gemini。要做：真实参数差异、只读能力矩阵、模型列表探测（现在只有 codebuddy 能自动探测） |
| 11 | **独立归档区** | 待做 | 产物除了留 `.sandbox`，再复制到独立归档区（待定路径，建议 `archive\<yyyy-mm>\<taskId>\` + `manifest.json`），保证任务历史可长期查 |
| 12 | **预算可配（token / 时长）** | ✅ 已完成 | 超限停在**轮次边界**转 `blocked`（不是中途杀进程），已交付产物保留、加预算可续跑。0 = 不限。回归用例覆盖「超限熔断」与「0 不误伤」。 |
| 13 | **阶段上限 8 → 10** | ✅ 已完成 | `PLAN_LIMIT = 10`；提示词改「2–10 段」；回归用例从 8 段扩到 10 段，仍 `done`。 |
| 14 | **并发可配** | ✅ 已完成 | 新增 `[limits]` 段（`concurrency` / `max_tokens` / `max_minutes`）+ `GET/POST /api/limits` + 主控面板「运行上限」。优先级：`MA_CONCURRENCY` > 配置 > 3。改并发要重启，接口返回 `restartRequired`，界面会提示。 |

## P2

| # | 事项 | 说明 |
|---|---|---|
| 5 | `strict: true` 评估 | 等 P1-3 清零后再看，先开 `noImplicitAny` |
| 6 | 轮询间隔自适应 | 界面每 4 秒全量刷新；没有在跑的任务时可以降到 10 秒 |
| 7 | 拆剩余 18 个路由 | 等 3/4 都稳定、且 HTTP 测试铺开之后再动 |
| 15 | 永久存档 + 手动删除入口 | 已定：默认永久保留，不做自动清理；提供「选择任务 → 删除」的显式操作（删除不可逆，需二次确认） |

## 已知不做

| 事项 | 原因 |
|---|---|
| 用户体系 / 多租户 | 单机工具，一把令牌够用；要多人就在前面挂反代 |
| 前端框架化 | 单文件 HTML 已经能维护，引入构建链的代价大于收益 |
| 自动清理 `.sandbox` | 已改为「永久保留 + 手动删除入口」（见 P2-15）。自动删证据类文件不可接受 |
