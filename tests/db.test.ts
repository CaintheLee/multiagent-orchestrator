// 迁移层的护栏。这些断言对应一次真实风险：新库从 1 开始分配会覆盖历史文件。
//
// 这里自带 fixture，不读本机的 .data/runs：
// 否则刚克隆下来的仓库（没有历史数据）跑测试必失败——公开版踩过这个坑。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDB, importLegacyRuns, allocRunId, LEGACY_TASK } from '../src/store/db.ts';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-db-'));
const RUNS = path.join(ROOT, 'runs');
const LOGS = path.join(ROOT, 'logs');
fs.mkdirSync(RUNS, { recursive: true });
fs.mkdirSync(LOGS, { recursive: true });

/** 三条历史轮次：5 / 9（带私账）/ 12（review 带 verdict） */
const FIXTURES = [
  { id: 5, node: 'b', state: 'done' },
  { id: 9, node: 'c', state: 'done', ms: 1234 },
  { id: 12, node: 'b', state: 'done', verdict: 'pass' },
];
for (const r of FIXTURES) {
  fs.writeFileSync(path.join(RUNS, String(r.id).padStart(4, '0') + '.json'), JSON.stringify(r), 'utf8');
}
fs.writeFileSync(path.join(LOGS, '0009.log'), 'log', 'utf8');

const TMP = path.join(ROOT, 'test.db');

function fresh() {
  for (const f of [TMP, TMP + '-wal', TMP + '-shm']) {
    try {
      fs.unlinkSync(f);
    } catch {
      // 第一次不存在
    }
  }
  return openDB(TMP);
}

const dirs = () => ({ runs: RUNS, logs: LOGS });

test('导入历史轮次后，序号跟到历史最大值', () => {
  const db = fresh();
  const r = importLegacyRuns(db, dirs());
  const ids = FIXTURES.map((x) => x.id);
  assert.equal(r.imported, ids.length, '导入条数应等于文件数');
  assert.equal(r.maxId, Math.max(...ids), '最大 id 必须等于所有文件里最大的那个');
  assert.equal(r.nextId, r.maxId + 1, '下一个号必须紧接最大值');
  db.close();
});

test('导入之后新分配号不会撞历史', () => {
  const db = fresh();
  const r = importLegacyRuns(db, dirs());
  const id = allocRunId(db, LEGACY_TASK, 'a');
  assert.equal(id, r.maxId + 1, '新号必须紧接历史最大值');
  assert.ok(id > r.maxId);
  db.close();
});

test('重复导入是幂等的，不会重复插入', () => {
  const db = fresh();
  importLegacyRuns(db, dirs());
  const before = (db.prepare('SELECT COUNT(*) c FROM runs').get() as { c: number }).c;
  const second = importLegacyRuns(db, dirs());
  const after = (db.prepare('SELECT COUNT(*) c FROM runs').get() as { c: number }).c;
  assert.equal(second.imported, 0, '第二次不应有新导入');
  assert.equal(after, before, '行数不变');
  db.close();
});

test('历史记录挂在保留任务下，外键成立', () => {
  const db = fresh();
  importLegacyRuns(db, dirs());
  const orphan = (
    db.prepare(
      'SELECT COUNT(*) c FROM runs r LEFT JOIN tasks t ON r.task_id = t.id WHERE t.id IS NULL',
    ).get() as { c: number }
  ).c;
  assert.equal(orphan, 0, '不应有指向不存在任务的轮次');
  const task = db.prepare('SELECT master FROM tasks WHERE id = ?').get(LEGACY_TASK) as { master: string };
  assert.equal(task.master, '__legacy__');
  db.close();
});

test('有私账的轮次能关联到 log_path', () => {
  const db = fresh();
  importLegacyRuns(db, dirs());
  const withLog = (
    db.prepare('SELECT COUNT(*) c FROM runs WHERE log_path IS NOT NULL').get() as { c: number }
  ).c;
  const logFiles = fs.readdirSync(LOGS).filter((f) => f.endsWith('.log')).length;
  assert.equal(withLog, logFiles, '有日志文件的轮次都要关联上');
  assert.ok(withLog > 0, 'fixture 里应有一条带私账的轮次');
  db.close();
});

test('review 轮次带 verdict，work 轮次不带', () => {
  const db = fresh();
  importLegacyRuns(db, dirs());
  const bad = (
    db.prepare(
      "SELECT COUNT(*) c FROM runs WHERE (phase = 'review' AND verdict IS NULL) OR (phase = 'work' AND verdict IS NOT NULL)",
    ).get() as { c: number }
  ).c;
  assert.equal(bad, 0, 'phase 与 verdict 应一一对应');
  db.close();
});
