# MultiAgent 迁移到 hub：实施计划 v2

> v1 见 `hub-migration-plan.md`（保留作对比，未修改）。
> 本版吸收了外部审计的 12 条意见，其中 1 条 Critical（历史迁移）、1 条 Major（配置快照）、1 条 Major（回退能力）是 v1 完全遗漏的。
> 审计记录保留在文末，包括我未采纳其表述的一处。

---

## 0. 相对 v1 的实质变化

| 项 | v1 | v2 |
|---|---|---|
| 数据模型 | `tasks` + `events` + `task_runs` | **`tasks` + `runs` + `events`**，`runs` 自带 AUTOINCREMENT |
| 历史记录 | 未考虑 | **63 条（0001–0063）必须显式导入，且先导入再分配** |
| 执行路径 | hub + `--local` 双路 | **hub 是唯一执行者**；离线模式必须独立 `--data-dir` |
| 取消 | 加 `AbortSignal` 即可 | **Windows 需 Job Object 杀进程树**，且需 `cancelling` 中间态 |
| 崩溃恢复 | 标 `interrupted` | **四步对账**：清进程 → 核对 → 隔离孤儿 → 处理状态 |
| 配置 | 运行时读取 | **入队时快照**，全程用同一份 |
| 回退 | "有 git 可回退" | **代码可回退，数据不可**（`.data/` 在 .gitignore）。必须备份 + 迁移演练 |
| 步数 | 6 步 | 7 步，存储基座提到最前 |

---

## 1. 项目现状（未变部分）

单机多 Agent 编排。两层树：主控派活、执行者交付、主控验收、不合格打回。Node 24，零运行时依赖，12 个 TS 文件 1083 行，界面 305 行，执行后端 codebuddy `-p`。

已实测跑通：派活 → 执行 → 交付 → 收口 → PASS / REWORK（三段式）→ 重做 → PASS。

### 1.1 代码结构

```
src/
├── protocol/   schema.ts receipt.ts prompt.ts
├── kernel/     tree.ts settle.ts guard.ts memory.ts
├── adapters/   table.ts spawn.ts
├── store/      runs.ts log.ts
├── runner/     runTree.ts
└── host/       server.ts cli.ts
```

依赖方向 `host → runner → (protocol | kernel | adapters | store)`。

### 1.2 运行方式（要改的地方）

一次任务 = 一个 Node 进程内的递归调用。**没有常驻状态。**

```
cli.ts / server.ts → runTree.step() → spawn → codebuddy
                        ↓ 每轮结束
                   saveRun(id) → .data/runs/<id>.json
                   saveLog(id) → .data/logs/<id>.log
```

并发本身没问题（async 就行）。**做不到的是可恢复、可查询、可取消**，因为没有外部状态。

### 1.3 真实数据基线（2026-11-15 11:10）

| 项 | 值 |
|---|---|
| 轮次记录 | **63 条**，`0001.json` – `0063.json` |
| 私账 | `.data/logs/`，上限 2MB/轮 |
| 教训库 | `.data/memory/lessons.md`，注入上限 900 字 |
| 测试 | 18 项 |
| 单轮耗时 | 10 秒（贵模型派活）– 474 秒（免费模型写 13.5KB） |
| 最长闭环 | 734 秒（5 轮含打回） |
| Git 保护范围 | 仅代码。`.data/`、`.sandbox/` 被 `.gitignore` 排除 |

---

## 2. 目标与非目标

### 目标

1. 多任务并发（上限可配）
2. 多 master，手动选择
3. 可取消、可恢复、可查询
4. 单一执行路径，状态只有一个权威来源

### 明确排除（第一版不做）

- 任务内 dispatch 并行
- master 自动分诊
- 多用户、权限
- 分布式 / 多机 worker
- 任务重试（崩溃后一律不自动重试）

---

## 3. 数据模型

### 3.1 三张表

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

CREATE TABLE tasks (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  master              TEXT    NOT NULL,
  task                TEXT    NOT NULL,
  state               TEXT    NOT NULL DEFAULT 'queued',
  error_code          TEXT,
  error_message       TEXT,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  started_at          INTEGER,
  ended_at            INTEGER,
  cancel_requested_at INTEGER,
  config_snapshot     TEXT    NOT NULL,
  client_request_id   TEXT    UNIQUE
);

CREATE TABLE runs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id       INTEGER NOT NULL REFERENCES tasks(id),
  parent_run_id INTEGER REFERENCES runs(id),
  node_id       TEXT    NOT NULL,
  phase         TEXT    NOT NULL,
  state         TEXT    NOT NULL,
  verdict       TEXT,
  json_path     TEXT    NOT NULL,
  log_path      TEXT,
  started_at    INTEGER,
  ended_at      INTEGER,
  ms            INTEGER
);

CREATE TABLE events (
  seq     INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id),
  at      INTEGER NOT NULL,
  type    TEXT    NOT NULL,
  payload TEXT
);

CREATE INDEX idx_runs_task    ON runs(task_id, id);
CREATE INDEX idx_runs_parent  ON runs(parent_run_id);
CREATE INDEX idx_events_task  ON events(task_id, seq);
CREATE INDEX idx_tasks_state  ON tasks(state, created_at);
```

**为什么 `runs` 自带 id 而不是关联表**：v1 的 `task_runs(task_id, run_id)` 没有自增，无法落实"由 DB 分配轮次 id"。审计指出这一点是正确的。

**为什么 `parent_run_id` 和 `verdict` 在 `runs` 里**：它们是轮次的属性，不是多对多关系。放关联表会导致同一 run 有多个 parent 的歧义。

### 3.2 任务状态机

```
                  ┌──────────── canceled（未开始就取消）
                  │
queued ───────────┼──→ running ──┬──→ done
                  │              ├──→ failed
                  │              ├──→ timed_out
                  │              └──→ cancelling ──→ canceled
                  │
                  └──→ interrupted（hub 崩溃后对账得出，只读）
```

合法迁移：

| 从 | 到 | 触发 |
|---|---|---|
| queued | running | 调度器认领 |
| queued | canceled | 用户取消 |
| running | done / failed | runTree 返回 |
| running | timed_out | 任务总超时到 |
| running | cancelling | 用户点停止 |
| cancelling | canceled | 子进程确已退出 |
| running | interrupted | 启动对账 |

**`cancelling` 是必须的中间态**：发信号不等于已退出。审计指出 v1 缺这个状态，正确。

### 3.3 轮次状态

沿用现有 `done | failed | blocked`，加 `interrupted`（进程消失但已有部分输出）。

---

## 4. 历史迁移（v1 遗漏的 Critical）

**风险**：新库 `AUTOINCREMENT` 从 1 开始，第一轮就写 `0001.json`，覆盖 8 月以来的 63 条历史。

### 迁移步骤

```
1. 备份        cp -r .data .data.backup-<时间戳>
2. 预检        读 0001–0063，确认 63 个文件都能解析，记录 max(id)=63
3. 建表        CREATE TABLE ...
4. 导入        显式带 id 插入：INSERT INTO runs(id, task_id, node_id, ...) VALUES (1, ...)
               每一步都指定原 id，不让 AUTOINCREMENT 参与
               全部导入后再查 sqlite_sequence，确认 runs 的下一个值是 64
5. 核对        COUNT(runs) == 63
               MIN(id)=1, MAX(id)=63
               逐条核对 json_path 指向的文件存在
6. 留痕        .data/runs/.migrated-v2 写入迁移时间、条数、sha256 清单
```

**顺序不能反**：先导入旧 id，再让 DB 分配新 id。反了就会撞。

### 旧记录归属

历史轮次没有 task 概念。迁移时建一条特殊任务：

```sql
INSERT INTO tasks(id, master, task, state, config_snapshot, created_at, updated_at)
VALUES (1, '__legacy__', '迁移自 v1 的 63 条轮次', 'interrupted', '{}', <最早时间>, <现在>);
```

所有历史 run 的 `task_id = 1`。这样外键成立，界面上单独显示为"历史记录"，不混淆新任务。

### 回退

`runs/` 和 `logs/` 文件不动（只增不改），DB 只做索引。**删掉 DB 就能退回 v1 行为**，这是这个设计的回退保证。

---

## 5. 七步实施

审计指出 v1 的步骤依赖倒置：第 0 步用 SQLite 但任务表在第 2 步才建。修正后：

| 步 | 内容 | 验收（不依赖后续步骤） |
|---|---|---|
| **1** | **规格与基线**：状态机、取消语义、恢复不变量写成文档；备份 `.data` 并做一次恢复演练 | 能从备份还原出 63 条记录，跑一次 `status` 结果一致 |
| **2** | **持久化与迁移**：三张表、事务仓储、索引外键、导入 63 条历史 | `COUNT(runs)=63`，`MAX(id)=63`，新插入一条得到 64 |
| **3** | **执行器加固**：`runTree` 接上下文 `{taskId, attemptId, signal, eventSink}`；工作区隔离；配置快照；try/finally；任务总超时；进程树退出 | 用测试夹具直接调 `runTree`，不经调度器和界面：两任务同节点产物互不干扰；cancel 后 2 秒内进程树消失；`mkdirSync` 失败后槽位仍释放 |
| **4** | **调度与恢复**：SQLite 作持久队列；原子认领 queued；并发上限；取消；启动四步对账 | 投 5 个任务：3 跑 2 排队；杀 hub 重启，running 变 interrupted，queued 被重新加载并执行 |
| **5** | **统一入口**：CLI 与网页都投递给 hub；幂等提交；查询与取消 API；SSE 带 seq 与 Last-Event-ID | 同一条命令重复执行两次只建一个任务；SSE 断线重连不重复不丢 |
| **6** | **界面**：手动选 master、任务列表、详情、进度、产物、取消 | 三个任务各自推进，互不串台 |
| **7** | **压测与发布**：故障注入、并发压力、长任务、磁盘预算 | 见第 7 节 |

---

## 6. 关键设计决策

### 6.1 工作区隔离

`agents.toml` 的 `workspace` 只存节点名：

```toml
[agent.b]
workspace = "b"
```

运行时路径 = `<repo>/.sandbox/t<taskId>/b`。

### 6.2 配置快照

入队时把 master 的 `model`、`plugin`、`access`、`timeout_min`、`prompts/*.md` 内容、`lessons.md` 内容全部序列化进 `tasks.config_snapshot`。

整个任务用这份快照，不再读磁盘。

理由：一个任务可能跑 12 分钟，期间改配置会让前后轮次标准不一致，且记录里看不出来。

**`learn` 的写冲突**：改用临时文件 + 原子替换，并串行化。快照之后不需要全局停止派活。

### 6.3 取消与进程树（Windows）

`child.kill('SIGKILL')` 只杀直接子进程。codebuddy 是 node，它可能再 spawn shell，孙进程会活下来继续写工作区。

**参考实现**：`~/.agent-autoloop/app/worker/windows.ps1`，46 行。用 P/Invoke `CreateJobObject` + `AssignProcessToJobObject`，注释写明"closing the supervisor kills the whole job"。

我们的做法：spawn 后把子进程加入 Job Object，`signal` 触发时 `CloseHandle` 整个 job。

### 6.4 崩溃恢复四步

```
1. 清进程   按记录的 pid + 创建时间判断归属，仍在跑的终止（不靠裸 pid，会复用）
2. 核对     runs 表、json 文件、log 文件、events 四者是否一致
3. 隔离     对不上的文件移到 .data/orphan/，不删除
4. 处理状态  running → interrupted；queued → 重新加载并执行
```

**不自动重试已启动的任务**：会重复计费，且如果它是崩溃原因（OOM），重试等于再崩。

### 6.5 执行路径唯一

**hub 是唯一执行者。** CLI 和网页都只投递。

保留离线模式的话，必须 `--data-dir <repo>-offline` 完全独立——独立数据库、独立沙箱根、独立轮次目录。**绝不与 hub 共用任何文件。**

另加 hub 单实例锁（库里的 `hub_lock` 行），第二个实例启动直接报错退出。

### 6.6 SQLite 使用纪律

- 固定 Node 小版本（当前 24.8.0）
- 事务只包短小的元数据操作，**不在事务里读产物或写大日志**
- WAL + `busy_timeout=5000`
- 不指望"异步封装"能移出事件循环——包 Promise 不会改变同步阻塞的本质

---

## 7. 验收与故障注入

### 7.1 确定性故障注入

用假 adapter（不起真 codebuddy），在每个临界点后杀进程：

| 注入点 | 期望恢复结果 |
|---|---|
| INSERT task 之后、写 json 之前 | 任务存在但无 run，标 failed，不产生孤儿文件 |
| 写完 json、UPDATE state 之前 | 启动对账发现"文件有、状态 running"，改为 interrupted，run 记录补齐 |
| 写 log 中途 | log 截断可识别，不影响 run 记录 |
| rename 之前 | 只有 `.tmp`，清理并重跑该轮 |
| event 提交后、状态更新前 | 事件比状态新，以事件为准重建状态 |
| 取消信号发出后、进程退出前 | 状态停在 cancelling，重启后按实际进程判断 |

### 7.2 压测

- 并发 1/2/3/4 各跑一次，记录 P95 子进程峰值内存、事件循环延迟、超时率
- 并发上限 = min(内存允许, provider 限流, CPU/磁盘)
- 任务总超时（不只是单轮）：建议 30 分钟，可配
- 队列长度上限与磁盘预算

### 7.3 迁移演练

```
1. 备份 .data → .data.backup
2. 跑迁移
3. 核对 63 条
4. 删除 DB，跑 status，结果应与迁移前一致
```

第 4 步是回退能力的实证。

---

## 8. 对审计 12 条的处置

| 审计意见 | 处置 |
|---|---|
| Critical：`run_id` 分配表不存在 + 遗漏历史迁移 | **采纳**。新增 `runs` 表，第 4 节写完整迁移步骤 |
| Major：步骤依赖倒置 | **采纳**。存储基座提前，取消验收移到第 3 步的测试夹具，界面相关验收移到第 6 步 |
| Major：`--local` 补记录不解决双所有权 | **采纳**。第一版 hub 唯一执行者，离线模式必须独立数据根 |
| Major：AbortSignal 不等于可靠取消（Windows 进程树） | **采纳**。用 Job Object，参考 autoloop 的 windows.ps1 |
| Major：启动只改标签不修复不一致 | **采纳**。四步对账 + 孤儿隔离而非删除 |
| Major：任务状态机不足 | **采纳**。加 `cancelling` / `canceled` / `timed_out` / `interrupted`，加错误字段与索引 |
| Major：按任务隔离不等于输入一致 | **采纳**。配置快照 + learn 原子写 |
| Major：资源估算不足 | **采纳**。750 行改为按模块估，第 7.2 节压强测 |
| Major：验收偏 happy path、"有 git 可回退"不成立 | **采纳**。`.data/` 确实不在 git 里，已核实。改为备份 + 迁移演练 + 故障注入 |
| Minor：缺 API/事件契约 | **采纳**。`client_request_id` 幂等，SSE 用 seq + Last-Event-ID |
| Minor：异步封装 SQLite 的误区 | **采纳**。写入 6.6 使用纪律 |
| 表述：**"进程内递归做不到并发"不准确** | **采纳并修正**。原文改为"并发能做到，做不到的是可恢复、可查询、可取消" |

**未采纳的表述**：审计称"根本替代方案方面，继续采用单 hub + SQLite 最符合当前规模"。这与我的判断一致，但它同时把"文件锁 + 进程池"否掉的理由是"会把陈旧锁、跨进程取消和恢复问题留给项目"。我同意结论，但补充一点：**如果将来要跨机器，文件锁方案会重新变得有吸引力**，因为 SQLite 不能跨主机。这一点记为已知边界，不影响第一版。

---

## 9. 工作量分解（替代 v1 的"750 行"）

| 模块 | 内容 | 估量 |
|---|---|---|
| 存储 | schema、迁移、仓储、事务封装 | 220 行 |
| 执行器改造 | 上下文注入、隔离、快照、try/finally、Job Object | 180 行 |
| 调度与恢复 | 队列、认领、并发、取消、对账 | 200 行 |
| 入口 | CLI 投递、API、SSE seq | 130 行 |
| 界面 | 任务列表、详情、取消 | 180 行 |
| 测试 | 故障注入 6 项、并发验收、迁移核对 | 250 行 |
| | 合计 | **约 1160 行** |

v1 估 750 行，漏掉了测试（250）和恢复对账（约 80）。

---

## 10. 现在就能开始的第一步

**第 1 步：规格与基线**，不写功能代码。

1. 把第 3.2 节状态机、第 6.4 节恢复不变量、第 3 节 schema 落成 `docs/hub-spec.md`
2. 备份 `.data`，做一次恢复演练（删 DB → 跑 status → 与迁移前对比）
3. 用 63 条真实记录验证"导入后 MAX(id)=63、下一条是 64"

这三件事做完，第 2 步才有基准可对。

---

## 附录：v1 的问题清单（保留）

v1 已识别并仍成立的：

- P0-1 工作区共享（不可逆）
- P0-2 轮次编号竞争（不可逆）
- P0-3 私账同源覆盖
- P1-1 无法取消
- P1-2 异常占槽位（已降级 P2，仅 `mkdirSync` 无兜底）
- P1-3 孤儿进程（**本版提升为阻断项**）
- P1-4 `--local` 双写（**本版提升为阻断项**）
- P2 同步 IO、进程峰值、实验 API、事件表轮转
