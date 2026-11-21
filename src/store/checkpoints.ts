// 任务状态快照：每个节点一行，记「它现在是什么状态、手上有什么产物」。
//
// 为什么不是从 runs 推导：续跑以前是 `SELECT MAX(id) ... GROUP BY node_id` 再回头读
// 那一轮的 json 文件。两个问题——最后一轮可能是收口轮（artifacts 为空），
// 读文件又会因为文件丢了/坏了少一条。快照把状态直接固化下来，续跑只读一行。
import type { DatabaseSync } from 'node:sqlite';
import type { Artifact, Stray } from '../protocol/schema.ts';

export type Checkpoint = {
  taskId: number;
  nodeId: string;
  runId: number;
  /** done / blocked / failed / canceled */
  state: string;
  /** ''（工作轮） / pass / rework */
  verdict: string;
  summary: string;
  question: string;
  /** 这个节点累计交出来的产物（同一路径只留一份） */
  artifacts: Artifact[];
  /** 它写过、但没通过校验的文件（越界/备份失败/不存在）。失败也要留档 */
  stray: Stray[];
  updatedAt: number;
};

type Row = {
  task_id: number;
  node_id: string;
  run_id: number;
  state: string;
  verdict: string | null;
  summary: string | null;
  question: string | null;
  artifacts: string | null;
  stray: string | null;
  updated_at: number;
};

function toCheckpoint(r: Row): Checkpoint {
  let artifacts: Artifact[] = [];
  try {
    const v = JSON.parse(r.artifacts || '[]') as Artifact[];
    if (Array.isArray(v)) artifacts = v;
  } catch {
    // 坏 JSON 就当没有产物：宁可少列一条，不要让续跑整个 500
  }
  let stray: Stray[] = [];
  try {
    const v = JSON.parse(r.stray || '[]') as Stray[];
    if (Array.isArray(v)) stray = v;
  } catch {
    // 同上：坏 JSON 不能把整次查询带崩
  }
  return {
    taskId: r.task_id,
    nodeId: r.node_id,
    runId: r.run_id,
    state: r.state,
    verdict: r.verdict ?? '',
    summary: r.summary ?? '',
    question: r.question ?? '',
    artifacts,
    stray,
    updatedAt: r.updated_at,
  };
}

/**
 * 落一份快照。产物按路径合并：同一个节点先写文件、再跑收口轮（不写文件），
 * 直接覆盖会把产物抹掉——那样续跑又会变成「这个节点什么都没交」。
 *
 * run_id 只增不减：并发的旧轮次晚到也不能把新状态盖回去。
 */
export function saveCheckpoint(
  db: DatabaseSync,
  taskId: number,
  rec: {
    id: number;
    node: string;
    state: string;
    verdict?: string;
    summary: string;
    question?: string;
    artifacts: Artifact[];
    /** 本轮写了但没通过的文件。这一列不累计：它描述的是「这一轮写了什么」 */
    stray?: Stray[];
  },
): void {
  const prev = db
    .prepare('SELECT artifacts FROM checkpoints WHERE task_id = ? AND node_id = ?')
    .get(taskId, rec.node) as { artifacts: string } | undefined;

  const merged = new Map<string, Artifact>();
  let old: Artifact[] = [];
  try {
    const v = JSON.parse(prev?.artifacts || '[]') as Artifact[];
    if (Array.isArray(v)) old = v;
  } catch {
    // 上一行坏了就只留这一轮的产物，不让一次解析失败打断整轮
  }
  for (const a of old) if (a?.path) merged.set(a.path, a);
  // 新的一轮覆盖同名路径：文件被改写过，字节数该更新
  for (const a of rec.artifacts) if (a?.path) merged.set(a.path, a);

  db.prepare(
    `INSERT INTO checkpoints (task_id, node_id, run_id, state, verdict, summary, question, artifacts, stray, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(task_id, node_id) DO UPDATE SET
       run_id     = excluded.run_id,
       state      = excluded.state,
       verdict    = excluded.verdict,
       summary    = excluded.summary,
       question   = excluded.question,
       artifacts  = excluded.artifacts,
       stray      = excluded.stray,
       updated_at = excluded.updated_at
     WHERE excluded.run_id >= checkpoints.run_id`,
  ).run(
    taskId,
    rec.node,
    rec.id,
    rec.state,
    rec.verdict ?? '',
    rec.summary ?? '',
    rec.question ?? '',
    JSON.stringify([...merged.values()]),
    JSON.stringify(rec.stray ?? []),
    Date.now(),
  );
}

/** 一次任务的全部快照，按节点名排序，方便直接展示 */
export function listCheckpoints(db: DatabaseSync, taskId: number): Checkpoint[] {
  const rows = db
    .prepare('SELECT * FROM checkpoints WHERE task_id = ? ORDER BY node_id')
    .all(taskId) as Row[];
  return rows.map(toCheckpoint);
}
