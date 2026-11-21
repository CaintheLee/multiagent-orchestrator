# MultiAgent · 路径与数据落位说明

> 面向前置审计的说明文档。读者无需了解项目历史，可独立阅读。
> 版本基线：2026-11-21（含当日路径统一改动，见第 9 节）
> 代码位置：`<repo>`

---

## 0. 这份文档怎么用

本文只讲一件事：**数据落在哪、为什么落在那里、错了会怎样**。

审计时按这个顺序读：

1. 第 1 节搞清系统是什么（约 200 字）
2. 第 2 节看路径基准（全系统只有一处定义）
3. 第 3 节查数据落位总表（谁写谁读、丢了什么后果）
4. 第 7 节看已知问题（已分好级，含修复状态）
5. 第 8 节是建议的审计切入点与可复现验证命令

**不需要读源码就能完成前五步**。

---

## 1. 系统是什么

一个**本地运行的多人 Agent 编排台**。人给一个大任务，它由「主控」拆成子任务派给若干条执行线，各自在隔离目录里干活，交回产物与证据，主控验收；不通过就打回重做。

「多人」指多个 AI Agent 进程，不是多用户。系统是单机、单实例、局域网可访问、**无认证**的。

```
                    ┌──────────────┐
   人 ──派活/审批──▶ │  hub (3400)  │ ◀── 浏览器界面（单文件）
                    └──────┬───────┘
                           │ 调度
                    ┌──────▼───────┐
                    │  主控节点 a   │  拆活 / 派活 / 验收
                    └──────┬───────┘
              ┌────────┬───┴───┬────────┐
              ▼        ▼       ▼        ▼
             b        c       d      e/f/setmap …   ← 执行线，各自一个工作区
```

技术栈：Node 24 + TypeScript（无框架，直接跑 `.ts`）+ `node:sqlite` + 单文件 HTML 前端。
外部依赖只有 CLI（`codebuddy`），通过子进程调用。

---

## 2. 路径基准

**全系统只有一个地方算路径**：`src/kernel/paths.ts`。

```ts
export const PKG_ROOT    = <由本文件位置推导>;                 // <repo>
export const DATA_DIR    = MA_HOME || MA_DATA_DIR/.data || PKG_ROOT/.data;
export const CONFIG_FILE = MA_CONFIG || PKG_ROOT/agents.toml;
export const PROMPTS_DIR = PKG_ROOT/prompts;
export const UI_FILE     = PKG_ROOT/ui/index.html;
export const SANDBOX_ROOT= PKG_ROOT;                          // .sandbox 的父目录
```

三个环境变量，优先级从高到低：

| 变量 | 语义 | 典型用途 |
|---|---|---|
| `MA_HOME` | **直接**指定 `.data` 目录 | 换数据位置 |
| `MA_DATA_DIR` | 父目录，代码会自动拼 `.data` | 自动化测试 |
| `MA_CONFIG` | 直接指定 `agents.toml` | 多实例并存 |

**关键性质**：所有路径由模块文件位置推导，**与启动时的工作目录无关**。
从任意目录 `node <repo>\src\host\server.ts` 启动，行为一致。

> 这一条是 2026-11-21 修过的。改之前：界面用模块路径（能打开），其余全用 `process.cwd()`（全指错），导致「页面能开但零任务」的半崩状态。见第 7 节 P0-1。

---

## 3. 数据落位总表

`<PKG_ROOT>` = `<repo>`

| 编号 | 内容 | 位置 | 写入者 | 读取者 | 丢失后果 |
|---|---|---|---|---|---|
| A-1 | 配置（节点树 / 开线策略 / 项目信息） | `<PKG_ROOT>/agents.toml` | 界面保存 / 派生落盘 / 手改 | 几乎所有操作 | **系统不可用**，无法建树 |
| A-2 | 自定义 CLI 适配 | `<PKG_ROOT>/providers.toml` | 手改 | 仅启动一次 | 启动失败（写坏会直接退出） |
| A-3 | 职责模板 | `<PKG_ROOT>/prompts/<role>.md` | 手改 | 每次拼提示词 | 角色退化为通用兜底，**不报错** |
| A-4 | 任务库 | `<DATA_DIR>/hub.db` | 调度层、存储层 | 全部模块 | **历史任务全丢**，进行中任务失联 |
| A-5 | 轮次记录 | `<DATA_DIR>/runs/<id>.json` | 执行层 | 证据核对、事后复盘 | 证据链断裂，无法校验历史结论 |
| A-6 | 轮次日志 | `<DATA_DIR>/logs/<runId>.log` | 执行层 | 界面「任务动态」 | 排错失去第一现场 |
| A-7 | 记忆（4 份） | `<DATA_DIR>/memory/*.md` | 人工 + 自动 | 派活、对话 | 项目背景丢失，Agent 退回「什么都不知道」 |
| A-8 | 对话记录 | `<DATA_DIR>/chat/<node>.{jsonl,sid}` | 对话模式 | 对话面板 | 上下文断裂（有兜底，见第 4 节） |
| A-9 | 任务工作区 | `<PKG_ROOT>/.sandbox/t<taskId>/<node>/` | 执行节点 | 产物归属与越界校验 | 产物归属无法判定 |
| A-10 | 前端 | `<PKG_ROOT>/ui/index.html` | 开发 | HTTP 根路径 | 界面打不开 |
| A-11 | 实例锁 | `hub.db` 的 `hub_lock` 表 | 启动 | 单例检查 | 可能起两个实例同时写库 |

### 隔离性（重要）

| 组合 | 是否互相影响 |
|---|---|
| A-4 库 ↔ A-7 记忆 | **独立**。删库不丢记忆，删记忆不丢任务 |
| A-4 库 ↔ A-8 对话 | **独立**。对话记录不依赖库 |
| A-5 轮次 ↔ A-4 库 | **半依赖**。库里有轮次索引，文件丢了索引还在，但证据读不到 |
| A-9 工作区 ↔ A-4 库 | **依赖**。工作区目录名含 `taskId`，库丢了就无法对应 |

---

## 4. 各信标详解

### A-1 配置 `agents.toml`

三段结构：

```toml
schema = 1

[project]           # 这个实例服务哪个项目
name = "示例项目"
root = "D:/YourProject"   # 干活的项目目录，与 sandbox 根不是一回事

[protocol]          # 协议上限
max_summary = 200
max_detail  = 4000

[spawn]             # 开线（派生）策略
auto_approve = false      # true = 主控自己批，不等人工
defaults_enabled = false  # true = 审批弹窗用下面这套值预填
role = "executor"
model = ""
timeout_min = 30
access = "write"
task_prefix = ""

[root]              # 主控节点
id = "a"
workspace = "a"     # 短名 → 实际落在 .sandbox/t<taskId>/a
extra_dirs = "D:/YourProject\\docs, D:/YourProject\\data, ..."   # 可写白名单

[agent.b]           # 执行线
id = "b"
parent = "a"
workspace = "b"
```

**写入风险**：`saveConfig` 是「读整份 → 改 → 重写整份」。两个写入方并发会互相覆盖。
- 派生落盘（`runner/spawn.ts`）已加串行队列
- 界面保存（`/api/agents`）**未加锁** → 见第 7 节 P1-1

### A-3 职责模板 `prompts/`

37 个模板，文件名即角色 id。派生新线时 role 必须存在于此处：

- 存在 → 模板正文注入提示词，作为该线的行为约束
- **不存在 → 静默退回 `ROLE_FALLBACK`**（通用兜底），不报错、不告警

派生路径已加校验（退回 `executor` 并记日志）；**手工编辑配置写错 role 仍然静默** → 见 P2-1。

模板头部元信息：

```markdown
# 审计（平级 · 只认事实） · PASS/FAIL + 证据，不给建议

> 分组：编排
> 适用：独立复核别人的产物、只判过不过、给出证据、不改任何东西
```

`GET /api/roles` 解析这三行供前端下拉使用。

### A-7 记忆（四份，各管一段）

| 文件 | 写入者 | 内容 | 注入上限 |
|---|---|---|---|
| `context.md` | **人工维护** | 项目索引：当前阶段、先读哪几份、硬规格、禁忌 | 2600 字 |
| `lessons.md` | `learn` 命令提炼 | 历史打回里总结的教训 | 900 字 |
| `journal.md` | 任务转入终态时自动 | 任务流水（取最后一轮摘要） | 800 字，留 40 条 |
| `talk.md` | 对话每轮自动 | 对话摘要 + 用户显式要求记住的内容 | 1000 字，留 60 条 |

**只注入给有下级的节点**（主控、对话）。叶节点执行者不读——设计意图是「执行者只需知道自己这一件事」。

`context.md` 是手写的，**不会自动更新**，是这套系统里最容易腐化的一环。

### A-8 对话

两个文件，职责不同：

| 文件 | 内容 | 谁用 |
|---|---|---|
| `<node>.jsonl` | 完整对话（含生成的任务方案卡） | 界面渲染 |
| `<node>.sid` | CLI 会话 id | 模型上下文 |

**不同步风险**：sid 丢失但 jsonl 仍在时，界面显示「聊过」而模型是全新会话。兜底做法：新建 session 时把最近 6 条摘要拼进系统提示。

### A-9 任务工作区

路径解析规则（`kernel/tree.ts` 的 `resolveWorkspace`）：

| 配置的 workspace | 解析结果 |
|---|---|
| 绝对路径 | 原样使用（兼容旧配置） |
| 短名（1–16 位字母数字下划线连字符） | `<SANDBOX_ROOT>/.sandbox/t<taskId>/<短名>` |
| 含 `/` 或 `..` | **直接抛错** |

第三条是安全边界的核心：防止跑出 sandbox、防止两个节点指向同一目录（那样并发写会互相踩）。

**产物归属判定**（`kernel/settle.ts`）：

| 产物落在 | 结论 |
|---|---|
| 自己的工作区内 | 通过 |
| `extra_dirs` 白名单内 | 通过，并自动复制备份到工作区 `_external/` |
| 两者都不是 | `stray`，**判本轮失败** |
| 收口轮引用下级工作区 | 通过，标记为「引用」不计入自身产物 |

---

## 5. 关键流程中的路径流转

### 派一个任务

```
写库 tasks 行 (A-4)
  → 为每个节点解析工作区 (A-9)
  → 每轮：
      读角色模板 (A-3) + 记忆 (A-7) → 拼提示词
      子进程 cwd = 该节点工作区 (A-9)
      写轮次 JSON (A-5) + 日志 (A-6)
      校验产物归属（对 A-9 与 extra_dirs）
  → 终态：追加 journal (A-7)
```

### 开一条新线（派生）

```
模型申请 spawn
  → 写 approvals 行（等人）
  → 批准后：往 A-1 追加节点段（串行队列）
  → 同一节点也加入本次运行的内存树（否则本轮派活路由不到）
```

### 对话

```
读 A-7 四份记忆 + A-4 任务快照 → 拼系统提示
  → 起 CLI（cwd = project.root，plan 只读模式）
  → 流式写 A-8 jsonl，每轮结束追加 talk.md
```

**只读边界**：对话进程用 `--permission-mode plan`。实测该模式下即使通过 Bash 执行 `echo > file` 也会被拒（见第 8 节可复现命令）。

---

## 6. 依赖方向

```
host (server / cli / chat)
  ├── hub (scheduler)
  ├── runner (runTree / spawn / accept)
  │     ├── kernel (tree / settle / prompt / memory / roles / approval / paths)
  │     ├── protocol (schema / receipt)
  │     └── adapters (codebuddy / codex)
  └── store (db / runs / log / approvals / checkpoints)

kernel/paths  ← 所有模块依赖它，它不依赖任何模块
```

**没有循环依赖**。`protocol` 被所有层依赖，自身只依赖类型定义。

已知结构问题：`host/server.ts` 1305 行，所有 HTTP 路由在一个回调里；`ui/index.html` 约 89 KB 单文件。均为可维护性问题，非功能缺陷。

---

## 7. 已知问题（分级）

### P0 · 已修（2026-11-21）

| 编号 | 问题 | 后果 | 处理 |
|---|---|---|---|
| P0-1 | 路径基准不统一：多数模块用 `process.cwd()`，界面用模块位置 | 从其他目录启动时「页面能开但零任务」，半崩 | 新增 `kernel/paths.ts`，全部由包根推导 |
| P0-2 | `MA_DATA_DIR` 语义是父目录，与名字不符 | 配置直觉错误，易写错 | 新增 `MA_HOME`（直接指向 `.data`），旧变量保留兼容 |
| P0-3 | 对话历史读取引用了未定义的 `HISTORY_KEEP` | 打开对话面板即 `ReferenceError` | 补常量定义，加读取上限 400 条 |
| P0-4 | 并发写 `agents.toml` 会丢节点 | 后写的覆盖前一条新线，配置里消失 | 派生路径加串行队列 |

### P1 · 未修

| 编号 | 问题 | 影响 | 备注 |
|---|---|---|---|
| P1-1 | 配置写入有两条路径，只有派生那条加了锁 | 界面保存与派生并发时仍可能覆盖（外部审计确认 M5，仍开放） | 修复方式：把队列提到公共层 |
| P1-2 | 对话 SSE 补发只保留最近 500 条事件 | 超长回答时，晚打开的页面缺前半段 | 改为按轮次补发 |
| P1-3 | `.data/` 混入测试残留（36 个条目中 29 个非系统文件） | 信标目录不清晰 | 清理 + 测试统一走独立目录 |
| P1-4 | `.sandbox/` 无回收策略 | 磁盘单调增长 | 需定「任务结束后保留多久」 |

### P2 · 未修

| 编号 | 问题 | 影响 |
|---|---|---|
| P2-1 | 手工改配置把 role 写错时，提示词静默退化为通用兜底 | 角色约束失效且无告警 |
| P2-2 | ~~无认证~~ → **已升级为 Critical** | 见下方修订说明 |

---

## 8. 给审计者的建议切入点

### 建议优先审计的四条

| # | 切入点 | 为什么值得看 |
|---|---|---|
| 1 | **产物归属校验** `kernel/settle.ts` | 这是「验收可信」的地基。边界判断写错，所有产物结论都不可信 |
| 2 | **证据核对** `runner/runTree.ts` 的 `evidenceProblem` | 判通过的依据是「结论能在产物里逐字搜到」，属于弱验证，值得质疑其充分性 |
| 3 | **并发与竞态** `runner/spawn.ts`、`hub/scheduler.ts` | 多任务并发 + 写配置文件 + 车位调度，是竞态高发区 |
| 4 | **对话只读边界** `host/chat.ts` 的 `--permission-mode plan` | 声称只读，需验证是否能被绕过 |

### 可复现的验证命令

**路径基准（P0-1 回归）**

```bash
cd C:\ && node <repo>\src\host\server.ts --no-open
curl -s http://127.0.0.1:3400/api/tasks   # 应返回全部历史任务，而不是空数组
curl -s http://127.0.0.1:3400/api/agents  # 应返回 8 个节点
```

**对话只读边界**

```bash
cd D:/YourProject
codebuddy -p "用 Bash 执行 echo hi > D:/YourProject\_probe.txt" \
  --permission-mode plan --tools "Bash" --output-format stream-json
ls D:/YourProject\_probe.txt   # 应不存在
```

**配置并发写**

两个任务同时申请派生，观察 `agents.toml` 是否同时包含两条新线。当前派生路径有队列，界面保存路径没有。

**测试套件**

```bash
cd <repo> && npm test    # 181 项，180 通过 1 跳过
```

---

## 9. 附录：2026-11-21 路径统一改动

| 文件 | 改动 |
|---|---|
| `src/kernel/paths.ts` | **新增**，全项目唯一路径基准 |
| `src/store/db.ts`、`store/log.ts`、`host/chat.ts`、`adapters/models.ts`、`kernel/memory.ts` | 数据目录改用 `DATA_DIR` |
| `src/host/server.ts` | 配置、provider、模板、界面、sandbox、锁共 6 处改引用 |
| `src/host/cli.ts` | 同上 5 处 |

**验证结果**：从 `C:\` 启动，`/api/tasks` 返回 47 条历史任务、`/api/agents` 返回 8 个节点，修复前为 0 条 / 空树。全量测试 181 项通过。

**改动性质**：仅替换路径来源，未改变任何业务逻辑；所有文件读写目标在不设环境变量时与改动前一致（默认 cwd 即包根的场景）。


---

## 10. 第二轮修复（2026-11-21 外部审计后）

外部审计指出初版本文档低估了风险，并发现三处未修完的实质问题。核实后全部属实，已修四条：

| 编号 | 问题 | 修复 |
|---|---|---|
| M1 | 路径统一未完成：`store/runs.ts`、`protocol/prompt.ts`、`kernel/roles.ts`、`runner/spawn.ts`、`host/doctor.ts` 仍在用 `process.cwd()` | 五处全部改用 `paths.ts` |
| M2 | 对话 `reset` 在节点校验前执行，`nodeId="../marker"` 可删聊天目录外的文件 | 加 `CHAT_NODE_RE` 格式校验；`loadConfig` 与节点存在性校验提前到 reset 之前 |
| M4 | 协议允许 8 段，单节点收口上限 6 次且推进不清零 → 7–8 段必然 blocked | 阶段推进时 `reviewRounds.set(n.id, 0)` |
| M6 | 外部产物备份只比文件大小，同尺寸修改会留旧副本 | 改为始终覆盖（`copyFileSync` 幂等） |

### M2 的扩展：不只 reset

审计只提到 `POST /api/chat` 的 reset。核实后发现 `/api/chat/history` 与 `/api/chat/stream` 同样把 `nodeId` 拼进文件路径，能**读**目录外的 `.jsonl`。三处都已加格式校验。

### 验证

| 检查 | 结果 |
|---|---|
| `POST /api/chat {nodeId:"../marker"}` | 400 `nodeId 不合法` |
| `GET /api/chat/history?node=../marker` | 400 `node 不合法` |
| 正常节点 `b` | 200，正常返回 |
| 从 `C://` 启动：`/api/roles` | **37 个**（修复前 0） |
| 从 `C://` 启动：`/api/tasks` | 47 条 |
| 从 `C://` 启动：`/api/tasks/47` 的轮次 | 8 条（修复前 runPath 指向 `C://.data`） |
| `C://.data` 是否被创建 | 否 |
| 全量测试 | **182 项，181 通过 1 跳过**（新增 7 段回归用例） |

### 仍未修（需要设计决策）

| 编号 | 为什么没直接改 |
|---|---|
| C-1 认证 | 需要定 token 怎么发、怎么传（页面参数 / Cookie / 一次性链接），会改变现在的使用方式 |
| C-2 HTML 同源 | 需要定产物预览策略：加 `sandbox` 会禁脚本（部分报表依赖 JS 渲染），改成文本预览会损失可读性 |
| M3 `read` 无效 | 要么实现真正的只读（CLI 没有该能力），要么在界面上移除该选项并拒绝配置 |
| M5 配置队列 | 要把队列从 `runner/spawn.ts` 提到公共层，改动面较大 |

---

## 11. 第三轮修复（2026-11-21 外部审计的第二批）

外部审计的 P0 两条（认证、产物同源）和两条一致性（只读权限、配置队列）本轮全部处理。

### C-1 · 访问令牌

| 项 | 实现 |
|---|---|
| 触发条件 | `MA_HOST` 不是回环地址（`0.0.0.0` 或具体网卡）时启用 |
| 令牌来源 | `MA_TOKEN` > `.data/hub.token` > 首次启动生成 48 位 |
| 传递方式 | `?token=`（种 cookie 后 302 抹掉）、`Cookie: ma_token`、`X-MA-Token` |
| 免令牌 | 回环来源（`127.0.0.0/8`、`::1`、`::ffff:127.0.0.1`） |
| 未授权 | API 返回 401 JSON；页面返回填令牌的表单 |

实测：

| 请求 | 结果 |
|---|---|
| `127.0.0.1:3400/api/health` 无令牌 | **200** |
| `192.168.x.x:3400/api/health` 无令牌 | **401** |
| 同上 + `?token=` | **200** |
| 同上 + `X-MA-Token` | **200** |
| 同上 + 错误令牌 | **401** |
| `192.168.x.x:3400/?token=` | **302 + Set-Cookie，Location: /** |

### C-2 · 产物预览隔离

`.html/.htm/.svg/.xhtml` 一律回 `Content-Security-Policy: sandbox`（不带 `allow-same-origin`），
默认连脚本都不给；人在产物舞台勾「允许脚本」才加 `allow-scripts`，仍不给同源。

实测响应头：

```
Content-Type: text/html; charset=utf-8
X-Content-Type-Options: nosniff
Content-Security-Policy: sandbox; default-src 'none'; style-src 'unsafe-inline'; ...
```

勾选后：`sandbox allow-scripts allow-popups; ...`（无 `allow-same-origin`）。

### M-3 · 只读权限不再伪装

| 环节 | 行为 |
|---|---|
| 节点编辑 / 新建 / 上提 | `access="read"` + 不支持的 provider → **400**，不写配置 |
| 开线标准设置 | 没有任何可只读的节点时 → **400** |
| 派生落盘前 | 直接 **SKIPPED**，不建审批单 |
| 审批弹窗改 access | **400**，不落库 |
| 启动 | 历史配置里有无效 read → 打 `⚠` |
| `doctor` | 报 warn |

`codex` 是唯一支持只读的 provider（`--sandbox read-only`）。

### M-5 · 配置写入统一

新增 `src/kernel/config-lock.ts`：`mutateConfig(file, fn)` 在队列内**重新读最新** → 改 → 写回。
`saveConfig` 的临时文件名改为带 pid + 随机后缀，并发写不会互相 rename 掉。

六个写入点全部改用它：派生落盘、`/api/agents` 更新、`/api/agents/create`、
`/api/agents/promote`、`/api/agents/delete`、`/api/spawn-settings`。

实测：10 个并发 `spawn-settings` + 10 个并发节点 patch，最终状态**两边的改动都在**
（`[spawn] timeout_min = 40`、节点 `b timeout_min = 30`）。

### 测试

| 项 | 数量 |
|---|---|
| 全量 | **191 项，190 通过 1 跳过** |
| 新增 `tests/security.test.ts` | 9 项：令牌三来源 / 回环判定 / 定长比较 / 令牌落盘稳定 / 主动文档识别 / CSP 组合 / 配置并发 20 写不丢 / 跨 cwd 子进程路径不变 |

`8 段计划`回归用例从 7 段扩到协议上限 8 段，仍然 `done`。

### 本轮未做

| 项 | 原因 |
|---|---|
| `tsc --noEmit` | 本机没有 `typescript` 依赖，离线装不了；补 typecheck 需要先决定是否引入 devDependencies |
| 轮询 IO 优化（SQLite 存摘要） | 属于结构性重构，改动面大，单独一轮做 |
| 千轮任务的 json 全量读 | 同上 |

### m-1 · 轮询 IO（部分修）

| 改动 | 效果 |
|---|---|
| `src/store/run-cache.ts` | 轮次 json 按 `path + mtime + size` 缓存解析结果；1000 轮的任务不再每 4 秒读 1000 个文件 |
| `chat.ts` 的 `chatHistory` | 只读文件尾部 256KB，丢掉第一行半截；几 MB 的历史不再全量读 + 全量 split |

实测 `/api/tasks/47`（8 轮）连续两次：**1.4ms / 2.8ms**。

未做：用 SQLite 存展示摘要、按领域拆 `server.ts`——属于结构性重构，不在本轮范围。
