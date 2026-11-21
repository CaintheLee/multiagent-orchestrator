// 状态快照：续跑只读这一张表。这里锁住三件事——
// 1. 产物跨轮合并（收口轮不写文件，不能把工作轮的产物抹掉）
// 2. 旧轮次晚到不能覆盖新状态
// 3. 老库能补出 parent_task_id（续跑链）
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-cp-'));
process.env.MA_DATA_DIR = DATA;

const { openDB, createTask } = await import('../src/store/db.ts');
const { saveCheckpoint, listCheckpoints } = await import('../src/store/checkpoints.ts');

const DB = openDB(path.join(DATA, 'cp.db'));
const taskId = createTask(DB, { master: 'a', task: '写点东西', configSnapshot: '{}' });

test('快照写入后能读回来', () => {
  saveCheckpoint(DB, taskId, {
    id: 1,
    node: 'b',
    state: 'done',
    summary: '写好了',
    artifacts: [{ path: '/x/a.txt', kind: 'txt', bytes: 10 }],
  });
  const cp = listCheckpoints(DB, taskId).find((c) => c.nodeId === 'b');
  assert.ok(cp);
  assert.equal(cp.state, 'done');
  assert.equal(cp.summary, '写好了');
  assert.equal(cp.artifacts.length, 1);
});

test('收口轮不带产物时，工作轮交的产物仍然在', () => {
  saveCheckpoint(DB, taskId, {
    id: 2,
    node: 'b',
    state: 'done',
    verdict: 'pass',
    summary: '验收通过',
    artifacts: [],
  });
  const cp = listCheckpoints(DB, taskId).find((c) => c.nodeId === 'b');
  assert.equal(cp?.artifacts.length, 1, '覆盖式写入会把产物抹掉，续跑就以为它什么都没交');
  assert.equal(cp?.verdict, 'pass');
});

test('同一个路径只保留一份，不会越滚越长', () => {
  saveCheckpoint(DB, taskId, {
    id: 3,
    node: 'b',
    state: 'done',
    verdict: 'pass',
    summary: '又改了一版',
    artifacts: [{ path: '/x/a.txt', kind: 'txt', bytes: 99 }],
  });
  const cp = listCheckpoints(DB, taskId).find((c) => c.nodeId === 'b');
  assert.equal(cp?.artifacts.length, 1);
  assert.equal(cp?.artifacts[0].bytes, 99, '同路径应该更新成最新那份');
});

test('旧轮次晚到不会把新状态盖回去', () => {
  saveCheckpoint(DB, taskId, {
    id: 1, // 比当前 run_id 小
    node: 'b',
    state: 'failed',
    summary: '旧的失败记录',
    artifacts: [],
  });
  const cp = listCheckpoints(DB, taskId).find((c) => c.nodeId === 'b');
  assert.equal(cp?.state, 'done');
  assert.equal(cp?.summary, '又改了一版');
});

test('parent_task_id 能连成续跑链', () => {
  const child = createTask(DB, {
    master: 'a',
    task: '接着干',
    configSnapshot: '{}',
    parentTaskId: taskId,
  });
  const row = DB.prepare('SELECT parent_task_id FROM tasks WHERE id = ?').get(child) as {
    parent_task_id: number;
  };
  assert.equal(Number(row.parent_task_id), taskId);
});

test('老库（tasks 表没有 parent_task_id）打开时自动补列', () => {
  const file = path.join(DATA, 'legacy.db');
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    master TEXT NOT NULL, task TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'queued',
    error_code TEXT, error_message TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    started_at INTEGER, ended_at INTEGER, cancel_requested_at INTEGER,
    config_snapshot TEXT NOT NULL, client_request_id TEXT UNIQUE)`);
  old.close();

  const migrated = openDB(file);
  const cols = migrated.prepare('PRAGMA table_info(tasks)').all() as Array<{ name: string }>;
  assert.ok(cols.some((c) => c.name === 'parent_task_id'), '缺列会导致续跑链写不进去');
  migrated.close();
});

test('失败轮次里「写了但没通过」的文件也要存下来', () => {
  saveCheckpoint(DB, taskId, {
    id: 3,
    node: 'a',
    state: 'failed',
    summary: '规划写完了，但落在工作区外',
    artifacts: [],
    stray: [{ path: 'D:/YourProject/docs/plan.md', bytes: 23159, why: '不在工作区' }],
  });
  const cp = listCheckpoints(DB, taskId).find((c) => c.nodeId === 'a');
  assert.equal(cp?.state, 'failed');
  assert.equal(cp?.artifacts.length, 0);
  assert.equal(cp?.stray.length, 1, '不记的话，界面上就是「毫无产出」（#40）');
  assert.equal(cp?.stray[0].bytes, 23159);
  assert.match(cp?.stray[0].why ?? '', /工作区/);
});

test('stray 不累计：下一轮成功时清掉，避免旧失败一直挂着', () => {
  saveCheckpoint(DB, taskId, {
    id: 4,
    node: 'a',
    state: 'done',
    summary: '这次走对了',
    artifacts: [{ path: '/x/b.md', kind: 'md', bytes: 5 }],
    stray: [],
  });
  const cp = listCheckpoints(DB, taskId).find((c) => c.nodeId === 'a');
  assert.equal(cp?.stray.length, 0);
  assert.equal(cp?.artifacts.length, 1);
});
