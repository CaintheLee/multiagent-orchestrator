# 换项目指南

> MultiAgent 是**通用编排器**，《示例项目》只是第一个拿它做实验的项目。
> 换一个项目，理论上**不用改源码**，只改配置和素材。本文列清楚要动哪些地方。

## 一、已经参数化的（不用碰代码）

| 项 | 位置 | 说明 |
|---|---|---|
| 项目名 | `agents.toml` → `[project] name` | 对话系统提示会读它 |
| 项目根 | `agents.toml` → `[project] root` | 对话的工作目录、`{{ROOT}}` 占位符 |
| 节点树 | `agents.toml` → `[root]` / `[agent.*]` | 名字、模型、角色、超时、工作区 |
| 可写白名单 | `[root] extra_dirs` | 产物允许落在项目里的哪些目录 |
| 开线策略 | `[spawn]` | 自动授权 / 标准设置 / 默认参数 |
| 协议上限 | `[protocol]` | 摘要与详细要求字数 |

```toml
[project]
name = "示例项目"
root = "D:/YourProject"
```

实测：配成上面这样，对话问「你服务哪个项目」会答「《示例项目》，项目根在 D:/YourProject」——**这两个值是从配置读的，不是写死的**。

## 二、要替换的素材（不换也能跑，但语义会错）

| # | 位置 | 为什么 | 换项目时怎么做 |
|---|---|---|---|
| 1 | `.data/memory/context.md` | 这是**《示例项目》的项目索引**：版本号、进度、硬规格、禁忌全是它 | 重写。至少写：项目在哪、先读哪几份、当前阶段、硬约束 |
| 2 | `.data/memory/lessons.md` | 从打回里提炼的教训，带项目特性 | 清空或重写（`learn` 命令可重新提炼） |
| 3 | `.data/memory/journal.md` | 任务流水，历史项目专属 | 清空 |
| 4 | `.data/memory/talk.md` | 对话记忆 | 清空 |
| 5 | `prompts/anim2d.md`、`model3d.md`、`pixel.md`、`planner.md`、`ta.md` | 正文写死了「《示例项目》的角色动作与特效时序」 | 改成通用描述，或换项目专属版本 |
| 6 | `.data/chat/*.jsonl`、`*.sid` | 上一个项目的对话记录 + CLI 会话 | 清空（否则新项目会读到旧对话） |
| 7 | `.sandbox/` | 上一个任务的工作区 | 可清空（不影响库，但会占磁盘） |

## 三、角色模板怎么处理

`prompts/` 现在 37 个，分两类：

**通用的**（换项目直接能用）：`a1-dispatch`、`a2-exec`、`a3-audit`、`a4-arbiter`、`a5-handoff`、`b1-code`～`b7-crossplat`、`d1-techdoc`、`d2-decision`、`d3-changelog`、`executor`、`planner`

**项目专属的**（写死了《示例项目》）：`anim2d`、`model3d`、`pixel`、`ta`、`planner`（部分）

建议：项目专属模板**不要删**，改正文里的项目名即可。删了之后 `roleExists` 会判定角色不存在，派生时被退回 `executor`。

## 四、换项目的完整步骤

```bash
# 1. 停 hub
# 2. 改配置
#    [project] name / root
#    [root] extra_dirs → 新项目的允许写入目录
#    [agent.*] 的 name / workspace（按新项目的产线划分）
# 3. 换素材
#    context.md 重写（最重要）
#    lessons / journal / talk 清空
#    prompts 里的项目专属模板改正文
#    .data/chat/* 清空
# 4. 起 hub，用一个最小任务验证
```

## 五、目前**不支持**的

| 能力 | 现状 | 说明 |
|---|---|---|
| **一个实例跑多个项目** | ❌ | 一份 `.data` + 一份 `agents.toml` = 一个项目。多项目要开多个实例（改 `MA_PORT` + `MA_DATA_DIR`） |
| 项目级隔离的实践目录 | ❌ | 所有项目共用 `.sandbox/`、`.data/memory/` |
| 项目模板 | ❌ | 没有一个「新建项目」按钮帮你生成骨架 |

如果多项目并存是刚需，正确的做法是**一个项目一个实例**（不同端口 + 不同 `MA_DATA_DIR`），而不是把多项目塞进一份配置——那会让工作区、记忆、任务号全部纠缠。

## 六、判断依据

**什么时候该换项目而不是新建实例**：只有《示例项目》不再用了、要彻底转做别的，才走上面的步骤。

**两个项目要并行**：开两个实例。`MA_PORT=3401 MA_DATA_DIR=D:\ma-other node src/host/server.ts`，配置另存一份。

## 附录：本轮改动（2026-11-21）

| 文件 | 改动 |
|---|---|
| `src/kernel/tree.ts` | 新增 `ProjectInfo` 类型与 `Config.project`；`loadConfig` 读 `[project]`，`saveConfig` 写 `[project]` |
| `src/host/chat.ts` | `CHAT_PROMPT` 里的项目名和根目录改成 `{{PROJECT}}` / `{{ROOT}}` 占位符，运行时注入；`buildChatSystem` 增加项目参数 |
| `src/host/server.ts` | 对话工作目录优先 `project.root`；把项目名/根目录传给 `startChat` |
| `ui/index.html` | 角色分组的兜底名从「游戏美术 · 示例项目」改成「其他角色」 |
| `agents.toml` | 新增 `[project]` 段 |
