# 审计修复记录（2026-11-16）

> 对应审计报告的 4 条 P0、8 条 P1、1 条 P2、2 条异议。逐条说明：是否成立、怎么改、为什么。

---

## P0-1 深层畸形 JSON 让解析器抛异常【成立】

**问题**：`receipt.ts` 的错误分支用 `raw: JSON.stringify(item)`。模型给一个上万层嵌套的对象，`JSON.parse` 能过，但 `JSON.stringify` 抛 `RangeError: Maximum call stack size exceeded`。异常越过正常的失败返回，`finishRun` 不执行，那条 run 永远停在 `running`。

**修改**：新增 `safeRaw(v, max=800)`，`try/catch` 包住序列化，失败返回 `[无法序列化]`，超长截断。7 处调用全部替换。

**验证**：手工拼 12000 层嵌套 JSON（`arepeat` 拼字符串，避免测试自己先爆栈），解析返回 `ok=false`、`raw="[无法序列化]"`，不抛异常。

---

## P0-2 验收核的是主控自己的产物【成立，最严重的一条】

**问题**：`evidenceProblem(ev, ok)` 里的 `ok` 来自 `checkArtifacts(parsed.receipt, n)`，`n` 是主控。主控验收轮通常 `artifacts: []`（它不写文件），于是 `evidenceProblem` 第一行 `if (!artifacts.length) return []` 直接返回——**「判 pass 必须给证据」从未真正生效过**。

**修改**：
- `runOnce` / `runOne` / `step` 增加 `reviewArtifacts` 参数
- 收口前汇总下级产物：`const childArtifacts = results.flatMap(r => r.ok && r.value ? r.value.artifacts : [])`
- 验收时用它：`evidenceProblem(parsed.receipt.evidence, reviewArtifacts ?? ok)`
- 补验分支同样改用 `reviewArtifacts`

**为什么这样改而不是别的**：验收的对象本来就是「下级交上来的东西」，主控自己这一轮写不写文件与验收无关。参数往下传比在 `runOnce` 里查 DB 更直接，也不引入新的 IO。

---

## P0-3 审批的是 `spawn.task`，执行的是 `dispatch.task`【成立】

**问题**：用户在审批单上看到「写说明书」并点了批准，但实际执行的是 `dispatch` 里那条任务的文本。批的和做的可以完全不是一件事。

**修改**：
- `applySpawns` 返回 `Map<name, task>`，记录「人批准的那个 task」
- 路由构建时覆盖：`routed.push(forced !== undefined ? { ...d, task: forced } : d)`，并打日志说明
- **批准了却没在 dispatch 里派活的，补一条**——点头就意味着同意做这件事，不能因为模型忘了写 dispatch 就白批

**取舍**：审计建议「找不到对应 dispatch 则拒绝执行」，我改成「补一条」。理由：批准这个动作本身表达了「同意执行这件事」，拒绝执行会让用户白点一次；而执行文本已经强制用审批单里的，不存在偷换。

---

## P0-4 第二个 hub 会把第一个的活任务对账成 interrupted【成立】

**问题**：`scheduler.start()` 在 `listen()` 之前，而 `start()` 第一件事是 `reconcile()`——把库里所有 `running` 改成 `interrupted`。第二个进程启动时即使端口冲突，对账已经发生。更糟的是端口冲突会自动换端口继续跑，于是两个 hub、两套调度器、一份库。

**修改**（三处）：
1. 新增 `.data/hub.lock` 单例锁，写 pid；启动时若锁里的 pid 还活着就直接退出；pid 不在则视为僵尸锁清掉
2. 端口冲突**不再自动换端口**，直接 `exit(1)`——换端口等于默许两个 hub 同时活
3. `scheduler.start()` 移进 `listening` 回调：**拿到端口之后才碰数据库状态**

**验证**：第二个实例输出「已经有 hub 在跑（pid 42772）。本进程退出，不动那边的任务。」，锁文件未被误删。

**一个实现细节**：`process.on('exit')` 只在**成功拿到锁之后**才注册，否则启动失败退出时会把别人的锁删掉。

**后续（同日第二轮审计）**：锁文件实现已被替换。`unlink` 前再读 pid 仍是 TOCTOU——两个进程同时读到同一个死 pid，A 删旧建新，B 随后把 A 的新锁删掉，双 hub 复现。现在改用 `hub_lock` 表一行认领（主键唯一 + 条件 DELETE 回收），`.data/hub.lock` 只在启动时清理一次，不再参与互斥。

---

## P1-5 补验仍 rework，任务却记 done【成立】

**问题**：`scheduler` 的终态映射只看 `rec.state === 'done'`。补验两次都核不上时，`rec` 是 `{state:'done', verdict:'rework'}`——流程走完了，但结论是没过。

**修改**：`(rec.verdict === 'rework' ? 'failed' : 'done')`；`cli.ts` 同步，并加 `errorCode='rework'`。

---

## P1-6 「打回三次」守卫没接到实际链上【成立，是我上一轮改出来的】

**问题**：改成 `guard(thisRun.filter(r => r.node === n.id))` 之后，叶节点只能看到自己的记录。而叶节点工作轮的 `verdict` 永远是空，带 `rework` 的是**父节点**的验收轮。于是叶节点的 `reworks` 永远为 0，两条防返工规则全部失效。

**修改**：`guard.ts` 新增 `reworkTimes(runs, parent, child)`——按「谁打回谁」统计；`runTree` 在路由前检查 `times >= MAX_REWORK` 就写 SKIPPED 报告、不再派。

**保留 `guard()` 原逻辑**：全局的打回次数与「同一段话」判定仍然兜底，两者不冲突。

---

## P1-7 工作区隔离可被配置绕过【成立】

**问题**：`resolveWorkspace` 里「含 `/` 或 `\` 就原样返回」，于是 `workspace = "../escape"` 能跑出 `.sandbox`，`./x` 指向 cwd 下任意位置，两个节点还能配同一个目录——lane 按节点串行，实际却在并发写同一份文件。

**修改**：短名必须匹配 `^[a-z0-9][a-z0-9_-]{0,15}$`；绝对路径仍然允许（兼容老配置）；其余一律抛错并给出正确写法。`workspaceIsIsolated` 同步改。

**验证**：新增 3 条测试，`../escape`、`./here`、`a/b`、`a\b`、`.`、`..`、20 个 a、`a b` 全部被拒。

---

## P1-8 等车位的轮次不响应取消【成立】

**问题**：`pool.acquire()` 没有 signal，取消后排队的轮次必须等前面全部跑完才轮到它检查 `aborted`，期间任务一直挂 `cancelling`。

**修改**：`acquire(signal?)`，abort 时从 `waiters` 删除并 reject；`release` 把车位交给队首时若发现已 aborted，转交下一个。`runTree` 用 `holding` 标记「真拿到车位才还」，避免 acquire 失败时把池撑大。

**验证**：新增测试——车位占满后 acquire、20ms 后 abort，断言 reject `/canceled/` 且 `busy()` 不变。

---

## P1-9 `/api/run` 没有请求体上限【成立】

**问题**：`readJson` 加了 8MB 上限，但 `/api/run` 用的是自己写的 `for await` 循环，没有上限。9MB 的 body 能在检查「任务 2 万字」之前吃光内存。

**修改**：删掉专用循环，改用 `readJson(req)`，超限抛错 → 400。

**验证**：9MB body → `400 {"error":"请求体超过 8388608 字符"}`，服务存活。

---

## P1-10 stdout 只留前 4MiB，末段回执必丢【成立】

**问题**：`if (out.length < MAX_STDOUT) out += chunk` —— 超过 4MiB 后**丢弃后续**。回执在输出末尾，等于把结论扔掉，然后触发「没有找到回执块」的自动重试，白跑一次高价调用。

**修改**：滚动窗口，保留**末尾**两倍上限，收尾时裁到一倍。

**取舍**：滚动截断会让超长输出的**开头**丢失，但回执只可能在末尾，这个取舍是对的。

---

## P1-11 blocked 没有回答出口【成立】

**问题**：首轮提问 → 任务 blocked，但没有任何接口能提交回答；续跑接口在「没有已成功轮次」时直接 400。这个状态实际是死路。

**修改**：续跑接受 `answer`：
- 有 answer 时允许零历史产物
- answer 写进新任务正文，标题「我对你上次提问的回答（按这个继续，不要再问一遍）」
- 两样都没有才 400

---

## P1-12 只有回环地址，挡不住网页触发的写操作【成立但需分级】

**问题**：只绑 `127.0.0.1` 挡不住浏览器。恶意页面可以用简单请求打过来，能否得手取决于浏览器的私有网络策略。

**修改**：所有写方法（非 GET/HEAD）检查 `Origin` 头：本机来源放行，其他 403。**不发 Origin 的（脚本、curl）照常放行**——这是本地工具，不能用需要密钥的方案把 CLI 也堵死。

**没做的**：审计建议的「每次启动生成随机令牌」。它对自动化脚本不友好，而 `Origin` 检查已经覆盖浏览器场景。如果将来要开放局域网访问，令牌是必须的。

**验证**：恶意 Origin → 403；本机 Origin → 放行；无 Origin → 放行。

---

## P2 状态集合不一致【成立】

**修改**：`audit-package.md` §5 补上 `runs.state='interrupted'`、`tasks.state='timed_out'`、`tasks.state='cancelling'`，并注明由谁写入。

---

## 异议 1：budget 竞态【审计对，我错】

**我的说法**：「多条 lane 同时读旧值，可能多跑一两轮」。

**审计的反驳**：`guard()` 与 `budget--` 之间没有 `await`，JS 单线程内其他 lane 不可能插入。

**我接受**。这是我把「并发」误当成「并行」的典型错误。同时「只扣派活轮」的措辞也不准确——代码是 `if (!review) budget -= 1`，对所有工作轮（含不派活的叶节点）都扣。文档已改成「只扣工作轮」。

---

## 异议 2：evidence 空文本时是 vacuous pass【成立，已显式化】

**问题**：`verifyEvidence` 在「所有产物都是二进制/大文件/读不到」时返回 `[]`，被理解成「证据全中」。

**修改**：新增 `hasTextArtifacts(artifacts)`；`runTree` 在「没有 miss 但也没有可核对文本」时记一条 warning：

> 产物没有可核对的文本（二进制或读不到），这一轮的 evidence 校验实际被跳过

**没有改成判失败**：纯图片产物确实无法用原文核对，判失败会死循环。但至少不再是静默通过——日志和 `warnings` 里都留了痕。

---

## 测试

| 项 | 数量 |
|---|---|
| 总用例 | 105 |
| 通过 | 104 |
| 跳过 | 1（Windows 无文件软链权限） |
| 新增 | 6 条（深层 JSON、workspace 拒绝、reworkTimes、acquire 取消、隔离判定、非法短名） |

---

## 还没修的（明确记录）

1. **`config_snapshot` 存了不读**——未完成特性，不是 bug。
2. **`debug:true` 可指定子节点**——界面「单独跑它」按钮依赖它，是设计。
3. **收口时长 = 最慢那条**——调度语义，不是缺陷。
4. **`server.ts` 843 行、`runOnce` 200 行**——结构问题，改动风险大于收益，等下一轮。

---

## 实测记录（P0-2 的证据链终于接通了）

任务 #33，一条线写 3 行文本：

```
#141 a 主控   35s  派 b
#142 b 执行  168s  写出 r_fix.txt
     a 收口：拿到 1 份交付（1 个产物）   ← 修复前这里永远是 0，证据检查空转
#143 a 收口   45s  REWORK
     证据核不上：「这一轮有产物，但一条 evidence 都没给」
     证据核不上，要求重读产物再判一次（补验 1/1）
#144 a 补验   34s  PASS
#33 done 282s
```

**修复前后的差别**：以前主控写一句「验收通过」就能过；现在它必须给出两条能在 `r_fix.txt` 里逐字搜到的原文，否则判 rework 并补验一次。

**代价**：收口轮可能多跑一次（本例多 34 秒）。这是「按证据验收」的真实成本，不是我引入的额外开销——之前只是没在执行。

---

## 修的过程中自己引入又修掉的一个 bug

P0-2 的 `childArtifacts` 最初写在 `if (list.length)` 块外，用了块内的 `results`：

```
ReferenceError: results is not defined
```

任务 #32 因此异常收场（scheduler 的 catch 把它记成 failed，没有留下僵尸）。已改成外层 `let childArtifacts: Artifact[] = []` + 块内赋值。

**这条值得记**：改动核心链路时，作用域错误不会在 `node --check` 或单元测试里暴露，只有真跑一次才会炸。以后改 `runTree` 必须跟一次真实任务。
