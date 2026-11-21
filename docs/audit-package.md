# MultiAgent 审计包（供外部模型审查）

> 生成时间：2026-11-16 13:35
> 代码位置：`<repo>`
> 用途：这份文档是自包含的。审计者不需要我解释任何背景，读完就能定位代码、判断设计。

---

## 0. 一句话说清这是什么

一个本地多 agent 编排器：**一个主控模型拆活 → 派给若干执行模型 → 各自在独立工作区写文件 → 主控按证据验收 → 不合格打回**。

不是框架、不是库，是一个能跑的单机服务（Node 24，无第三方依赖，无构建步骤）。控制台是一个 HTML 文件，SQLite 存状态。

**运行方式**

```bash
cd <repo>
node --disable-warning=ExperimentalWarning src/host/server.ts --no-open
# 打开 http://127.0.0.1:3400/
```

**测试**

```bash
npm test        # node --test tests/*.test.ts，116 项
```

**它解决的真实问题**：用便宜模型干细活、贵模型只做拆解和验收，同时确保便宜的模型糊不了事。

---

## 1. 架构总览

```
┌─ host ────────────────────────────────────────────┐
│ server.ts  969行  HTTP + SSE + 28 个路由分支       │
│ cli.ts     273行  命令行（run / learn / dry-run）  │
└────────────────┬──────────────────────────────────┘
                 ↓
┌─ hub ─────────────────────────────────────────────┐
│ scheduler.ts 234行  任务级并发、认领、取消、对账    │
│ logbus.ts     46行  日志缓冲 + 订阅                │
└────────────────┬──────────────────────────────────┘
                 ↓
┌─ runner ──────────────────────────────────────────┐
│ runTree.ts 820行  跑一棵树：派活/验收/派生/留言     │
└────────────────┬──────────────────────────────────┘
                 ↓
┌─ kernel（纯逻辑，不碰网络）────────────────────────┐
│ tree.ts     236  配置读写 + 拓扑校验 + 工作区解析   │
│ settle.ts   119  产物路径校验 + 证据核对            │
│ guard.ts     89  零 token 的「该不该继续」          │
│ lane.ts      54  同车道串行 / 不同车道并行          │
│ pool.ts      70  全局车位信号量                     │
│ approval.ts  44  派生审批的阻塞等待                 │
│ memory.ts    81  三份记忆的读写                     │
│ snapshot.ts  60  入队时的配置快照（当前未消费）      │
└────────────────┬──────────────────────────────────┘
                 ↓
┌─ protocol ────────────────────────────────────────┐
│ schema.ts    79  回执类型与常量                     │
│ receipt.ts  173  解析 + 形状校验                    │
│ prompt.ts    99  提示词组装                         │
└────────────────┬──────────────────────────────────┘
                 ↓
┌─ adapters ────────────────────────────────────────┐
│ table.ts    107  provider 表（codex/codebuddy/claude/gemini）│
│ spawn.ts    118  起进程、收输出、超时杀、进程树 kill │
└────────────────┬──────────────────────────────────┘
                 ↓
┌─ store ───────────────────────────────────────────┐
│ db.ts       324  建表、迁移、任务/轮次 CRUD          │
│ runs.ts     100  轮次记录落盘（json）               │
│ log.ts       37  原文落盘（每轮一份 .log）          │
│ approvals.ts 113 派生审批单                        │
│ messages.ts  99  点对点留言                        │
└───────────────────────────────────────────────────┘
```

**依赖方向严格单向**：host → hub → runner → kernel/store/adapters/protocol。kernel 不 import runner，adapter 不知道业务。

---

## 2. 目录与文件职责

| 路径 | 行数 | 职责 | 审计价值 |
|---|---:|---|---|
| `src/runner/runTree.ts` | 820 | **核心**：递归跑树、派活、收口、派生、留言 | ★★★★★ |
| `src/host/server.ts` | 969 | HTTP 路由、SSE、配置接口 | ★★★★ |
| `src/store/db.ts` | 324 | 表结构、轮次 id 分配、状态机 | ★★★★ |
| `src/hub/scheduler.ts` | 234 | 认领、并发、取消、重启对账 | ★★★★ |
| `src/kernel/tree.ts` | 221 | TOML 解析、拓扑校验、工作区解析 | ★★★★ |
| `src/protocol/receipt.ts` | 159 | 回执解析（模型输出 → 结构化） | ★★★★ |
| `src/adapters/spawn.ts` | 114 | 进程管理、超时、取消 | ★★★ |
| `src/kernel/settle.ts` | 100 | 路径归属、软链、证据比对 | ★★★★ |
| `src/kernel/approval.ts` + `store/approvals.ts` | 157 | 派生审批 | ★★★ |
| `src/store/messages.ts` | 99 | 点对点留言 | ★★★ |
| `src/kernel/lane.ts` + `pool.ts` | 124 | 并发原语 | ★★★★ |
| `src/kernel/guard.ts` | 89 | 防失控的算术判据 | ★★★ |
| `src/protocol/prompt.ts` | 99 | 提示词组装（role 做路径校验） | ★★★ |
| `src/protocol/resume.ts` | 74 | 续跑简报拼装（超长只砍原任务） | ★★ |
| `src/kernel/memory.ts` | 81 | 三份记忆注入 | ★★ |
| `src/host/cli.ts` | 273 | 命令行入口 | ★★ |
| `ui/index.html` | 2550 | 单文件控制台 | ★★★ |
| `tests/*.test.ts` | 1637 | 13 个文件，116 项 | — |

---

## 3. 一次任务的生命周期

```
POST /api/run {task}
  → createTask(state=queued)，存 config_snapshot
  → scheduler.tick 每 400ms 认领（maxConcurrent=3）
  → 标 running，起 runTree

runTree(cfg, 根节点, task)
  ├─ 解析工作区：每个节点 → .sandbox/t<taskId>/<节点名>
  ├─ budget = 12（工作轮扣，收口/补验不扣；收口另有 6 轮上限）
  ├─ step(根, task)
  │    ├─ 取车位（全局 Semaphore，默认 3）
  │    ├─ 取留言（takeMessages）
  │    ├─ buildPrompt：角色 + 项目索引 + 流水 + 教训 + 下级 + 留言 + 任务 + 回执规则
  │    ├─ spawn codebuddy -p ... （超时 4–8 分钟，按节点配）
  │    ├─ parseReceipt（取最后一个 ```agent-autoloop 块）
  │    ├─ checkArtifacts（路径必须在工作区、realpath 防软链）
  │    ├─ 写 run 记录（json + db），释放车位
  │    ├─ 处理 tell → messages 表（异步，不等待）
  │    ├─ 处理 spawn → approvals 表 → 阻塞等人批（dispatch 为空也要先处理）
  │    ├─ 派活全被拦下（打回到上限 / 指令重复）→ 直接收场 blocked，不再跑收口
  │    └─ 按 dispatch 并发派活（runLanes，lane=节点 id）
  └─ 收口：把所有 report 塞进 brief，让主控判 pass / rework
       ├─ 验收目标是**整棵子树**累计交出的产物，不只是直接下级的最后一条记录
       ├─ rework → 再派（同一节点；同一段指令第二次就被拦下）
       └─ pass → 检查 evidence（逐字搜索产物），核不上则驳回一次
```

**关键设计**：主控不直接执行，只拆和判；执行者的产物路径强制落在自己工作区；主控判 pass 必须给出能在产物里搜到的原文片段。

---

## 4. 协议：回执

模型每轮必须在输出末尾给一个带语言标记的代码块：

````
```agent-autoloop
{"summary":"一句话结论","artifacts":[{"path":"x.md","kind":"md"}],"dispatch":[],"evidence":["原文片段1","原文片段2"],"spawn":[],"tell":[],"question":""}
```
````

| 字段 | 约束 | 违规后果 |
|---|---|---|
| `summary` | 非空，≤ maxSummary（默认 200 字） | 整轮 failed |
| `artifacts` | 数组，每项 `{path, kind}`；路径必须在自己工作区内 | 越界项 → 整轮 failed |
| `dispatch` | `[{to, task}]`，`to` 必须是直接下级 | 无下级者不派；超 8 条截断 |
| `evidence` | 判 pass 时至少 2 条，每条 6–120 字，必须能在产物里逐字搜到 | 判 pass 但搜不到 → 驳回重判一次 |
| `spawn` | `[{name, why, task, model?, role?}]`，≤3 条；**需用户审批** | 形状错 → 整轮 failed |
| `tell` | `[{to, msg}]`，≤3 条，每条 ≤500 字；异步留言 | 坏条目丢弃，不判失败 |
| `question` | 字符串；给了且无产物 → 该轮 blocked | — |

**顶层多任何字段都拒**（`ALLOWED_KEYS` 白名单）。

**解析要点**：取**最后一个**代码块（正文里可能引用格式示例）；JSON 必须是对象；evidence 太短/太长**丢弃该条**而不判失败；tell 写成单个对象会自动包成数组。

---

## 5. 数据模型

```sql
tasks(id, master, task, state, error_code, error_message,
      created_at, updated_at, started_at, ended_at,
      cancel_requested_at, config_snapshot, client_request_id UNIQUE)

runs(id, task_id→tasks, parent_run_id→runs, node_id, phase,
     state, verdict, json_path, log_path, started_at, ended_at, ms)

events(seq, task_id→tasks, at, type, payload)

approvals(id, task_id→tasks, run_id, kind, payload, state,
          created_at, decided_at, note)

messages(id, task_id→tasks, run_id, from_node, to_node, body,
         state, created_at, delivered_at)
```

**状态取值**

- `tasks.state`：`queued / running / cancelling / canceled / done / failed / blocked / interrupted / timed_out`
  （`timed_out` 由旧数据与 CLI 写入，`interrupted` 由 scheduler 的 reconcile 写入）
- `runs.state`：`running / done / failed / blocked / canceled / interrupted`
  （`interrupted` 只在 reconcile 里写入：任务已结束但轮次还挂着 running 的僵尸）
- `runs.verdict`：`pass / rework`（仅收口轮；**rework 不算完成**）
- `approvals.state`：`pending / approved / rejected / expired`
- `messages.state`：`pending / delivered / dropped`

**关键约束**：轮次 id 由 `allocRunId` 先 INSERT 占位再返回（并发不撞号）；`importLegacyRuns` 显式带 id 导入历史，让 `sqlite_sequence` 跟到最大值。

---

## 6. 并发模型（三层，容易看混）

| 层 | 机制 | 默认 | 代码 |
|---|---|---|---|
| 任务级 | `scheduler` 认领队列，`maxConcurrent` | 3 | `scheduler.ts:130` |
| 轮次级 | `runLanes`：同 lane 串行、不同 lane 并行，`lane = 执行节点 id` | 无上限 | `lane.ts` |
| 进程级 | 全局 `Semaphore`，任务和轮次**共用一个池** | 3（`MA_CONCURRENCY`） | `pool.ts` + `runTree` 的 `runOnce` |

**为什么车位只在一个地方申请**：主控轮不经过 `runLanes`。如果只在 `runLanes` 申请，主控轮就不受约束（3 任务 = 3 主控 + 3 子轮 = 6 进程）。两边都申请会死锁（`runLanes` 占满 3 个，每个 `runOnce` 再申请 3 个）。

**为什么 lane 按节点分**：一个节点只有一个工作区。两个进程同时往里写就是真冲突。所以同节点必须串行，不同节点才并行。并行度 = `min(派活涉及的节点数, 车位)`。

**取消**：`AbortSignal` 广播到所有在跑轮次；`spawn` 用 `taskkill /T /F` 杀进程树（`child.kill` 只杀直接子进程，孙进程会继续写文件）。

**重启对账**：`reconcile` 把 `running` 任务改 `interrupted`、把僵尸轮次收场、把待审批作废。**不自动重跑**（避免重复计费）。

---

## 7. 隔离与安全边界

| 边界 | 做法 | 强度 |
|---|---|---|
| 工作区 | `.sandbox/t<taskId>/<节点名>`，按任务+节点双重隔离 | 物理隔离（短名）；**绝对路径例外** |
| 产物归属 | `checkArtifacts`：`realpath` 后判 `path.relative`，越界 → 整轮 failed | 强制 |
| 软链 | 根和产物都过 `realpathSync`；`inside()` 判 `..` 与绝对路径 | 强制 |
| 配置注入 | `id`/`role`/`name` 都有正则；TOML 重复 section 报错；`parent` 自环与不可达报错 | 强制 |
| 网络 | 只监听 `127.0.0.1` | — |
| 请求体 | 上限 8MB；任务正文上限 2 万字 | 强制 |
| 派生 | 只有根节点能提，单任务 ≤3 个，总节点 ≤48，**每个都要用户批准** | 强制 |
| 单实例 | `hub_lock` 表一行认领：`INSERT` 主键唯一 + `DELETE ... WHERE pid = <看到的死 pid>` 回收 | 原子（非锁文件） |
| **外部写盘** | **不防**。codebuddy 没有沙箱，`access` 字段对它无效；产物校验只看回执里声明的路径，且发生在写盘之后 | **口头约定** |

**最后一行是关键缺口**：子 agent 用绝对路径写 `D:/YourProject` 是可能的，两条线同时写同一文件会撞车。目前靠任务正文里写死「只写文件名」+ 事后产物校验兜着。

**工作区隔离的准确表述**：`../x`、含分隔符的短名这类路径逃逸已经堵死（`SAFE_NAME` 校验）；但配置里写**绝对路径**是保留的兼容口子——两个节点或两个任务可以配同一个绝对目录，`lane` 只保证同节点串行，挡不住这种共享写。要真隔离就把 workspace 写成短名。

**为什么单例锁不用锁文件**：文件系统没有 compare-and-delete。两个进程同时读到同一个死 pid，A 删掉旧锁再建新锁，B 随后把 A 的新锁删掉再建自己的——两个 hub 一起活。在 `unlink` 前再读一次 pid 只是缩小窗口，不是闭合。改用库里一行：`INSERT` 靠主键唯一约束保证只有一个进程插得进去；回收僵尸锁用带条件的 `DELETE`（条件里带着「我看到的那个死 pid」），影响 0 行就说明别人先回收了，什么都不删，回头重试插入。两步都是 SQLite 的原子操作，没有 TOCTOU。代价是启动时要先开库，所以 `openDB` 对「并发首建/切 WAL」的 busy/readonly 做了换连接重试。

---

## 8. 成本与防失控

不用模型审「有没有浪费 token」（那本身是浪费），全是算术：

| 机制 | 规则 | 位置 |
|---|---|---|
| 轮次预算 | 12 轮，**只扣工作轮**（`review=false`，含不派活的叶节点）；收口/补验不占 | `runTree.ts` |
| 打回次数 | 同一节点打回 ≥3 次叫停 | `guard.ts` + `runTree.ts` 路由 |
| 重复打回 | 打回指令前 80 字相同 → 第二次就拦下，不再派 | `runTree.ts` 路由（`sameInstructionTimes`） |
| 收口空转 | 派活全被拦下时直接收场 blocked，不再调模型 | `runTree.ts`（`closeBlocked`） |
| 收口上限 | 单节点最多 6 轮收口，超了落 blocked | `runTree.ts`（`MAX_REVIEW_ROUNDS`） |
| 派活上限 | 一轮最多 8 条，超出截断并写 SKIPPED 报告 | `runTree.ts` |
| 证据门槛 | 判 pass 至少 2 条能在产物里搜到的原文 | `settle.ts` |
| 派生上限 | 单任务 ≤3，每笔审批 | `approval.ts` |
| 超时 | 每节点 `timeout_min`，夹在 1–120 | `tree.ts` |

**成本可见性**：每轮记 `model` + `promptBytes`（真 token 拿不到，codebuddy 文本输出无 usage）。

---

## 9. 已知限制与设计取舍（诚实清单）

1. **不能恢复会话**。codebuddy 是 `-p` 一次性调用，没有 native session id。「续跑」是把已完成清单写进新任务，不是接着上次说。
2. **外部写盘不防**（见 §7）。
3. **evidence 只证明「引用了原文」**，不证明「逐条对了验收标准」。要后者只能上独立审计 agent（当前没做）。
4. **消息不重投**。某轮失败重试时，已 `delivered` 的留言不会二次注入。
5. **收口时长 = 最慢那条**，不是平均。一条超时 8 分钟，整体就卡 8 分钟。
6. **取消是全停**，不支持单条产线取消。
7. **排队轮次在 DB 里已标 `running`**（`allocRunId` 在抢车位之前），界面会短暂显示「运行中」其实在排队。
8. **`config_snapshot` 存了从不读**（快照写进 DB，runTree 用的是任务启动时读的实时配置）。
9. **`plugin` 缺省是 `codex`**；漏写会跑错 provider（会被 `runOnce` 的 catch 接住记 failed，不会崩服务）。
10. **`server.ts` 987 行、`runOnce` 单函数 200+ 行**，结构和可读性有改进空间。
11. **工作区绝对路径不隔离**（见 §7）：路径逃逸已修，但两个节点配同一个绝对目录仍会并发写。
12. **收口产物按子树累计**：同名文件按路径去重，核证据时读的是磁盘上的最新内容；代价是历史轮次写过的同名产物也会进入比对范围（更宽松，但不会漏核）。
13. **收口轮不占预算，靠 `MAX_REVIEW_ROUNDS=6` 兜底**：正常流程 2–4 轮就结束，到 6 轮说明上游一直在空转，落 blocked 比继续烧更划算。
14. **单例锁依赖同一个库**：互斥的范围是 `.data/hub.db`。把 `MA_DATA_DIR` 指到不同目录的两个实例本来就看不到彼此的任务，不需要互斥。
15. **派生被拒绝 = 任务 blocked**：主控只提派生、没派活时，拒绝或超限都会落 blocked 让人看见；叶节点顺手提的非法派生不拦它已经交付的活。
16. **续跑装不下就 413**：不再整体 slice。回答和尾部指令必须完整，装不下就明确拒绝（原先会「表面续跑成功、回答已被截掉」）。

---

## 10. 审计指引（建议按这个顺序看）

### 优先看这五处

1. **`runTree.ts` 的 `step` 函数**
   递归 + 并发 + 收口混在一起。重点检查：`budget` 的扣减点（只有 `review=false` 才扣）、`reports` 顺序、`rec.spawn` 与 `rec.tell` 的处理位置（曾经放错过一次）、`applySpawns` 的三道闸门、`delivered` 这张「子树累计产物」表会不会漏记某一轮。

2. **`settle.ts` 的 `checkArtifacts` 与 `inside`**
   路径归属是唯一的安全关口。检查：`realpath` 是否覆盖所有分支、`..` 前缀判断、相对路径解析基准、Windows 大小写、UNC 路径（`\\server\share`）会不会绕过。

3. **`pool.ts` + `lane.ts`**
   并发原语。检查：`release` 超额调用会怎样、`acquire` 的排队是否公平、异常路径是否一定 release、lane 链断裂的可能性。

4. **`receipt.ts`**
   模型输出是**不可信输入**。检查：大 JSON 会不会打爆内存、`JSON.parse` 的边界、`EVIDENCE_*` 与 `TELL_*` 的宽松处理是否有漏洞、最后一个代码块的选择是否会取错。

5. **`db.ts` 的 `allocRunId` / `finishRun` / `reconcile`**
   检查：占位行残留、id 空洞、并发 INSERT、外键约束、重启后状态收敛是否完整。

### 我们自己也不确定的五点

1. **budget 的并发性是安全的——上一版这里写错了**。`guard()` 读和 `budget -= 1` 在同一个同步块里，中间没有 `await`；Node 是单线程，另一个 lane 不可能插在两者之间。上一版写成「并发下可能多跑一两轮」是错的，已删除。真正要盯的不是竞态，而是**收口轮不扣预算**这一点会不会被滥用：现在由「派活全被拦下就直接收场」和 `MAX_REVIEW_ROUNDS=6` 两道闸兜住，`tests/tree.test.ts` 有一条用例专门跑这个形态。

2. **`runLanes` 不保证 FIFO**。同车道的后续任务在链上等待，不在信号量的等待队列里，所以长车道会被短车道插队。**判定：不会饥饿（排队者有限），但严格公平性没有。**

3. **`runOnce` 里 `allocRunId` 早于抢车位**。所以排队中的轮次在 DB 里已经是 `running`。**判定：界面失真，日志有「等车位」说明。**

4. **evidence 的搜索是 `String.includes`**。大文件（>2MB）跳过，二进制跳过。**判定：可能被「把答案写进产物」绕过——但那种情况下产物确实存在，不算作弊。**

5. **`spawn.ts` 的超时与正常退出有极窄竞态**：`done` 里已 `clearTimeout`，剩下的是「杀到已复用的 pid」。**判定：概率极低，没有处理。**

### 建议的审计方法

- 先跑 `npm test` 看基线（116 项，1 项 skip 是 Windows 软链权限）
- 用 `node --disable-warning=ExperimentalWarning src/host/cli.ts run --task "x" --dry-run` 看完整提示词（不花钱）
- 真实跑一单最小的：`POST /api/run {"task":"派一条线写一个 3 行 txt"}`，观察 SSE 日志
- 重点找「什么输入能让代码做出错误的决定」，而不是「代码写得对不对」

---

## 11. 规模

| 类别 | 文件 | 行数 |
|---|---:|---:|
| `src/` | 24 | 4418 |
| `tests/` | 13 | 1637 |
| `ui/index.html` | 1 | 2550 |
| `docs/` | 15 | 3539 |
| `prompts/` | 37 | 711 |
| **合计** | **90** | **12855** |

零第三方运行时依赖（`package.json` 里没有 `dependencies`）。Node 24 原生跑 `.ts`（strip-only 类型剥离，不能用参数属性、不能用 enum）。

---

## 12. 附：任务的真实产出（可用于对照）

一次五条产线的任务，实际跑出来是这样（`#21`，38 分钟）：

```
#93  a 主控   206s  拆成 5 条线，派出 b/c/d/e/f
#94  d 地图   252s  done   map_art_standard.md 11693 B
#95  e 武器   480s  FAILED（撞 8 分钟超时）
#96  e 重试   412s  done   weapon_art_standard.md 11706 B
#97  f 建筑   480s  FAILED（又一次）
#98  f 重试   376s  done   building_art_standard.md 14679 B
#99  a 收口    96s  PASS
```

`#95`/`#97` 说明：**并发解决排队，解决不了「活太大」**。8 分钟超时对「写一份完整标准」偏紧，这是已知参数问题，不是架构问题。
