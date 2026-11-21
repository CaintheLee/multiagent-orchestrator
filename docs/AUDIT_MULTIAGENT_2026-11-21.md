# MultiAgent 代码审计报告

> 审计对象：`<repo>`（Node + TypeScript + 单文件前端）
> 审计时间：2026-11-21
> 审计范围：近两周新增/修改的模块——对话模式、开线策略、多段任务、界面
> 审计方式：Web 前端脚本 + 静态扫描粗筛 + 人工逐文件回读 + 实际运行验证

---

## 总评

**没有发现能直接导致数据损坏或远程执行的 Critical 级漏洞，但发现 1 个会导致功能不可用的确定性 bug，以及 3 个在特定条件下会丢数据/泄漏的问题。**

最值得注意的一点：那个会导致对话面板直接崩掉的 bug，是**我在审计当天的改动中自己引入的**——批量替换脚本没有校验命中就报成功。这说明问题出在流程，不在代码本身。

| 级别 | 数量 | 已修 | 未修 |
|---|---|---|---|
| Critical | 1 | 1 | 0 |
| Major | 3 | 3 | 0 |
| Minor | 4 | 0 | 4 |
| Nit | 1 | 0 | 1 |

---

## 一、Critical（已修）

### C-1 · `HISTORY_KEEP` 只被使用、没有定义

- **位置**：`src/host/chat.ts:68`（使用点）
- **现象**：`.slice(-HISTORY_KEEP)` 引用了未定义的常量
- **触发**：任何一次 `GET /api/chat/history` 请求
- **后果**：`ReferenceError`，**打开对话面板即崩**，历史与发送全部不可用
- **成因**：用内联脚本做字符串替换，目标未命中但脚本仍输出 `ok`；改了使用点、没改定义
- **修复**：补 `const HISTORY_KEEP = 400;`，并实测 `chatHistory('a')` 返回 8 条正常
- **教训**：批量替换必须校验命中数量，为 0 应报错退出（见末尾建议）

## 二、Major（已修）

### M-1 · 并发写 `agents.toml` 会丢节点

- **位置**：`src/runner/spawn.ts` 的落盘段
- **现象**：`loadConfig → 检查重名 → push → saveConfig`，`saveConfig` 是**整份重写**
- **触发**：两个任务同时申请开线（车队上限 3，完全可能）
- **后果**：后写的以旧快照为准，覆盖前一条新线。节点在运行树里可用，但配置文件里消失，下个任务报"节点不存在"
- **修复**：加模块级串行队列 `configWriteQueue()`；队列链上吞错避免卡死，但把真实结果返回调用方，保证失败日志能打出来

### M-2 · 对话历史文件无上限

- **位置**：`src/host/chat.ts` 的 `chatHistory()`
- **现象**：`.data/chat/<node>.jsonl` 只追加不截断；读取时全量 `split + JSON.parse`
- **触发**：长期使用，几千条之后
- **后果**：每次切换节点都要解析整个文件，界面越来越顿
- **修复**：读取时只取最近 400 条（`slice(-HISTORY_KEEP)`）

### M-3 · SSE 订阅表泄漏

- **位置**：`src/host/chat.ts:130`
- **现象**：退订时只 `set.delete(res)`，空 `Set` 留在 `subs` 里
- **触发**：前端传入不存在的节点名，或反复订阅不同 id
- **后果**：每个错误 id 永久占用一个空 Set
- **修复**：`if (!set.size) subs.delete(nodeId)`

## 三、Minor（未修，记录在案）

| # | 位置 | 问题 | 影响 | 建议 |
|---|---|---|---|---|
| m-1 | `src/host/server.ts`（1305 行） | 所有路由塞在一个请求回调里 | 定位困难，改动互相影响 | 按领域拆：tasks / chat / config / approvals |
| m-2 | `ui/index.html`（约 89 KB 单文件） | 全部前端逻辑在一个 `<script>` | 同上，且无法做模块级测试 | 至少按功能拆成几个 `<script>` 或独立文件 |
| m-3 | `src/host/chat.ts` SSE 补发 | 只留最近 500 条事件 | 超长回答时，晚打开的页面缺前半段 | 补发改成「本轮 start 标记 + 最后 N 条」 |
| m-4 | 全局 | **hub 无认证**，监听 `0.0.0.0` | 同网段任何人可派活、开线、改设置（含 `autoApprove`） | 加 token 或限制回环地址 |

## 四、Nit

| # | 位置 | 问题 |
|---|---|---|
| n-1 | `src/runner/spawn.ts` | `MIN_SPAWN_WHY` 被 export，但只用于日志提示，容易被误读为硬校验 |

## 五、已验证正确（排除项）

这几条是重点怀疑过、实测没问题的，列出来避免以后重复排查：

| 检查项 | 结论 | 证据 |
|---|---|---|
| **plan 模式是否真只读** | ✅ 成立 | 实测让它用 Bash 执行 `echo hello > _readonly_probe.txt`，被拒，文件未生成 |
| ~~前端 XSS~~ | ❌ **结论作废** | `esc()` 只保护拼进页面的字符串；**主动预览的 HTML 产物以同源 iframe 执行，脚本可调 Hub API**（外部审计 C-2）。此处原结论不成立 |
| **审批 patch 并发** | ✅ 安全 | 两窗口同时批准：第一个 `UPDATE ... WHERE state='pending'` 成功，第二个影响 0 行 → 409 |
| **阶段推进幂等** | ✅ 正确 | `phases_done` 去重，同一段重复判过不会重复推进 |
| **记忆路径回退** | ✅ 生效 | cwd 找不到 `memory` 时退回项目根并打日志，不再静默返回空 |
| **配置写入失败** | ✅ 不阻塞任务 | 写 `agents.toml` 失败只记日志，本次任务内节点仍可用 |

## 六、架构观察

```
src/
├── adapters/     CLI 适配层（codebuddy / codex 的差异都关在这里）
├── kernel/       纯逻辑：树、提示词、结算、记忆、角色、审批
├── protocol/     回执协议与解析（模型输出契约）
├── runner/       执行：runTree、spawn、accept
├── store/        持久化：db、runs、approvals、checkpoints
├── hub/          调度：任务队列、车位
└── host/         HTTP 入口（server 1305 行，最重）
```

**分层是清楚的**：kernel 不依赖 host，store 只管读写，runner 编排 kernel + adapter。
问题集中在最外层两处：`host/server.ts` 和 `ui/index.html`——它们是"什么都往里加"的位置。

**依赖方向正确**，没有循环依赖。`protocol` 被所有层依赖，它自己只依赖 types，合理。

## 七、测试覆盖

- 总数 **181 项**（180 通过，1 跳过）
- 覆盖重点：多层树的产物归属、打回与补验、派生审批、阶段推进、产物越界、证据逐字核对
- **覆盖盲区**：
  - `src/host/chat.ts` 只有手工验证，**无自动化测试**（C-1 这类错本可被一条用例拦住）
  - `ui/index.html` 仅有 4 条源码断言（检查关键函数存在），无行为测试
  - `server.ts` 路由层无测试

## 八、建议

### 立刻做

**给 `chat.ts` 补最小测试**（优先级最高）

C-1 那种"常量未定义"用一条用例就能拦住：

```ts
test('对话历史能读出来', () => {
  assert.doesNotThrow(() => chatHistory('a'));
});
```

**加一个批量替换校验脚本**

这次事故的根因是"脚本报成功但没命中"。建议 `scripts/patch-check.mjs`：所有批量替换必须走它，替换数量为 0 直接非零退出。

### 有空再做

1. 拆 `server.ts`（1305 行 → 按领域 4 个文件）
2. hub 加 token 认证（哪怕只是启动时随机生成、打印在控制台）
3. SSE 补发改为按轮次

### 不建议现在做

- 拆 `ui/index.html`：它现在是单文件可直接打开、无构建步骤，拆了会引入构建复杂度。**等它真的影响改动效率再拆**。

---

## 附：本次修改清单

| 文件 | 改动 |
|---|---|
| `src/host/chat.ts` | 补 `HISTORY_KEEP`；`chatHistory` 只取最近 400 条；SSE 退订时清理空 Set |
| `src/runner/spawn.ts` | 加 `configWriteQueue` 串行写配置 |

均通过全量测试（181 项），hub 已重启验证接口正常。


---

## 九、外部审计复核（2026-11-21 补记）

外部审计对本文档提出两处纠正，均成立：

1. **「前端 XSS 无风险」错误**：`esc()` 防的是字符串注入，防不了「把模型产出的 HTML 当页面渲染」。后者是同源 iframe，等价于让产物拿到 Hub 的全部 API 权限。
2. **「无认证」定为 Minor 过轻**：它不是界面暴露，是权限边界缺失——远程请求可驱动本地 CLI 以当前用户身份读写文件。

同时外部审计发现三处本文档未覆盖的实质缺陷（路径未统一、对话目录穿越、7–8 段任务必阻塞），已核实并修复，详见 `PATH_BEACONS.md` 第 10 节。

---

## 十、审计发现处理结果（2026-11-21 收口）

外部审计共 2 条 Critical、6 条 Major、3 条 Minor。逐条状态：

| 编号 | 发现 | 状态 | 落点 |
|---|---|---|---|
| C1 | LAN 无认证，可远程驱动本地 Agent | **已修** | `kernel/auth.ts`、`host/server.ts` 入口令牌校验；`docs/SECURITY.md` §1 |
| C2 | 不可信 HTML 以同源 iframe 执行 | **已修** | `kernel/preview.ts`；`/api/artifact` 回 `CSP: sandbox`；UI 增加「允许脚本」开关 |
| M1 | 路径统一未完成（5 处 `process.cwd()`） | **已修** | `store/runs.ts`、`protocol/prompt.ts`、`kernel/roles.ts`、`runner/spawn.ts`、`host/doctor.ts` 全部改用 `paths.ts` |
| M2 | 对话 reset 目录穿越 | **已修** | 三处（`/api/chat`、`/history`、`/stream`）加 `CHAT_NODE_RE` |
| M3 | `access="read"` 无只读效力 | **已修** | 6 个入口拒绝无效 read；`supportsReadOnly()`；启动与 doctor 告警 |
| M4 | 7–8 阶段任务必被阻塞 | **已修** | 阶段推进时重置收口计数；8 段回归用例 |
| M5 | 配置写队列只覆盖派生 | **已修** | `kernel/config-lock.ts` 的 `mutateConfig()`，六个写入点统一；临时文件名唯一 |
| M6 | 同尺寸修改留旧备份 | **已修** | `settle.ts` 去掉「大小相同就跳过」，始终覆盖 |
| m1 | 同步 IO 随历史增长 | **部分修** | 轮次 json 加解析缓存（`store/run-cache.ts`）、对话历史改读尾部；SQLite 摘要与拆 `server.ts` 仍未做 |
| m2 | 测试盲区与结构债务 | **部分修** | 新增 `tests/security.test.ts`（9 项）；`server.ts` 仍 1300+ 行 |
| m3 | 无 typecheck、依赖未固定 | **未修** | 本机无 `typescript` 依赖，离线无法安装；需先决定是否引入 devDependencies |

### 验证摘要

- 全量测试 **191 项，190 通过 1 跳过**
- 令牌：回环 200 / LAN 无令牌 401 / 带令牌 200 / 错误令牌 401
- 产物：`CSP: sandbox`（默认无脚本），勾选后 `sandbox allow-scripts`，始终无 `allow-same-origin`
- 只读：`POST /api/agents {access:"read"}` → 400；开线设置 read → 400
- 配置并发：20 个并发写，节点与设置两处改动都保留
- 跨 cwd：子进程在临时目录启动，`DATA_DIR / CONFIG_FILE / PROMPTS_DIR` 与父进程一致

### 仍然开放

- R1 拿到令牌的人可以派活、起 CLI——这是产品功能本身，靠网络边界与令牌管理兜
- 令牌走明文 HTTP：局域网内没上 TLS，敏感环境用 SSH 隧道或反代
