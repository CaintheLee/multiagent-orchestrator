# 安全边界

> 对象：`<repo>`（本地多 Agent 编排台）
> 最后更新：2026-11-21
> 这份文档回答一个问题：**谁能驱动这套东西，驱动到什么程度。**

## 0. 它为什么需要边界

这个服务不是只读面板。一个 `POST /api/run` 就会：

1. 在 `.sandbox/t<id>/<节点>/` 下起一个 CLI 进程；
2. 那个进程带着**当前 Windows 用户的权限**读写文件、跑命令；
3. 消耗模型额度。

所以「谁能访问 3400 端口」等价于「谁能用这台机器的账号干活」。

## 1. 三条边界

| 编号 | 边界 | 实现位置 | 默认状态 |
|---|---|---|---|
| B1 | 网络入口 | `kernel/auth.ts` + `host/server.ts` 开头 | 只绑 `127.0.0.1`，不对外开放 |
| B2 | 产物预览 | `kernel/preview.ts` + `/api/artifact` | 主动文档一律 `CSP: sandbox`，默认禁脚本 |
| B3 | 只读权限 | `adapters/table.ts` + `runner/spawn.ts` | 做不到只读的 provider 拒绝 `access="read"` |

### B1 · 访问令牌

- **绑回环**（默认 `MA_HOST=127.0.0.1`）：不启用令牌。本机就是唯一入口。
- **对外监听**（`MA_HOST=0.0.0.0` 或具体网卡）：启用令牌。
  - 令牌来源：`MA_TOKEN` 环境变量 > `.data\hub.token` > 首次启动生成 48 位随机值。
  - 传递方式：`?token=`（首次打开页面，种 cookie 后 302 去掉地址栏里的令牌）、
    `Cookie: ma_token`（页面内后续请求，含 SSE 与 iframe）、`X-MA-Token`（脚本）。
  - **回环来源免令牌**：`127.0.0.0/8`、`::1`、`::ffff:127.0.0.1`。
    理由：令牌文件就在本机，能读它的人本来就有等价权限。
  - 未授权请求：API 返回 401 JSON；页面返回一个填令牌的表单，不是白屏。

启动时会打印带令牌的完整地址：

```
MultiAgent 界面：http://127.0.0.1:3400
  局域网（IP）：http://192.168.x.x:3400/?token=xxxx
  访问令牌：xxxx
```

### B2 · 产物预览

产物是模型写的 HTML，里面有脚本。**同源 iframe 直接渲染等于把 hub 的 API 交给它**：
一个 `fetch('/api/run')` 就能派活，`esc()` 只管拼进页面的字符串，管不了主动渲染的文档。

现在 `/api/artifact` 对 `.html/.htm/.svg/.xhtml` 一律回：

```
Content-Security-Policy: sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data:
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
```

- `sandbox`（不带 `allow-same-origin`）让文档跑在**不透明源**里：
  读不到 cookie，`Origin` 是 `null`，写接口的 Origin 校验会拒掉它。
- 默认**不给脚本**。需要 JS 渲染的报表，人在产物舞台勾「允许脚本」，
  服务端才加 `allow-scripts`——仍然不给 `allow-same-origin`。
- 「新窗口」打开同一个 URL，同样受这些头约束。

### B3 · 只读权限

`access="read"` 只有在 provider 真的能只读时才有意义：

| provider | 只读实现 | 可用 |
|---|---|---|
| codex | `exec --sandbox read-only` | ✅ |
| codebuddy | 无（`read` 与 `write` 生成相同参数） | ❌ |
| claude / gemini | 未声明 | ❌ |

做不到的 provider：

- 配 `access="read"` → 服务端 400，不写配置；
- 已存在的历史配置 → 启动时打 `⚠` 警告，`doctor` 报 warn；
- 派生申请里写 read → 直接 SKIPPED，不建审批单；
- 审批弹窗里把 access 改成 read → 400，不落库。

**不再有「界面写着只读、实际全权限」这种状态。**

## 2. 配置写入的一致性（不是安全，但会丢数据）

`agents.toml` 是「读整份 → 改 → 重写整份」。两条路径同时写，后写的会拿旧快照覆盖。

所有写配置的入口现在都走 `kernel/config-lock.ts` 的 `mutateConfig()`：
队列内**重新读最新**、改完写回。临时文件名带 pid + 随机后缀，不会互相踩。

覆盖的入口：派生落盘、节点增删改、主控上提、开线设置保存。

## 3. 目录穿越

`nodeId` 会被拼进 `.data/chat/<id>.jsonl`。`/api/chat`、`/api/chat/history`、
`/api/chat/stream` 三处都先过 `^[A-Za-z0-9_-]{1,32}$`，
`../marker` 这类值返回 400。

## 4. 仍然开放的风险

| # | 风险 | 为什么没关 | 怎么缓解 |
|---|---|---|---|
| R1 | 拿到令牌的人可以派活、起 CLI | 这就是产品功能本身 | 只在可信网络开；令牌当密码管；不用时绑回环 |
| R2 | 产物预览勾了「允许脚本」后，脚本仍能执行 | 部分报表依赖 JS | 不透明源 + Origin 校验挡住写接口；不勾就完全禁 |
| R3 | 没有用户体系，只有一把令牌 | 单机工具，不需要账号 | 需要多人时前面挂反代做认证 |
| R4 | 令牌走明文 HTTP | 局域网内没上 TLS | 敏感环境用 SSH 隧道或反代加 TLS |
| R5 | `MA_HOST` 设成具体网卡地址时，回环判断依然生效 | 有意为之 | 与绑 0.0.0.0 等价，都会启用令牌 |

## 5. 自检清单

```bash
# 1. 默认只绑回环：外部打不开
netstat -ano | findstr :3400          # 应显示 127.0.0.1:3400

# 2. 对外监听时无令牌应 401
curl -s -o /dev/null -w "%{http_code}\n" http://<本机IP>:3400/api/health

# 3. 本机免令牌应 200
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3400/api/health

# 4. 产物预览必须带 CSP
curl -sI "http://127.0.0.1:3400/api/artifact?path=<某个 html>" | findstr /i content-security

# 5. 只读配置应被拒
curl -s -X POST http://127.0.0.1:3400/api/agents -H "Content-Type: application/json" \
  -d "{\"id\":\"b\",\"patch\":{\"access\":\"read\"}}"
```

前四条对应 `tests/security.test.ts` 里的用例；第五条依赖运行中的实例。

## 6. 变更记录

| 日期 | 改动 | 原因 |
|---|---|---|
| 2026-11-21 | 新增令牌鉴权 | 外部审计 C-1：LAN 无认证可远程驱动本地 Agent |
| 2026-11-21 | 产物预览加 CSP sandbox | 外部审计 C-2：同源 iframe 让产物拿到 Hub 全部 API |
| 2026-11-21 | 拒绝无效的 `access="read"` | 外部审计 M3：codebuddy 的 read 与 write 参数相同 |
| 2026-11-21 | 配置写入统一走 `mutateConfig` | 外部审计 M5：只有派生那条路排队，其余仍会覆盖 |
