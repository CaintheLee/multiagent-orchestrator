// 派生审批：模型想临时新开一条产线，得先过人这一关。
//
// 为什么不是「模型自己加节点就完了」：开一条线就是一次完整的多轮调用，
// 成本和时间都由提出请求的那个模型决定，但付账的是人。所以必须有人点头。
//
// 审批是阻塞式的：提出请求的轮次停在这里等，等人点批准/拒绝，或者等到超时。
// 超时按拒绝处理——默认安全，不能因为没人看就放行。
import type { DatabaseSync } from 'node:sqlite';

export type ApprovalState = 'pending' | 'approved' | 'rejected' | 'expired';

export type Approval = {
  id: number;
  taskId: number;
  runId: number | null;
  kind: string;
  payload: Record<string, unknown>;
  state: ApprovalState;
  createdAt: number;
  decidedAt: number | null;
  note: string;
};

type Row = {
  id: number;
  task_id: number;
  run_id: number | null;
  kind: string;
  payload: string;
  state: string;
  created_at: number;
  decided_at: number | null;
  note: string | null;
};

function toApproval(r: Row): Approval {
  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(r.payload) as Record<string, unknown>;
  } catch {
    // 存进去的是我们自己序列化的，解不开就按空对象处理，不让一条坏数据卡住审批列表
  }
  return {
    id: r.id,
    taskId: r.task_id,
    runId: r.run_id,
    kind: r.kind,
    payload,
    state: r.state as ApprovalState,
    createdAt: r.created_at,
    decidedAt: r.decided_at,
    note: r.note ?? '',
  };
}

export function addApproval(
  db: DatabaseSync,
  taskId: number,
  runId: number | null,
  kind: string,
  payload: Record<string, unknown>,
): number {
  const r = db
    .prepare(
      `INSERT INTO approvals (task_id, run_id, kind, payload, state, created_at)
       VALUES (?, ?, ?, ?, 'pending', ?)`,
    )
    .run(taskId, runId, kind, JSON.stringify(payload), Date.now());
  return Number(r.lastInsertRowid);
}

export function getApproval(db: DatabaseSync, id: number): Approval | null {
  const row = db.prepare('SELECT * FROM approvals WHERE id = ?').get(id) as Row | undefined;
  return row ? toApproval(row) : null;
}

/** 默认只列还没处理的：界面每几秒拉一次，已决的没必要重复传 */
export function listApprovals(db: DatabaseSync, state: ApprovalState | 'all' = 'pending'): Approval[] {
  const rows = state === 'all'
    ? db.prepare('SELECT * FROM approvals ORDER BY id DESC LIMIT 50').all()
    : db.prepare('SELECT * FROM approvals WHERE state = ? ORDER BY id').all(state);
  return (rows as Row[]).map(toApproval);
}

/**
 * 落一个决定。只有 pending 能被改——重复点击、两个窗口同时点，
 * 第二次会返回 false，调用方据此判断「这一票是不是我投的」。
 */
export function decideApproval(
  db: DatabaseSync,
  id: number,
  state: Exclude<ApprovalState, 'pending'>,
  note = '',
): boolean {
  const r = db
    .prepare(
      `UPDATE approvals SET state = ?, decided_at = ?, note = ?
        WHERE id = ? AND state = 'pending'`,
    )
    .run(state, Date.now(), note, id);
  return Number(r.changes) > 0;
}

/** 任务被取消/进程重启时，把该任务还挂着的审批单收掉，避免界面永远显示「待审批」 */
export function expirePending(db: DatabaseSync, taskId: number, note: string): number {
  const r = db
    .prepare(
      `UPDATE approvals SET state = 'expired', decided_at = ?, note = ?
        WHERE task_id = ? AND state = 'pending'`,
    )
    .run(Date.now(), note, taskId);
  return Number(r.changes);
}
