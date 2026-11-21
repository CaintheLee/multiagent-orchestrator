# 待办与优先级

> 最后更新：2026-11-21 夜
> 只记「已经决定要做、但还没做」的事。做完的移到文末「已交付」，历史看 git。

## P0

| # | 事项 | 状态 | 说明 |
|---|---|---|---|
| 2 | **轮次摘要落 SQLite** | **搁置，等触发** | 现在 `runs` 的 summary/artifacts 只存在 json 文件里，接口按需读。<br>**触发条件**：单任务轮次 > 100，或 `/api/tasks/:id` p95 > 20ms。<br>**届时做法**：加 nullable 列 → 回填并逐条比对 → `finishRun` 双写 → 读路径切表但保留「表空回落读文件」 → 稳定一周后移除文件读。<br>**依据**：47 任务 / 196 轮，最大单任务 64 轮，平均 4.2 轮，每轮 4.5KB；加缓存后 1.4ms。 |

## P1

| # | 事项 | 状态 | 说明 |
|---|---|---|---|
| 5 | `strict: true` 评估 | 待做 | 现在开了 `strictNullChecks`，其余严格项还关着。下一步先开 `noImplicitAny`，看能冒出多少真实问题 |

## P2

| # | 事项 | 说明 |
|---|---|---|
| 6 | 轮询间隔自适应 | 界面每 4 秒全量刷新；没有在跑的任务时可以降到 10 秒 |
| 7 | 拆剩余 18 个路由 | chat + artifact 已拆（见已交付）；其余按「改到哪组搬哪组」推进，不搞一次搬完 |

## 已知不做

| 事项 | 原因 |
|---|---|
| 用户体系 / 多租户 | 单机工具，一把令牌够用；要多人就在前面挂反代 |
| 前端框架化 | 单文件 HTML 已经能维护，引入构建链的代价大于收益 |
| 自动清理 `.sandbox` | 「永久保留 + 手动删除入口」。自动删证据类文件不可接受 |
| 审计导出包 | 外部审计给文档 + 可复现命令就够（P2-17） |

---

## 已交付（2026-11-21）

按需求决策的编号列，方便对照 `REQUIREMENTS.md` 第 10 节。

| 编号 | 事项 | 落点 |
|---|---|---|
| P0-1 | 访问令牌（LAN 强制、回环免） | `kernel/auth.ts`、`docs/SECURITY.md` |
| P0-3 | 公开仓库 + 脱敏 + MIT | `scripts/publish-public.mjs`、`LICENSE` |
| P0-4 | 对话可写 + 每次写前确认 | `host/chat.ts` 的 `ma-edit-plan` + `routes/chat.ts` 的 `parseGrant`；授权那一轮才切 `acceptEdits` |
| P0-5 | 高风险动作需人签 | `kernel/risk.ts`；任务命中风险先建为 `blocked`，`/api/tasks/:id/approve-risk` 放行 |
| P0-10 | 任务输入模板 | `ui/index.html` 的 `TASK_TPL`（清点/梳理/改码/审计四套五要素模板） |
| P0-11 | 独立归档区 + manifest | `kernel/archive.ts` → `.data/archive/<yyyy-mm>/t<id>/`，含 sha256、missing、上限（500 个 / 500MB） |
| P0-22 | `verify` 双入口 | `npm test`（快）、`npm run verify`（typecheck + test） |
| P1-6 | 暂停 / 恢复 | 语义 B：`POST /api/tasks/:id/pause` 存快照，恢复走续跑链；`paused` 与 `canceled` 分开记 |
| P1-7 | 失败后主控诊断 | `kernel/diagnose.ts`；`failed` 后多跑一轮复盘，结果落 `.data/diagnosis/<id>.md`，`/api/tasks/:id` 返回 `diagnosis` |
| P1-8 | 站内 + 微信通知 | `kernel/notify.ts` + `[notify]` 段；按 webhook 地址自动适配企业微信 / Server酱 / PushPlus / 通用 JSON；站内由前端轮询比对状态 |
| P1-9 | 四家 provider | `adapters/table.ts`：codex（真只读）/ codebuddy（已实测）/ claude / gemini；后两家标 `verified: false`，doctor 会显示 |
| P1-12 | 换项目留档 | `npm run switch-project`：memory + chat 移到 `.data/archive/<项目>-<日期>/`，`context.md` 重置为空模板，`prompts/` 不动 |
| P1-13 | 阶段上限 8 → 10 | `PLAN_LIMIT = 10`，提示词与回归用例同步 |
| P1-14 | 预算可配 | `[limits] max_tokens / max_minutes`；超限停在轮次边界转 `blocked`，可续跑 |
| P1-15 | 并发可配 | `[limits] concurrency` + `/api/limits` + 界面「运行上限」；改并发要重启，接口返回 `restartRequired` |
| P1-23 | 拆 chat + artifact 路由 | `host/routes/chat.ts`、`host/routes/artifact.ts`；补 9 条 HTTP 层用例（越界 403 / CSP / nodeId 穿越 / 授权校验） |
| P1-24 | 先上初级版 | GitHub 已上线，后续 update 增量推 |
| P2-16 | 永久存档 + 手动删除 | 不自动清理；`DELETE /api/tasks/:id`（默认保留产物，`?purge=1` 连工作区一起删），界面二次确认输入任务号 |
| — | `tsc --noEmit` | `tsconfig.json` + `npm run typecheck`；源码 0 错误 |
| — | 交付清单解析修复 | 空行不再截断、`【1】` 不算段尾、带空格路径不再被截断 |
| — | `access` 归一化 | 配置写错时留痕并按 write 处理，不再静默 |
| — | 提示词保存并发 | 临时文件名带 pid + 随机后缀 |
