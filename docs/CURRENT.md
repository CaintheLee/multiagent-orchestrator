# 现状速览（CURRENT）

> 这份文档只写「现在是什么样」。历史审计看 [`history/`](./history/README.md)；
> 与代码不一致时以代码为准，并回来改这里。

## 一句话

本机多 agent 调度台：把一个任务交给主控，主控拆成子树派给本地 CLI agent，
逐级收口验收，产物落盘、状态入库，人可以在网页上看和干预。

## 怎么跑

```bash
npm run doctor   # 环境自检：provider 路径、role 文件、数据目录、端口
npm run serve    # 起 hub：http://127.0.0.1:3400
npm test         # 146 项单测（1 项 skip 是 Windows 软链权限）
npm run eval     # 15 项能力基线（不调模型、不花钱）
```

CLI：`run`（派任务，`--dry-run` 只打印提示词）、`status`、`check`（校验 agents.toml）、
`doctor`（环境自检）、`learn` / `lessons`（教训沉淀）。

## 结构

```
src/
├─ protocol/  schema / receipt / prompt / resume   回执协议与提示词
├─ kernel/    tree / settle / guard / memory / pool / lane / approval / snapshot
├─ adapters/  table / spawn                        本地 CLI 适配
├─ store/     db / runs / log / checkpoints / approvals / messages
├─ runner/    runTree / route / accept / spawn / report
├─ hub/       scheduler / logbus
└─ host/      server / cli / doctor
ui/index.html                                      单文件控制台（零构建）
```

`runner/` 的分工：`route` 决定这一轮派给谁（纯算术）、`spawn` 处理派生审批、
`accept` 是收口/补验的提示词、`report` 把交付整理成简报、`runTree` 只保留主循环与执行。

## 当前能力

- **树状派活**：主控写 `dispatch`，下级回执带 `artifacts / evidence / spawn / tell / question`
- **逐级收口**：验收目标默认是**整棵子树**累计的产物，不只是直接下级的最后一条记录
- **证据核验**：判 `pass` 必须给 ≥2 条从产物里逐字复制的片段，零 token 校验
- **派生审批**：模型只能申请开新线，人点头才生效；拒绝或超限 → 任务 `blocked`
- **点对点留言**：异步投递，不阻塞、不留死锁
- **断点续跑**：状态快照（`checkpoints` 表）+ 413 上限保护，回答不会被截掉
- **并发**：按节点分车道（同节点串行）+ 全机共用信号量（默认 3 个车位）
- **可观测**：SSE 日志、轮次 JSON、原文日志、`GET /api/tasks/:id/checkpoint`
- **模型列表**：运行时问 CLI（`--help` 的 Currently supported），缓存 10 分钟，界面可手动刷新；已下线的模型在下拉里不再出现，配置里还在用的会标红
- **外部产物目录**：`[root] extra_dirs` 配白名单绝对路径（逗号分隔，全局生效）。落在这里的产物会先复制一份到 `<工作区>/_external/`，`backup` 字段指向副本；备份不成就判失败，不静默放行
- **无回执兜底**：超时/被杀/没交出回执时，扫一遍工作区与白名单目录，把 mtime 晚于开跑时间的文件记成「未验收」并落进快照；扫到上限会如实标注
- **下级提问通道**：回执可写 `ask: [{to, question}]`（问问父节点或 `user`）。父级收口简报里单列「下级在等你回答」，直接判通过会被打回并再收口一次，必须二选一：派回去回答，或用自己的 question 升级给人
- **多段任务**：主控可用回执里的 `plan`（2–8 段）自己切段，收口判 `pass` 只代表这一段过了，引擎会把下一段推给它，全部段落跑完任务才结束。进度存 `tasks.plan` / `tasks.phases_done`，界面显示「阶段 2/4」
- **对话模式**：右侧面板顶部直接和选中节点聊天（SSE 流式 + 工具/思考可见），靠 CLI 的 `--session-id` 续接上下文；支持停止单轮、清空重开。对话不产生轮次、不验产物，和任务系统互不干扰。目前只支持 codebuddy 节点

## 数据放在哪

```
.data/hub.db    任务 / 轮次索引 / 快照 / 审批 / 留言 / 单例锁
.data/runs/     每轮一份 JSON（公账）
.data/logs/     每轮一份原文（私账，永不喂给模型）
.data/memory/   项目索引、教训、流水
.sandbox/       按任务隔离的工作区（短名 workspace）
```

## 质量基线

- 单测 146 项（145 过、1 跳过），覆盖协议、路径、证据、并发原语、路由、快照、doctor
- `evals/` 15 项能力基线：回执解析、证据核验、续跑裁剪、守卫规则、配置校验
- 真实回归：多层树验收、重复打回止损、spawn 空派发、派生拒绝、僵尸锁回收

## 已知边界（不粉饰）

1. **工作区绝对路径不隔离**：配置写绝对路径是兼容口子，两个节点指向同一目录会并发写；要隔离就用短名。`extra_dirs` 更进一步——它是**有意开放**的共享写入口，靠「强制备份」兜底，不是隔离。
2. **evidence 只证明「引用过原文」**，不证明「逐条对了验收标准」。
3. **`config_snapshot` 只写不读**：runTree 用任务启动时的实时配置。
4. **续跑不是恢复会话**：codebuddy 是一次性调用，续跑是「带着快照重开一个任务」，靠 `parent_task_id` 连成链。
5. **单例锁的范围是同一个 `.data/hub.db`**：`MA_DATA_DIR` 指到不同目录的两个实例互不影响，因为它们看不到彼此的任务。
6. **模型列表只有 codebuddy 能自动探测**：其他 provider 没有 `models()`，会走缓存或内置兜底。
7. **`runTree.ts` 仍有 650 行左右**：`runOnce` 一轮的组装/解析还没拆，是下一个该动的地方。

## 最近一次变更（2026-11-16）

1. 状态快照 `checkpoints` + `parent_task_id` 续跑链 + 快照查询接口
2. `src/sdk.ts` 对外入口；`evals/` 能力基线
3. `doctor` 自检；`providers.toml` 自定义 CLI
4. `runTree` 拆分：路由 / 派生 / 收口提示词 / 简报各自成模块
5. 文档索引与这份现状速览
