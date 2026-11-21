// 持久化基座：任务、轮次、事件三张表。
// 关键约束：轮次 id 由这里分配，不再扫目录取最大值——那是并发撞号的根源。
// 历史记录必须显式带 id 导入，否则 AUTOINCREMENT 从 1 开始会覆盖 0001.json。
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import type { RunRecord } from './runs.ts';
import type { Phase } from '../protocol/schema.ts';
import { DATA_DIR } from '../kernel/paths.ts';

// 路径基准统一在 kernel/paths.ts：换目录启动也不会指错地方
const DATA = DATA_DIR;
const DB_FILE = path.join(DATA, 'hub.db');
const RUNS = path.join(DATA, 'runs');
const LOGS = path.join(DATA, 'logs');

/** v1 的历史轮次没有任务概念，全部挂在一条保留任务下 */
export const LEGACY_TASK = 1;

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS tasks (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  master              TEXT    NOT NULL,
  task                TEXT    NOT NULL,
  state               TEXT    NOT NULL DEFAULT 'queued',
  error_code          TEXT,
  error_message       TEXT,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  started_at          INTEGER,
  ended_at            INTEGER,
  cancel_requested_at INTEGER,
  config_snapshot     TEXT    NOT NULL,
  client_request_id   TEXT    UNIQUE,
  -- 续跑链：这个任务是接着哪个任务跑的。NULL 表示原始任务
  parent_task_id      INTEGER,
  -- 阶段计划（JSON 数组）与已完成阶段（JSON 数组）：主控自己分段，引擎按顺序推进
  plan                TEXT,
  phases_done         TEXT
);

CREATE TABLE IF NOT EXISTS runs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id       INTEGER NOT NULL REFERENCES tasks(id),
  parent_run_id INTEGER REFERENCES runs(id),
  node_id       TEXT    NOT NULL,
  phase         TEXT    NOT NULL,
  state         TEXT    NOT NULL,
  verdict       TEXT,
  json_path     TEXT    NOT NULL,
  log_path      TEXT,
  started_at    INTEGER,
  ended_at      INTEGER,
  ms            INTEGER
);

CREATE TABLE IF NOT EXISTS events (
  seq     INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id),
  at      INTEGER NOT NULL,
  type    TEXT    NOT NULL,
  payload TEXT
);

CREATE INDEX IF NOT EXISTS idx_runs_task   ON runs(task_id, id);
CREATE INDEX IF NOT EXISTS idx_runs_parent ON runs(parent_run_id);
CREATE INDEX IF NOT EXISTS idx_events_task ON events(task_id, seq);
CREATE INDEX IF NOT EXISTS idx_tasks_state ON tasks(state, created_at);

-- 任务状态快照：每个节点一行。续跑读它，不再回头扫 runs 表和 json 文件。
-- 产物按路径合并后存在 artifacts 里，所以「收口轮不写文件」不会把产物抹掉。
CREATE TABLE IF NOT EXISTS checkpoints (
  task_id    INTEGER NOT NULL REFERENCES tasks(id),
  node_id    TEXT    NOT NULL,
  run_id     INTEGER NOT NULL,
  state      TEXT    NOT NULL,
  verdict    TEXT,
  summary    TEXT,
  question   TEXT,
  artifacts  TEXT    NOT NULL DEFAULT '[]',
  stray      TEXT    NOT NULL DEFAULT '[]',
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (task_id, node_id)
);

-- 派生审批：模型想临时新开一条产线，得先过人这一关。
-- 单独建表而不是塞进 events：它要被反复查询（界面轮询）和条件更新（抢决定权）。
CREATE TABLE IF NOT EXISTS approvals (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id    INTEGER NOT NULL REFERENCES tasks(id),
  run_id     INTEGER,
  kind       TEXT    NOT NULL,
  payload    TEXT    NOT NULL,
  state      TEXT    NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL,
  decided_at INTEGER,
  note       TEXT
);

CREATE INDEX IF NOT EXISTS idx_approvals_state ON approvals(state, id);
CREATE INDEX IF NOT EXISTS idx_approvals_task  ON approvals(task_id);

-- 点对点留言：子 agent 之间可以直接说话，但走 hub 中转、异步投递、全程留痕。
-- 不阻塞（发完就走，不等回话）是刻意的：有等待就有死锁，而没有死锁才敢放开点对点。
CREATE TABLE IF NOT EXISTS messages (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id      INTEGER NOT NULL REFERENCES tasks(id),
  run_id       INTEGER,
  from_node    TEXT    NOT NULL,
  to_node      TEXT    NOT NULL,
  body         TEXT    NOT NULL,
  state        TEXT    NOT NULL DEFAULT 'pending',
  created_at   INTEGER NOT NULL,
  delivered_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_messages_inbox ON messages(task_id, to_node, state);

-- 单例锁：用数据库行做原子认领，不用锁文件。
-- 锁文件办不到「回收僵尸锁」这件事：A、B 同时读到同一个死 pid，A 删掉再建，
-- B 随后把 A 的新锁删了——两个 hub 就这么同时活了。文件系统没有 compare-and-delete。
-- 数据库有：DELETE ... WHERE pid = <看到的那个死 pid>，影响 0 行就说明别人先回收了。
CREATE TABLE IF NOT EXISTS hub_lock (
  id  INTEGER PRIMARY KEY CHECK (id = 1),
  pid INTEGER NOT NULL,
  at  INTEGER NOT NULL
);
`;

/** openDB 是同步接口，重试时只能同步等——这点阻塞只发生在启动那一瞬 */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** 老库补列：CREATE TABLE IF NOT EXISTS 不会给已存在的表加字段 */
function ensureColumn(db: DatabaseSync, table: string, column: string, ddl: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}

export function openDB(file = DB_FILE): DatabaseSync {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let last: unknown;
  // 每次重试都换一条新连接：撞上 WAL 切换窗口的那条连接会一直回报只读，
  // 在同一条连接上重试是没用的（实测 8 次全是同一个错）。
  for (let i = 0; i <= 8; i++) {
    const db = new DatabaseSync(file);
    try {
      // busy_timeout 必须在建表之前设：几个进程同时首次启动时，
      // CREATE TABLE / 切 WAL 会互相抢锁，抢不到的那次 exec 直接抛错。
      // SCHEMA 里那条 PRAGMA 排在语句中间，救不了它前面已经失败的语句。
      db.exec('PRAGMA busy_timeout = 5000;');
      db.exec(SCHEMA);
      // 老库补列（必须在 SCHEMA 之后：新库建表时已经带上了）
      ensureColumn(db, 'tasks', 'parent_task_id', 'parent_task_id INTEGER');
      // 失败轮次里「写了但没通过」的文件：老库没有这一列，补上
      ensureColumn(db, 'checkpoints', 'stray', "stray TEXT NOT NULL DEFAULT '[]'");
      // 阶段计划：老库没有，补上。空表示「一个任务一件事」，行为与以前一致
      ensureColumn(db, 'tasks', 'plan', 'plan TEXT');
      ensureColumn(db, 'tasks', 'phases_done', 'phases_done TEXT');
      return db;
    } catch (e) {
      last = e;
      try { db.close(); } catch {}
      const msg = String((e as Error).message ?? e);
      if (!/busy|locked|readonly/i.test(msg)) throw e;
      sleepSync(80 * (i + 1));
    }
  }
  throw last;
}

export type MigrateResult = {
  imported: number;
  skipped: number;
  maxId: number;
  nextId: number;
  problems: string[];
};

/**
 * 把 .data/runs/*.json 导入 runs 表。
 * 显式带 id 插入，让 sqlite_sequence 跟到历史最大值——
 * 这条顺序不能反，反了下一轮就会写到 0001.json 覆盖历史。
 */
/**
 * 把 v1 的 `.data/runs/*.json` 导进新库。
 *
 * `dirs` 可覆盖 runs/logs 目录：测试要能自带 fixture，
 * 否则在没有历史数据的机器（比如刚克隆下来的仓库）上跑测试必失败。
 */
export function importLegacyRuns(
  db: DatabaseSync,
  dirs: { runs?: string; logs?: string } = {},
): MigrateResult {
  const RUNS_DIR = dirs.runs ?? RUNS;
  const LOGS_DIR = dirs.logs ?? LOGS;
  const problems: string[] = [];
  if (!fs.existsSync(RUNS_DIR)) {
    return { imported: 0, skipped: 0, maxId: 0, nextId: 1, problems: ['没有 .data/runs 目录'] };
  }

  const files = fs.readdirSync(RUNS_DIR).filter((f) => /^\d{4,}\.json$/.test(f));
  const records: RunRecord[] = [];
  for (const f of files) {
    try {
      const rec = JSON.parse(fs.readFileSync(path.join(RUNS_DIR, f), 'utf8')) as RunRecord;
      if (typeof rec.id !== 'number') {
        problems.push(`${f}：没有数字 id`);
        continue;
      }
      records.push(rec);
    } catch (e) {
      problems.push(`${f}：解析失败 ${String(e).slice(0, 60)}`);
    }
  }
  records.sort((a, b) => a.id - b.id);

  // 保留任务必须先存在，否则外键拒绝
  const now = Date.now();
  db.prepare(
    `INSERT OR IGNORE INTO tasks (id, master, task, state, config_snapshot, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(LEGACY_TASK, '__legacy__', '迁移自 v1 的历史轮次', 'interrupted', '{}', now, now);

  const exists = db.prepare('SELECT 1 FROM runs WHERE id = ?');
  const insert = db.prepare(
    `INSERT INTO runs (id, task_id, parent_run_id, node_id, phase, state, verdict, json_path, log_path, ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const hasLog = db.prepare('SELECT 1 FROM runs WHERE json_path = ?');

  let imported = 0;
  let skipped = 0;
  for (const rec of records) {
    if (exists.get(rec.id)) {
      skipped += 1;
      continue;
    }
    // 历史记录只存了 HH:MM:SS，没有日期，所以 started_at 留空，ms 照存
    const logFile = path.join(LOGS_DIR, String(rec.id).padStart(4, '0') + '.log');
    insert.run(
      rec.id,
      LEGACY_TASK,
      typeof rec.parent === 'number' && exists.get(rec.parent) ? rec.parent : null,
      rec.node,
      rec.verdict ? 'review' : 'work',
      rec.state,
      rec.verdict ?? null,
      path.join(RUNS_DIR, String(rec.id).padStart(4, '0') + '.json'),
      fs.existsSync(logFile) ? logFile : null,
      rec.ms ?? null,
    );
    imported += 1;
  }
  void hasLog;

  const maxId = Number(db.prepare('SELECT COALESCE(MAX(id), 0) m FROM runs').get()?.m ?? 0);
  const nextId = Number(
    db.prepare("SELECT COALESCE(seq, 0) s FROM sqlite_sequence WHERE name = 'runs'").get()?.s ?? maxId ?? 0,
  ) + 1;

  return { imported, skipped, maxId, nextId, problems };
}

/** 领一个新轮次号。先 INSERT 占位再返回，保证并发下不重复 */
export function allocRunId(db: DatabaseSync, taskId: number, nodeId: string, parentRunId?: number): number {
  const r = db
    .prepare(
      `INSERT INTO runs (task_id, parent_run_id, node_id, phase, state, json_path)
       VALUES (?, ?, ?, 'work', 'running', '')`,
    )
    .run(taskId, parentRunId ?? null, nodeId);
  return Number(r.lastInsertRowid);
}

/** 一轮结束时补全占位行。json_path 为空说明这轮没落盘，对账时会被发现 */
export function finishRun(
  db: DatabaseSync,
  runId: number,
  patch: {
    phase?: string;
    state: string;
    verdict?: string | null;
    jsonPath?: string;
    logPath?: string | null;
    endedAt?: number;
    ms?: number;
  },
): void {
  db.prepare(
    `UPDATE runs
        SET phase = COALESCE(?, phase),
            state = ?,
            verdict = ?,
            json_path = COALESCE(?, json_path),
            log_path = COALESCE(?, log_path),
            ended_at = COALESCE(?, ended_at),
            ms = COALESCE(?, ms)
      WHERE id = ?`,
  ).run(
    patch.phase ?? null,
    patch.state,
    patch.verdict ?? null,
    patch.jsonPath ?? null,
    patch.logPath ?? null,
    patch.endedAt ?? null,
    patch.ms ?? null,
    runId,
  );
}

export type NewTask = {
  master: string;
  task: string;
  configSnapshot: string;
  clientRequestId?: string;
  /** 续跑时指向上一个任务，形成可追溯的链 */
  parentTaskId?: number;
  /** 本地跑时直接建 running，避免「建出来到改状态」之间被调度器认领 */
  initialState?: string;
};

export function createTask(db: DatabaseSync, t: NewTask): number {
  const now = Date.now();
  const r = db
    .prepare(
      `INSERT INTO tasks (master, task, state, config_snapshot, created_at, updated_at, client_request_id, parent_task_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      t.master,
      t.task,
      t.initialState ?? 'queued',
      t.configSnapshot,
      now,
      now,
      t.clientRequestId ?? null,
      t.parentTaskId ?? null,
    );
  return Number(r.lastInsertRowid);
}

export function setTaskState(
  db: DatabaseSync,
  taskId: number,
  state: string,
  extra: { errorCode?: string; errorMessage?: string; summary?: string } = {},
): void {
  const now = Date.now();
  db.prepare(
    `UPDATE tasks
        SET state = ?,
            updated_at = ?,
            started_at = CASE WHEN ? = 'running' THEN COALESCE(started_at, ?) ELSE started_at END,
            ended_at   = CASE WHEN ? IN ('done','failed','canceled','timed_out','interrupted') THEN ? ELSE ended_at END,
            cancel_requested_at = CASE WHEN ? = 'cancelling' THEN COALESCE(cancel_requested_at, ?) ELSE cancel_requested_at END,
            error_code = COALESCE(?, error_code),
            error_message = COALESCE(?, error_message)
      WHERE id = ?`,
  ).run(
    state,
    now,
    state,
    now,
    state,
    now,
    state,
    now,
    extra.errorCode ?? null,
    extra.errorMessage ?? null,
    taskId,
  );
}

export function dbPath(): string {
  return DB_FILE;
}

/**
 * 任务的阶段计划与进度。
 *
 * 存库不存内存：任务被打断后续跑要能接着走，光放在进程里丢了就退化成「一个任务一件事」。
 * 读坏 JSON 时当没有计划——宁可退化成老行为，也不要因为一段脏数据把整个任务卡死。
 */
export function getPhases(db: DatabaseSync, taskId: number): { plan: Phase[]; done: string[] } {
  const row = db.prepare('SELECT plan, phases_done FROM tasks WHERE id = ?').get(taskId) as
    | { plan: string | null; phases_done: string | null }
    | undefined;
  const parse = <T,>(s: string | null | undefined, dflt: T): T => {
    try {
      const v = JSON.parse(s || 'null');
      return (v ?? dflt) as T;
    } catch {
      return dflt;
    }
  };
  return {
    plan: parse<Phase[]>(row?.plan, []),
    done: parse<string[]>(row?.phases_done, []),
  };
}

export function savePhases(db: DatabaseSync, taskId: number, plan: Phase[], done: string[]): void {
  db.prepare('UPDATE tasks SET plan = ?, phases_done = ?, updated_at = ? WHERE id = ?')
    .run(JSON.stringify(plan), JSON.stringify(done), Date.now(), taskId);
}
