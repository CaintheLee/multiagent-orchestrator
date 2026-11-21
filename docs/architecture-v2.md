# MultiAgent 架构设计 v2

> 依据：autoloop 的分层与「内核只收只分只派只记」，autoswarm 的表驱动适配与原子发布，以及这两天实测出来的约束。
> 目标：在**不重写**现有逻辑的前提下，把 7 个扁平文件演进成可扩展的分层结构。

---

## 一、三条设计依据

| 来源 | 学什么 | 不学什么 |
|---|---|---|
| **autoloop** | 内核只收/只分/只派/只记；事实日志是唯一状态；协议是产品 | 10 层过度分层（它的 801 行 decide.ts 就是分层过度的结果） |
| **autoswarm** | provider 表驱动；records 原子发布；task/result 分离；Skill 入口写死 argv | ACP 双向协议（codebuddy 这边不通）；Electron 壳 |
| **我们的实测** | `-p` 模式能跑；codebuddy 一轮 30–200 秒；打回必须三段式；收口要看产物原文 | — |

**一句话**：抄结构，不抄体量。

---

## 二、分层与依赖

```
┌─────────────────────────────────────────────┐
│ host          server.ts / cli.ts            │  只做入口，不含业务
└───────────────────┬─────────────────────────┘
                    ↓
┌─────────────────────────────────────────────┐
│ runner        runTree.ts                    │  派活→执行→交付→收口
└───────────────────┬─────────────────────────┘
                    ↓
┌─────────────────────────────────────────────┐
│ kernel        tree.ts / settle.ts           │  只分、只判，不做 IO
└──────────┬────────────────────┬─────────────┘
           ↓                    ↓
┌──────────────────┐  ┌──────────────────────┐
│ adapters         │  │ store                │
│ table.ts/spawn.ts│  │ runs.ts / log.ts     │
└──────────┬───────┘  └──────────┬───────────┘
           ↓                     ↓
┌─────────────────────────────────────────────┐
│ protocol      schema / receipt / prompt     │  契约，唯一真源
└─────────────────────────────────────────────┘
```

**依赖规则**（用测试守）：

| 从 | 只能到 |
|---|---|
| host | runner、store |
| runner | kernel、adapters、store、protocol |
| kernel | protocol |
| adapters | protocol |
| store | protocol |

**禁止**：kernel 里出现产品名（codebuddy/codex）、发 HTTP、读文件；adapters 里出现业务流程。

---

## 三、模块职责

| 模块 | 文件 | 只做这件事 | 行数上限 |
|---|---|---|---|
| protocol | `schema.ts` | 字段名、长度上限、允许的枚举 | 80 |
| | `receipt.ts` | 把 stdout 变成 Receipt，或说清为什么不行 | 120 |
| | `prompt.ts` | 把 (节点, 任务, 下级) 变成提示词 | 90 |
| kernel | `tree.ts` | 读 agents.toml，回答「谁是父、谁是子」 | 110 |
| | `settle.ts` | 产物校验：存在、在工作区内、字节数 | 60 |
| store | `runs.ts` | 公账：一轮一文件，原子写，列表 | 90 |
| | `log.ts` | 私账：每轮完整输出，只追加 | 40 |
| adapters | `table.ts` | PROVIDERS 表：bin / args / stdin | 70 |
| | `spawn.ts` | 起进程、收输出、超时杀 | 80 |
| runner | `runTree.ts` | 递归：派活、收口、三段式打回 | 200 |
| host | `server.ts` | HTTP + SSE | 130 |
| | `cli.ts` | 参数解析 + 输出 | 100 |

合计约 1170 行，比现在的 1155 行多 15 行——**分层不增加代码量**。

---

## 四、一轮的完整路径

```
cli/server  收到任务
   ↓
runner.runTree(cfg, node, task, log)
   ↓
   ├─ protocol.prompt.build()        拼提示词（含下级列表、回执格式）
   ├─ adapters.table.get(plugin)     取 bin/args/stdin 策略
   ├─ adapters.spawn()               起进程（codex 走 stdin，codebuddy 走 argv）
   ├─ protocol.receipt.parse()       解析回执，失败给原因
   ├─ kernel.settle.artifacts()      产物校验（存在 / 归属 / 字节）
   ├─ store.runs.save()              公账落盘（原子）
   ├─ store.log.append()             私账全文落盘
   └─ 有 dispatch → 递归跑下级
        ↓
      下级交回 → 拼 brief（原始任务 + 实际内容）→ 再跑上级一轮
        ↓
      verdict: pass / rework（rework 时 dispatch 必须三段式）
```

---

## 五、目录结构

### 现状（7 个文件）

```
src/
├── config.ts     110 行   TOML + 节点树
├── protocol.ts   160 行   提示词 + 回执 + 产物校验
├── adapters.ts    85 行   codex / codebuddy
├── store.ts       75 行   一轮一文件
├── runner.ts     210 行   派活-收口
├── server.ts     150 行   HTTP + SSE
└── cli.ts        100 行   命令行
```

### 目标（13 个文件，5 层）

```
src/
├── protocol/
│   ├── schema.ts      字段与上限
│   ├── receipt.ts     回执解析
│   └── prompt.ts      提示词拼装
├── kernel/
│   ├── tree.ts        节点树（config.ts 改名 + 瘦身）
│   └── settle.ts      产物校验
├── store/
│   ├── runs.ts        公账
│   └── log.ts         私账
├── adapters/
│   ├── table.ts       PROVIDERS 表
│   └── spawn.ts       进程管理
├── runner/
│   └── runTree.ts     派活-收口
└── host/
    ├── server.ts
    └── cli.ts
```

---

## 六、迁移步骤（四步，每步可回滚）

| 步 | 做什么 | 验证 | 风险 |
|---|---|---|---|
| **1** | `adapters.ts` 拆成 `table.ts` + `spawn.ts`，`if/else` 换成表 | `check` 通过、跑一轮成功 | 低 |
| **2** | `store.ts` 拆成 `runs.ts` + `log.ts`，补私账 | 跑一轮后 `runs/00xx.log` 存在 | 低 |
| **3** | `protocol.ts` 拆成三件，函数签名不变 | 12 个测试全过 | 中（改的是高频路径） |
| **4** | `config.ts` → `kernel/tree.ts`，`settle` 独立 | `check` 通过 | 低 |

**每步一个 commit，跑不通就 `git reset`。**

---

## 七、关键决策记录

| 决策 | 为什么 | 代价 |
|---|---|---|
| **公账私账分离** | 模型只看摘要（省 token），人排查看全文 | 每轮多写一个文件 |
| **公账不存索引文件** | 索引独立存会与明细不一致；运行时扫目录永远一致 | 轮次上千后扫描变慢（那时加只追加的缓存） |
| **provider 用表，不用 if/else** | 加 CLI 不改代码 | 表本身要维护 |
| **不进 kernel 的东西：HTTP、文件、产品名** | 内核可以被单测覆盖，不依赖环境 | 要在 host/adapters 里多写一层 |
| **收口必须带产物原文** | 实测老板只看摘要会放过不合格（14.8 秒判 PASS） | brief 变长（最多 1200 字符） |
| **打回必须三段式** | 「不行重做」等于没反馈 | 提示词变长 |
| **不做 ACP** | codebuddy 的 ACP stdio 不通 | 每轮冷启动，慢 |

---

## 八、护栏

| 测试 | 守什么 |
|---|---|
| `tests/protocol.test.ts` | 回执字段、长度上限、产物归属（12 项，已有） |
| `tests/purity.test.ts` | kernel 里不许 import adapters/host、不许出现产品名 |
| `tests/store.test.ts` | 一轮一文件、坏文件只丢一条、旧格式迁移 |

---

## 九、本期落地范围

今晚只做**第 1 步**（provider 表驱动），因为它：

- 风险最低（不动业务逻辑）
- 收益最直接（加 Claude Code 只加一行）
- 可验证（跑一轮就知道）

第 2–4 步留到明天，按上表顺序。
