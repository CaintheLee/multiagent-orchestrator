// 调度器：从队列认领任务、并发执行、可取消。
// 状态以数据库为准，内存里只放「正在跑的 AbortController」——那东西没法持久化。
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { loadConfig, nodeById } from '../kernel/tree.ts';
import type { Semaphore } from '../kernel/pool.ts';
import { runTree } from '../runner/runTree.ts';
import { setTaskState } from '../store/db.ts';
import { expirePending } from '../store/approvals.ts';
import { appendJournal } from '../kernel/memory.ts';
import { dropPending } from '../store/messages.ts';

export type ClaimedTask = {
  id: number;
  master: string;
  task: string;
};

export type SchedulerOpts = {
  db: DatabaseSync;
  root: string;
  maxConcurrent: number;
  /** 全机共用车位：任务级并发和任务内的车道并发共用同一个池，避免两层叠乘 */
  pool: Semaphore;
  onLog: (taskId: number, line: string) => void;
  onState: (taskId: number, state: string) => void;
};

const TICK_MS = 400;

export class Scheduler {
  private active = new Map<number, AbortController>();
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;

  private opts: SchedulerOpts;

  constructor(opts: SchedulerOpts) {
    this.opts = opts;
  }

  start(): void {
    this.reconcile();
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.tick();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    // 停服务时把在跑的都取消，避免留孤儿
    for (const [, ac] of this.active) ac.abort();
  }

  /** 只停止领新任务，正在跑的不动——用来做「等这批跑完再退出」 */
  drain(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
  }

  /** 运行中的任务数，给 /api/health 看 */
  inflight(): number[] {
    return [...this.active.keys()];
  }

  /** 并发上限，界面上要显示「3/3」这类占用比 */
  limit(): number {
    return this.opts.maxConcurrent;
  }

  cancel(taskId: number): boolean {
    const ac = this.active.get(taskId);
    if (!ac) return false;
    // 先标 cancelling：进程退出前任务状态不能直接跳 canceled
    try {
      setTaskState(this.opts.db, taskId, 'cancelling');
      this.opts.onState(taskId, 'cancelling');
    } catch {}
    // 取消时把还挂着的派生审批收掉，否则界面会一直显示待审批
    try {
      expirePending(this.opts.db, taskId, '任务被取消');
    } catch {}
    ac.abort();
    return true;
  }

  /**
   * 启动对账。上次进程没活到今天，running/cancelling 都成了「不知道跑没跑完」。
   * 不自动重试：会重复计费，且崩溃原因可能就是它。
   */
  private reconcile(): void {
    const rows = this.opts.db
      .prepare("SELECT id FROM tasks WHERE state IN ('running','cancelling')")
      .all() as Array<{ id: number }>;
    // 注意：不能在这里提前 return——轮次清理也要跑，
    // 历史僵尸（任务早结束、轮次还挂着 running）不需要任务侧有变化
    const now = Date.now();
    const upd = this.opts.db.prepare(
      "UPDATE tasks SET state = 'interrupted', updated_at = ?, error_code = 'hub_restart', error_message = ? WHERE id = ?",
    );
    for (const r of rows) {
      upd.run(now, '上次进程退出时这个任务还在跑，没有结果', r.id);
      this.opts.onState(r.id, 'interrupted');
    }
    // 只改任务不改轮次，runs 表里会留一堆 running 的僵尸。
    // 这条同时能清掉历史上已经卡住的那种：任务早结束了，轮次还挂着。
    const fixed = this.opts.db
      .prepare(
        `UPDATE runs SET state = 'interrupted'
          WHERE state IN ('running','cancelling')
            AND task_id IN (SELECT id FROM tasks WHERE state NOT IN ('running','cancelling'))`,
      )
      .run();
    // 重启后没人等的审批单也是僵尸：提出它的进程已经不在了
    const expired = this.opts.db
      .prepare("UPDATE approvals SET state = 'expired', decided_at = ?, note = ? WHERE state = 'pending'")
      .run(now, 'hub 重启，这条审批没人等了');
    if (expired.changes) this.opts.onLog(0, `对账：${Number(expired.changes)} 条待审批作废`);

    if (rows.length || Number(fixed.changes)) {
      this.opts.onLog(
        0,
        `对账：${rows.length} 个任务改成 interrupted，${Number(fixed.changes)} 个轮次收场`,
      );
    }
  }

  private tick(): void {
    if (this.stopped) return;
    while (this.active.size < this.opts.maxConcurrent) {
      const task = this.claim();
      if (!task) return;
      void this.run(task);
    }
  }

  /** 单条语句完成「选一个 + 标记」，两个调度循环同时跑也不会抢到同一个 */
  private claim(): ClaimedTask | null {
    const now = Date.now();
    const row = this.opts.db
      .prepare(
        `UPDATE tasks
            SET state = 'running',
                started_at = COALESCE(started_at, ?),
                updated_at = ?
          WHERE id = (
            SELECT id FROM tasks WHERE state = 'queued' ORDER BY created_at LIMIT 1
          )
          RETURNING id, master, task`,
      )
      .get(now, now) as ClaimedTask | undefined;
    return row ?? null;
  }

  private async run(task: ClaimedTask): Promise<void> {
    const ac = new AbortController();
    this.active.set(task.id, ac);
    this.opts.onState(task.id, 'running');
    const log = (line: string) => this.opts.onLog(task.id, line);

    try {
      const cfg = loadConfig(path.join(this.opts.root, 'agents.toml'));
      const node = nodeById(cfg, task.master);

      // 用户可能在排队期间取消：认领后先看一眼信号
      if (ac.signal.aborted) {
        setTaskState(this.opts.db, task.id, 'canceled');
        this.opts.onState(task.id, 'canceled');
        return;
      }

      const rec = await runTree(cfg, node, task.task, log, {
        db: this.opts.db,
        taskId: task.id,
        root: this.opts.root,
        signal: ac.signal,
        pool: this.opts.pool,
        // 配置里的运行上限：0 表示不限，交给引擎在轮次边界自己判
        limits: cfg.limits,
      });

      // 取消可能停在两轮之间（那时 rec 是 null），要认 signal 而不是 null
      const finalState = !rec
        ? ac.signal.aborted
          ? 'canceled'
          : 'failed'
        : rec.state === 'done'
          // 验收判了 rework 就是没过：以前只看 state，补验两次都核不上也会记成 done
          ? (rec.verdict === 'rework' ? 'failed' : 'done')
          : rec.state === 'canceled'
            ? 'canceled'
            // blocked 是「它在提问、等人回答」，不是失败。以前一律折成 failed，
            // 界面上看着像挂了，实际是主控在等你补需求。
            : rec.state === 'blocked'
              ? 'blocked'
              : 'failed';
      setTaskState(this.opts.db, task.id, finalState, {
        errorCode: rec && rec.state !== 'done' ? rec.state : undefined,
        // 卡住时把「它在问什么」留在任务上：界面的续跑弹窗要显示这句话，
        // 只写「卡住，等回答」等于让人重新去翻日志
        errorMessage: rec?.question || rec?.error,
      });
      this.opts.onState(task.id, finalState);
      // 任务结束了，还没投出去的留言跟这个任务一起作废，别留一堆永远 pending 的僵尸
      try { dropPending(this.opts.db, task.id); } catch {}

      // 记一笔流水：只写已有事实，零成本，供下次派活时注入。
      // 用本地时间——toISOString 是 UTC，人在日志里看到差 8 小时会以为记错了。
      // 内容取「最后一轮摘要」而不是任务正文开头：正文开头往往是「【你的身份】你是某个项目的主控…」
      // 这种通用提示词，几十条流水长得一模一样，等于没记。
      const now = new Date();
      const pad = (n: number) => String(n).padStart(2, '0');
      const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
      let what = task.task;
      try {
        const cp = this.opts.db.prepare(
          "SELECT summary FROM checkpoints WHERE task_id = ? AND summary <> '' ORDER BY updated_at DESC LIMIT 1",
        ).get(task.id) as { summary: string } | undefined;
        if (cp?.summary) what = cp.summary;
      } catch {}
      appendJournal(
        `${stamp} · #${task.id} `
        + `${finalState === 'done' ? '完成' : finalState === 'blocked' ? '卡住等回答' : '未完成'} · `
        + what.replace(/\s+/g, ' ').slice(0, 80),
      );
      log(`[task #${task.id} 结束：${finalState}]`);
    } catch (e) {
      // 任何异常都要落终态，否则任务永远挂 running，槽位也回不来
      const msg = String(e).slice(0, 500);
      try {
        setTaskState(this.opts.db, task.id, 'failed', { errorCode: 'exception', errorMessage: msg });
        // 抛异常时占位行还没有结论，留着就是僵尸
        this.opts.db
          .prepare("UPDATE runs SET state = 'failed' WHERE task_id = ? AND state = 'running'")
          .run(task.id);
        this.opts.onState(task.id, 'failed');
      } catch {}
      log(`[task #${task.id} 异常：${msg}]`);
    } finally {
      this.active.delete(task.id);
      // 让出一帧再补位，避免递归加深调用栈
      setImmediate(() => this.tick());
    }
  }
}
