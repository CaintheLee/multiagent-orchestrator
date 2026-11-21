// 点对点留言：子 agent 之间直接说话，但由 hub 中转，异步投递，全程留痕。
//
// 三个设计约束（都是为了让「点对点」不破坏现有语义）：
// 1. 不阻塞 —— 发完就走，不等回话。没有等待就没有死锁。
// 2. 不传产物 —— 消息只是文字，产物仍然只能在自己 workspace 里写、在 artifacts 里声明。
// 3. 只在任务内 —— 同一次任务里才能互相发，任务结束消息作废，不会串到别的活上。
import type { DatabaseSync } from 'node:sqlite';

export type Message = {
  id: number;
  taskId: number;
  runId: number | null;
  from: string;
  to: string;
  body: string;
  state: string;
  createdAt: number;
  deliveredAt: number | null;
};

type Row = {
  id: number;
  task_id: number;
  run_id: number | null;
  from_node: string;
  to_node: string;
  body: string;
  state: string;
  created_at: number;
  delivered_at: number | null;
};

function toMessage(r: Row): Message {
  return {
    id: r.id,
    taskId: r.task_id,
    runId: r.run_id,
    from: r.from_node,
    to: r.to_node,
    body: r.body,
    state: r.state,
    createdAt: r.created_at,
    deliveredAt: r.delivered_at,
  };
}

export function addMessage(
  db: DatabaseSync,
  taskId: number,
  runId: number | null,
  from: string,
  to: string,
  body: string,
): number {
  const r = db
    .prepare(
      `INSERT INTO messages (task_id, run_id, from_node, to_node, body, state, created_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
    )
    .run(taskId, runId, from, to, body, Date.now());
  return Number(r.lastInsertRowid);
}

export function listMessages(db: DatabaseSync, taskId: number, limit = 100): Message[] {
  const rows = db
    .prepare('SELECT * FROM messages WHERE task_id = ? ORDER BY id LIMIT ?')
    .all(taskId, limit);
  return (rows as Row[]).map(toMessage);
}

/**
 * 取走某个节点的待收留言，并立刻标成 delivered。
 *
 * 「读 + 标记」放在同一个同步块里：lane 保证同一节点串行，所以不会有两个轮次
 * 同时取走同一条消息。这一轮如果失败，消息不会重投——重复投递比丢一条留言更糟。
 */
export function takeMessages(db: DatabaseSync, taskId: number, node: string): Message[] {
  const rows = db
    .prepare(
      `SELECT * FROM messages
        WHERE task_id = ? AND to_node = ? AND state = 'pending'
        ORDER BY id`,
    )
    .all(taskId, node) as Row[];
  if (!rows.length) return [];

  const mark = db.prepare('UPDATE messages SET state = ?, delivered_at = ? WHERE id = ?');
  const now = Date.now();
  for (const r of rows) mark.run('delivered', now, r.id);
  return rows.map(toMessage);
}

/** 任务结束时把没投出去的消息收掉，免得以后翻记录看到一堆永远 pending 的僵尸 */
export function dropPending(db: DatabaseSync, taskId: number): number {
  const r = db
    .prepare("UPDATE messages SET state = 'dropped', delivered_at = ? WHERE task_id = ? AND state = 'pending'")
    .run(Date.now(), taskId);
  return Number(r.changes);
}
