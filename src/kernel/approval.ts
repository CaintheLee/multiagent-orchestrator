// 审批等待：提出请求的轮次停在这里，直到人点批准/拒绝，或者等到超时。
//
// 为什么是轮询而不是事件：审批可能来自另一个浏览器标签、另一次页面刷新，
// 甚至用户直接改数据库。轮询数据库是唯一不会漏掉决定的做法，代价是 1 秒延迟。
import type { DatabaseSync } from 'node:sqlite';
import { decideApproval, getApproval, type ApprovalState } from '../store/approvals.ts';

/**
 * 等人最多等这么久。超时按拒绝处理——没人看就不能放行。
 *
 * 从 10 分钟降到 3 分钟：审批阻塞的是「整轮派活」，主控这一轮派给现有线的活
 * 会陪着这条审批一起等（#47：5 条活空等，车位全空）。宁可早点按拒绝继续跑，
 * 也不要让十几条活陪着一条审批干等十分钟。
 */
export const APPROVAL_TIMEOUT_MS = 3 * 60_000;

/** 一次任务里最多派生几个。超过就得先清掉不再需要的线 */
export const MAX_SPAWN_PER_TASK = 3;

export type Decision = Exclude<ApprovalState, 'pending'> | 'canceled';

export async function waitApproval(
  db: DatabaseSync,
  id: number,
  signal: AbortSignal | undefined,
  timeoutMs = APPROVAL_TIMEOUT_MS,
  pollMs = 1000,
): Promise<Decision> {
  const start = Date.now();
  for (;;) {
    if (signal?.aborted) {
      // 任务被取消时把单子收掉，否则界面上会一直挂着一条永远等不到人的审批
      decideApproval(db, id, 'expired', '任务被取消');
      return 'canceled';
    }

    const row = getApproval(db, id);
    if (!row) return 'expired';
    if (row.state !== 'pending') return row.state;

    if (Date.now() - start > timeoutMs) {
      // 只有还是 pending 才写得进去；如果刚好同时有人点了批准，这一票仍然算数
      const won = decideApproval(db, id, 'expired', `等了 ${Math.round(timeoutMs / 60000)} 分钟没人处理，按拒绝算`);
      if (won) return 'expired';
      return (getApproval(db, id)?.state ?? 'expired') as Decision;
    }

    await new Promise((r) => setTimeout(r, pollMs));
  }
}
