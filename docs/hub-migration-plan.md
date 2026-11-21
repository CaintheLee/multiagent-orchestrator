# MultiAgent 迁移到 hub 架构：计划与自审报告

> 这份文档用于外部审计。它包含项目现状、改造目标、原计划、我自己已经查出的问题，以及明确列出"请重点攻击的假设"。
> 文档中的代码片段都从实际文件复制，行号对应 2026-11-15 11:00 的版本。

---

## 1. 项目是什么

一个本地多 Agent 编排工具。两层树：主控（master）派活给执行者（executor），执行者交付，主控验收，不合格就打回重做。

单机、单人使用，Node 24，零运行时依赖，代码 1083 行，界面 305 行。执行后端是 codebuddy CLI（`-p` headless 模式），主控用 `deepseek-v4-pro`，执行者用 `hy4free`。

已实测跑通：派活 → 执行 → 交付 → 收口 → PASS / REWORK（三段式反馈）→ 重做 → PASS。

---

## 2. 现状

### 2.1 代码结构

```
src/
├── protocol/     schema.ts   类型与白名单
│                 receipt.ts  回执解析
│                 prompt.ts   提示词拼装
├── kernel/       tree.ts     配置解析（agents.toml）
│                 settle.ts   产物归属校验
│                 guard.ts    守门员（预算/打回次数/重复指令）
│                 memory.ts   教训库读写
├── adapters/     table.ts    provider 表（codebuddy / codex）
│                 spawn.ts    进程管理
├── store/        runs.ts     公账（一轮一文件）
│                 log.ts      私账（模型原文）
├── runner/       runTree.ts  派活 → 收口 的递归主循环
└── host/         server.ts   HTTP + SSE
                  cli.ts      命令行
```

依赖方向：`host → runner → (protocol | kernel | adapters | store)`。kernel 不含 IO 之外的产品名，adapters 不含业务流程。

### 2.2 运行时的数据流

一次任务是**一个 Node 进程内的递归函数调用**，没有消息队列、没有常驻服务。

```
cli.ts / server.ts
      ↓ 调用
runTree.ts: step(node, task, parent, review, origin)
      ├─ runOne → adapters/spawn → codebuddy 子进程
      ├─ 拿到回执（含 dispatch）
      ├─ for each dispatch: await step(kid, ...)   ← 递归，串行
      └─ await step(node, brief, review=true)       ← 收口轮
      ↓ 每轮结束
store/runs.ts: saveRun(rec)   → .data/runs/<id>.json
store/log.ts:  saveLog(id)    → .data/logs/<id>.log
```

"转运"靠函数参数下行、返回值上行；"记录"靠写文件。

### 2.3 关键数据

| 项 | 值 |
|---|---|
| 轮次记录 | 45 条，`.data/runs/0001.json` 到 `0045.json` |
| 私账 | `.data/logs/<id>.log`，上限 2MB |
| 教训库 | `.data/memory/lessons.md`，注入上限 900 字 |
| 测试 | 18 项（protocol 12 + guard 6） |
| 单轮耗时实测 | 10 秒（贵模型派活）到 474 秒（免费模型写 13KB HTML） |

### 2.4 配置

`agents.toml`，零依赖的极简 TOML 解析（只支持 `key = value` 和 `[section]`）。

```toml
[root]
id = "a"
parent = ""
name = "主控"
plugin = "codebuddy"
workspace = "<repo>/.sandbox/a"
timeout_min = 4
access = "write"
role = "dispatcher"
model = "deepseek-v4-pro"

[agent.b]
id = "b"
parent = "a"
name = "执行者"
plugin = "codebuddy"
workspace = "<repo>/.sandbox/b"
timeout_min = 8
access = "write"
role = "executor"
model = "hy4free"
```

---

## 3. 为什么要改

现在的形态只支持**一次一个任务**。后续需要：

1. **多任务并发**：同时跑三五个任务，各自独立推进
2. **多个 master agent**：不同的树并行存在（例如一个做美术、一个做代码）

这两个需求用"进程内递归"做不到，原因是：**没有外部状态**。进程崩了，正在跑的任务没有任何痕迹；也没有任何东西能回答"现在有几个任务在跑"。

因此需要引入一个常驻的 hub。

---

## 4. 原计划（已被自审推翻）

原计划是四步，核心假设是「**加一层任务表就行，runner 不动**」：

| 步 | 内容 | 原估计 |
|---|---|---|
| 1 | 加任务层：三张表 + runTree 带 taskId | — |
| 2 | 加调度器：收任务、排队、并发、取消 | — |
| 3 | CLI 改投递，`--local` 保留直跑 | — |
| 4 | 界面改任务列表 | — |
| | 合计 | 约 600 行 |

**这个假设不成立。** 见下一节。

---

## 5. 自审发现的问题

### P0-1 工作区共享，并发任务互相覆盖产物（致命，不可逆）

**位置**：`agents.toml` 的 `workspace` 是固定路径；`runTree.ts:40`

```ts
fs.mkdirSync(n.workspace, { recursive: true });
```

**触发**：两个任务同时派给同一个节点（例如都投给主控 A，A 都派给 B）。

```
任务#7 的 b → 写 .sandbox/b/report.html
任务#8 的 b → 也写 .sandbox/b/report.html   ← 覆盖
```

**后果**：产物互相覆盖；agent 可能读到另一个任务写的文件；收口时验收的可能是别人的成果；记录里的 `artifacts` 路径指向已被改写的文件。

**可逆性**：不可逆。文件覆盖后无历史版本。

**修正方向**：`workspace` 只存节点名（如 `"b"`），运行时拼成 `.sandbox/t<taskId>/b`。需改 `agents.toml`、`kernel/tree.ts`、`runner/runTree.ts` 三处。

---

### P0-2 轮次编号竞争，记录会被覆盖丢失（致命，不可逆）

**位置**：`store/runs.ts`

```ts
export function saveRun(rec: RunRecord): void {
  fs.mkdirSync(RUNS, { recursive: true });
  const file = path.join(RUNS, String(rec.id).padStart(4, '0') + '.json');
  const tmp = path.join(RUNS, `.${rec.id}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(rec, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

export function nextId(): number {
  const all = loadRuns();
  return all.length ? Math.max(...all.map((r) => r.id)) + 1 : 1;
}
```

**触发**：两个任务在几十毫秒内先后完成，都算出同一个 id。

```
任务#7 → nextId() = 50 → 写 0050.json
任务#8 → nextId() = 50 → 写 0050.json   ← rename 覆盖，且不覆盖回收站
```

**后果**：一条记录凭空消失；任务与轮次的对应表里两行指向同一个 run_id；界面上一个任务永远没有结果。

**可逆性**：不可逆。

**修正方向**：id 改由 SQLite `AUTOINCREMENT` 分配。顺序必须是「先 INSERT 拿 id，再写文件」。

---

### P0-3 私账用同一套 id，一起被覆盖

**位置**：`store/log.ts` 的 `saveLog(id)` / `readLog(id)` / `hasLog(id)`。

**后果**：P0-2 一发生，公账和私账一起丢。更糟的情况是出现错配——公账是任务 A 的，私账是任务 B 的，排查时会得出完全错误的结论。

**修正方向**：同 P0-2。

---

### P1-1 无法取消任务

**位置**：`adapters/spawn.ts`

```ts
return new Promise((resolve) => {
  let killed = false;
  const child = spawn(process.execPath, [bin, ...argv], {
    cwd: opts.cwd,
    stdio: [stdinText === null ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  ...
  const timer = setTimeout(() => {
    killed = true;
    try { child.kill('SIGKILL'); } catch {}
  }, opts.timeoutMs);
```

`child` 只在 Promise 闭包里，外部拿不到。**唯一的 kill 入口是内部超时。**

**触发**：用户点"停止"。

**后果**：只能等它跑完（最长 8 分钟），或者杀 hub 进程——但那会连累所有并发任务。

**可逆性**：可逆，加一个 `signal?: AbortSignal` 参数即可。

---

### P1-2 任务可能永久卡在 running（**此条经复核后降级，见说明**）

**原判断**：`runTree` 没有 try/catch 兜底，任何未捕获异常会让任务卡在 running 并占住并发槽位；并举例"网页刷新导致 `res.write` 抛异常"。

**复核结果：举例不成立。** `host/server.ts:117` 的日志回调已经包了 try：

```ts
const send = (line) => { try { res.write(`data: ${JSON.stringify(line)}\n\n`); } catch {} };
const rec = await runTree(cfg, node, task, send, false);
```

其余可能抛异常的点也逐个查过：

| 位置 | 是否兜底 |
|---|---|
| `runTree.ts:187` 读产物内容 | 有 try/catch |
| `store/runs.ts:saveRun` | 调用处有 try/catch |
| `store/log.ts:saveLog` | 调用处有 try/catch |
| `kernel/memory.ts:loadLessons` | 函数内 try/catch |
| `runTree.ts:40` `mkdirSync` | **无兜底** |

**修正后的判断**：触发条件很窄，只剩 `mkdirSync` 失败（路径非法、无权限、磁盘满）等。但在常驻 hub 里，这类异常不再表现为"整个进程退出"（现在单任务时会直接看到），而是**静默占住一个并发槽位**，三次之后 hub 拒绝新任务。

**严重程度**：P1 降为 P2，但 `try/finally` 仍然必须加——调度器必须保证"异常也要释放槽位"。

---

### P1-3 孤儿进程

**位置**：`spawn` 未设 `detached`，也未记录子进程 pid。

**触发**：hub 被强制结束（任务管理器、Ctrl+C、崩溃）。

**后果**：codebuddy 子进程可能继续跑（Windows 上的行为不保证），继续写工作区文件，但没有任何人收结果。下次启动时工作区里是半成品，且不认识它的来历。

**可逆性**：需在启动时扫描清理，属于"可修但会产生脏数据"。

---

### P1-4 `--local` 与 hub 双写，数据分叉

**位置**：`host/cli.ts` 直跑也会写 `.data/runs/`，但不写任务表。

**触发**：用命令行跑一次任务，同时又开着 hub。

**后果**：文件里有、任务表里没有；编号也可能撞（P0-2 的新版本仍要读文件分配号的话）。

**修正方向**：`--local` 也建一条 task 记录并标记来源为 local；或者干脆去掉 `--local`。

---

### P2 其他

| 项 | 说明 |
|---|---|
| 同步 IO | `reportText` 读 6KB 产物、`prompt.ts` 每轮读 `role.md`、`loadRuns` 扫整个目录。并发 3 时毫秒级，可接受；轮次过千后 `nextId` 线性变慢，改 SQLite 后消解 |
| 进程峰值 | 单任务内 `dispatch` 是串行 `await`（见附录 A.3），所以并发 3 = 峰值 3 个 codebuddy 进程，不会爆。但若把 dispatch 改并行，必须先加进程池上限 |
| `node:sqlite` | Node 24 的实验 API，需 `--disable-warning=ExperimentalWarning`。本地工具可接受，但版本升级要盯 |
| `events` 表无轮转 | 参考数据：autoloop 4542 条事实才 1.7MB，短期无风险 |

---

### 未定义的设计缺口：任务投给哪个 master

需求说"多个 master agent"，但**任务如何选择 master 没有定义**：

- 用户指定：界面需要先选 master
- 自动分诊：需要一个"总调度"，而它本身又是一个 master

这个问题不解决，第 5 步（界面）无法落地。

**建议**：先只做"手动选 master"，自动分诊留到以后。

---

## 6. 修正后的执行顺序

| 步 | 内容 | 为什么在这个位置 |
|---|---|---|
| **0** | workspace 按任务隔离 + id 改 DB 分配 | P0，不做则并发必丢数据 |
| **1** | `spawn` 加 `AbortSignal`；调度层加 try/finally | P1-1，取消与释放的前提 |
| **2** | 任务表 + 事件表 | 原第 1 步 |
| **3** | 调度器（并发上限 3、取消、崩溃标 interrupted） | 原第 2 步 |
| **4** | CLI 投递（local 也建 task 记录） | 原第 3 步 |
| **5** | 界面（先做手动选 master） | 原第 4 步 |

预计改动约 **750 行**。比原估多 150 行，全部在第 0、1 步。

### 目标数据模型

```sql
CREATE TABLE tasks (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  master     TEXT    NOT NULL,
  task       TEXT    NOT NULL,
  state      TEXT    NOT NULL,   -- queued | running | done | failed | interrupted
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  ended_at   INTEGER,
  summary    TEXT
);

CREATE TABLE events (
  seq     INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL,
  at      INTEGER NOT NULL,
  type    TEXT    NOT NULL,      -- enqueued | started | run_started | run_finished | verdict | finished | interrupted
  payload TEXT                   -- JSON
);

CREATE TABLE task_runs (
  task_id INTEGER NOT NULL,
  run_id  INTEGER NOT NULL,
  PRIMARY KEY (task_id, run_id)
);
```

轮次详情**继续用文件**（`runs/<id>.json` + `logs/<id>.log`）：已验证的抗损坏能力，且出问题能直接 `cat`。

### 崩溃恢复规则

hub 启动时，把所有 `state = 'running'` 的任务改成 `interrupted`，**不自动重试**。

理由：自动重试会重复计费；如果它正是崩溃原因（OOM 等），重试等于再崩一次。

### 并发模型

单进程，任务用 async 并发，上限 3。所有负载都在等 codebuddy 返回，不是算力密集，单进程足够。

每个任务挂一个 AbortController，点"停止"只取消那一个。

---

## 7. 请重点攻击的假设

以下是我认为"可能想错"的地方，请逐条判断：

1. **单进程 async 并发够用**。依据：任务负载是 IO 等待。反例可能：某个 agent 返回超大输出时，JSON 解析与正则匹配会占 CPU，三个任务同时解析会互相拖慢。这个量级是否可忽略？

2. **workspace 按任务隔离就够了**。隐患：`agents.toml` 里的 `prompts/*.md`、`.data/memory/lessons.md` 仍是全局共享。多个任务同时跑时，教训库是只读的（安全），但 `learn` 命令会写它。是否需要在 learn 期间禁止派活？

3. **SQLite 只存任务和事件、轮次存文件，不会产生不一致**。隐患：INSERT 任务 → 写文件 → 更新状态，三步不是事务。如果写完文件、更新状态前崩溃，会出现"文件有、状态是 running"的记录。启动修复能否覆盖这个情况？

4. **id 由 DB 分配就能避免碰撞**。隐患：`--local` 模式下没有 DB 连接（除非也起一个），那 local 跑的轮次用什么 id？是否会与 hub 的号段重叠？

5. **单任务内 dispatch 串行，所以进程数可控**。隐患：若某个任务派了 3 个子节点，虽然串行，但每个子节点最长 8 分钟。一个任务最坏耗时可能是 4 轮 × 3 子任务 × 8 分钟。并发 3 时的实际墙钟时间是否可接受？是否需要按任务设置总超时（而不只是单轮超时）？

6. **崩溃后标 interrupted 就够**。隐患：孤儿进程仍在运行并写文件（P1-3）。如果用户看到 interrupted 就重跑，会和孤儿进程同时写同一个 workspace（若 P0-1 已修则不会，但需确认隔离路径是否含 taskId——重跑会分配新 taskId，所以安全）。

7. **`node:sqlite` 可接受**。隐患：实验 API 在次版本升级时可能变更；且它需要同步调用（`DatabaseSync`），在并发路径上会阻塞事件循环。是否应改为异步封装？（注意：SQLite 的 WAL 模式可以并发读，但写是串行的，且耗时极短。）

---

## 8. 具体想请你回答的问题

1. 上面六个 P0/P1 问题的**严重程度排序**是否合理？有没有被我低估的？
2. 修正后的六步顺序有没有**隐藏的依赖倒置**？（例如第 2 步建表时，是否已经被第 0 步的 workspace 设计反向约束？）
3. **目标数据模型**是否有明显缺陷？特别是 `task_runs` 这张关联表，是否应该把 `parent_run_id`、`verdict` 也放进去以便查询？
4. 崩溃恢复只做"标 interrupted"，是否有更简单又更安全的做法？
5. 并发上限 3 这个数字，在没有实测内存数据的情况下，用什么方法能快速定出一个安全值？
6. 有没有**根本性的替代方案**被我漏掉？（例如：不引入 hub，改用"任务进程池 + 文件锁"；或者直接用 SQLite 做队列，不使用任何内存态）

---

## 9. 验收标准

每一步都必须能独立验证，且失败可回退（项目有 git）。

| 步 | 验收 |
|---|---|
| 0 | 同一节点被两个任务同时使用，产物互不干扰；`runs/` 里的 id 无重复 |
| 1 | 点"停止"，子进程在 2 秒内消失；人为让 `mkdirSync` 失败，槽位仍被释放 |
| 2 | 跑一个三轮任务，`task_runs` 里能查到 3 条对应关系 |
| 3 | 同时投 5 个任务，3 个在跑、2 个排队；杀掉 hub 重启后，running 的变成 interrupted |
| 4 | 命令行投递与网页投递走同一条路径，任务表里都有记录 |
| 5 | 界面上能看见三个任务各自的进度与产物 |

---

## 附录 A：关键代码

### A.1 派活主循环（`runner/runTree.ts:200-255`）

```ts
async function step(
  n: NodeConfig,
  t: string,
  parent: number | undefined,
  review: boolean,
  origin: string,
): Promise<RunRecord | null> {
  const verdict = guard(thisRun, budget);
  if (verdict.stop) { log(`    守门员叫停：${verdict.why}`); return null; }
  budget -= 1;

  const rec = await runOne(n, t, parent, review);
  if (rec.state !== 'done' || !rec.dispatch.length) return rec;

  const kids = childrenOf(cfg, n.id);
  const reports: string[] = [];
  for (const d of rec.dispatch) {
    const kid = kids.find((k) => k.id === d.to);
    if (!kid) { log(`  路由拒绝：${n.id} 没有下级「${d.to}」，这条不派`); continue; }
    const kr = await step(kid, d.task, rec.id, false, '');
    if (kr) reports.push(reportText(kr, kid));
  }
  if (!reports.length) return rec;

  const brief = [ /* 原始任务 + 下级交付 + 三段式要求 */ ].join('\n');
  return await step(n, brief, rec.id, true, origin || t);
}

return await step(node, task, undefined, false, '');
```

### A.2 进程启动（`adapters/spawn.ts`）

```ts
const child = spawn(process.execPath, [bin, ...argv], {
  cwd: opts.cwd,
  stdio: [stdinText === null ? 'ignore' : 'pipe', 'pipe', 'pipe'],
  windowsHide: true,
});
const timer = setTimeout(() => {
  killed = true;
  try { child.kill('SIGKILL'); } catch {}
}, opts.timeoutMs);
```

### A.3 守门员（`kernel/guard.ts`）

纯函数，零 token。判断三条：

1. 预算耗尽 → 停
2. 连续两次打回给出同一段指令 → 停（在空转）
3. 打回次数 ≥ 3 → 停

### A.4 当前任务隔离方式

无隔离。工作区由 `agents.toml` 写死，所有任务共用。

---

## 附录 B：已实测的行为基线

| 场景 | 实测结果 |
|---|---|
| 单节点一轮 | 33 秒（"只回复两个字：就绪"） |
| 派活 + 执行 + 收口 | 224 秒（含 117 秒执行） |
| 打回完整闭环（5 轮） | 734 秒 |
| 大 HTML 产出（13.5KB） | 474 秒，压着 8 分钟上限 |
| codex 偶发静默超时 | 约 1/4 概率，已加重试一次 |
| codebuddy 无登录态 | 4.4 秒明确失败，不崩、不重试 |

---

## 附录 C：这份文档的自我审查记录

在写完 P1-2 之后，我复核了 `server.ts:117`，发现日志回调已经包了 try，因此原先"网页刷新会让任务静默死掉"的举例不成立。该条已降级并保留在文档中，未删除。

保留的原因：**外部审计者需要看到判断过程，而不只是结论。** 如果只给最终清单，无法判断这份自审的可靠性。
