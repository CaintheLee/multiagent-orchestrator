# 文档索引

先读 [`CURRENT.md`](./CURRENT.md)：那是「现在是什么样」。其余文档分三类，看之前先确认时效。

## 现行（描述当前实现，改动后要同步）

| 文档 | 内容 |
|---|---|
| [`CURRENT.md`](./CURRENT.md) | 现状速览：能力、启动方式、边界、质量基线 |
| [`architecture-v2.md`](./architecture-v2.md) | 七层结构与一次任务的生命周期 |
| [`lane-concurrency.md`](./lane-concurrency.md) | 车道 + 车位池的并发模型 |
| [`p2p-messages.md`](./p2p-messages.md) | 点对点留言（异步投递） |
| [`resume-and-memory.md`](./resume-and-memory.md) | 续跑与三份记忆 |
| [`cost-design.md`](./cost-design.md) | 成本可见性与防失控 |
| [`audit-package.md`](./audit-package.md) | 给外部审计用的代码地图与已知取舍 |

## 参考（设计与调研，不是现状承诺）

| 文档 | 内容 |
|---|---|
| [`hub-migration-plan.md`](./hub-migration-plan.md) | 从单机脚本迁到 hub 的初版方案（已被 v2 取代） |
| [`hub-migration-plan-v2.md`](./hub-migration-plan-v2.md) | 迁移方案第二版 |
| [`hub-progress.md`](./hub-progress.md) | 迁移期进度记录 |
| [`autoswarm-拆解.md`](./autoswarm-拆解.md) | 同类项目 AutoSwarm 的拆解笔记 |

## 历史（只读，记录当时发生了什么）

`audit-2026-11-14.md`、`audit-2026-11-15.md`、`audit-2026-11-15-hub.md`、`audit-2026-11-16.md`、`audit-fixes-2026-11-16.md`。

这些是审计与修复的当时记录，**不代表现在的代码**。要引用其中的结论，先回代码确认。

## 写文档的规矩

1. **新文档放 `docs/`，文件名就是主题**，不要带版本号。版本号靠 git 历史，不靠文件名。
2. **审计/修复记录一律写 `history/YYYY-MM-DD-主题.md`**，写完不再改。发现记错了，在文末追加「后续变更」，不静默覆盖。
3. **历史文档不搬动**：`history/` 从 2026-11-16 启用，之前的审计记录留在 `docs/` 原位（搬会断掉外部引用），在本索引里标记为历史即可。
4. **不把文档站的历史版本放进主仓**：见过同类项目用 `docs/v1.10.0 … v1.14.6` 存每个版本的文档，仓库因此涨到 747MB、文档接近一千万行。版本化交给站点构建或 git tag。
5. **`CURRENT.md` 是唯一承诺**：其他文档与它冲突时，以 `CURRENT.md` 和代码为准，并顺手改文档。
