# MultiAgent

本地多 Agent 编排台：派一件事给主控，它拆活、分给子线、收口验收，产物自动落到磁盘，全程可查、可停、可续。

不是"全自动做项目"，是**你做判断，它做执行，每一步留证据**。

## 要求

- Windows（开发与实测环境；核心是 Node，其它平台未验证）
- Node **>= 22.6**（直接跑 `.ts`，靠原生类型剥离，无构建步骤）
- 至少一个可用的 CLI provider（`codex` / `codebuddy` / `claude` / `gemini`；内置表在 `src/adapters/table.ts`，可用根目录的 `providers.toml` 追加自定义）

## 快速开始

```bash
npm run check                 # 校验 agents.toml、prompt、工作区
npm run doctor                # 环境自检：Node、provider 路径、端口、模型
npm run serve                 # 起管理台（默认 http://127.0.0.1:3400）

# 也可以在界面里派活；命令行派活是：
npm run run -- --node b --task "在工作区写一个 hello.html"
```

Windows 下双击 `start.cmd` 起本机版；`start-lan.cmd` 对外开放（会启用访问令牌，地址打印在窗口里）。

## 它是怎么跑的

```
人 → 主控 a ──派活──> b / c / d / e / f …（各在自己的工作区跑 CLI）
        ↑                    │
        └──── 回执 + 证据 ───┘
              │
         收口验收：产物归属、字节数、证据能否逐字回查
              │
     通过 → 结束；不通过 → 打回重跑
```

几条硬规则：

- 每轮必须给**回执块**（`summary` / `artifacts` / `evidence` …），格式不对这一轮就 `failed`，不猜不兜底
- 产物必须落在自己的工作区（或配置的 `extra_dirs`），否则判越界
- 主控收口要拿证据；证据在轮次产物里逐字搜不到就判 `rework`
- 一个任务可以自己分 2–8 段，引擎按段推进，全部跑完才算结束

## 目录

| 路径 | 管什么 |
|---|---|
| `src/kernel/` | 配置解析、路径基准、派生规则、验收与产物归属、记忆 |
| `src/protocol/` | 回执契约、提示词拼装、解析与校验 |
| `src/runner/` | 单轮执行、阶段推进、路由、收口 |
| `src/host/` | HTTP 服务、CLI、对话模式、doctor |
| `src/store/` | SQLite（任务/轮次/审批/消息）、日志、轮次缓存 |
| `src/adapters/` | 各家 CLI 的参数与只读能力 |
| `ui/index.html` | 单文件管理台（无框架、无构建） |
| `prompts/` | 职责模板，`<role>.md`，开线时从这里选 |
| `docs/` | 设计与审计文档，入口见下 |

## 安全

默认**只绑 127.0.0.1**。这个服务能建任务、能起 CLI，等于把当前用户的 shell 递出去，所以：

- 对外监听（`MA_HOST=0.0.0.0`）时强制访问令牌；本机回环免令牌
- 产物预览给模型写的 HTML 加 `CSP: sandbox`，默认禁脚本，跑在不透明源里
- `access="read"` 只在 provider 真有只读模式时才允许（目前只有 `codex`）

细节与自检命令：`docs/SECURITY.md`。

## 测试

```bash
npm test        # 191 项，190 通过 1 跳过
npm run eval    # 能力评估
```

## 文档

| 文档 | 内容 |
|---|---|
| `docs/SECURITY.md` | 三条安全边界、令牌流程、仍开放的风险 |
| `docs/PATH_BEACONS.md` | 路径基准、数据落位、已知问题 |
| `docs/CHAT_TO_TASK.md` | 对话模式：从自然语言到任务方案 |
| `docs/SPAWN_POLICY.md` | 开线（派生）审批、参数、职责模板 |
| `docs/PORTING.md` | 换一个项目用它要改什么 |
| `docs/AUDIT_MULTIAGENT_2026-11-21.md` | 外部审计结论与逐条处理 |

## 已知局限

- **一个实例服务一个项目**：一份 `agents.toml` + 一份 `.data`。要并行两个项目就起两个实例（不同 `MA_PORT` / `MA_HOME`）
- 对话模式绑 `codebuddy`，且是只读（plan 模式），不能直接改文件
- 目前没有用户体系，只有一把访问令牌
- `server.ts` 仍是单文件多路由，HTTP 层测试覆盖有限

## 状态

个人项目，正在用《示例项目》做第一个实战项目；目标是通用的编排器，项目相关的内容都在配置和 `prompts/` 里，不在代码里。

## 许可证

MIT，见 [LICENSE](./LICENSE)。
