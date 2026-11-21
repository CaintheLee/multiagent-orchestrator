// 派生审批是「模型想花钱，得人点头」的唯一关口，状态机必须严丝合缝。
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDB } from '../src/store/db.ts';
import {
  addApproval, decideApproval, expirePending, getApproval, listApprovals,
} from '../src/store/approvals.ts';
import { waitApproval } from '../src/kernel/approval.ts';
import { parseReceipt } from '../src/protocol/receipt.ts';
import { FENCE } from '../src/protocol/schema.ts';
import type { Config } from '../src/kernel/tree.ts';

function freshDb() {
  const db = openDB(':memory:');
  // approvals 有外键指向 tasks，先放一条占位任务
  db.prepare(
    `INSERT INTO tasks (id, master, task, state, config_snapshot, created_at, updated_at)
     VALUES (1, 'a', 't', 'running', '{}', 0, 0)`,
  ).run();
  return db;
}

const payload = { name: 'audit', why: '要一条独立的审计线', task: '审一遍产物' };

test('新建的审批是 pending，能按 id 取回来', () => {
  const db = freshDb();
  const id = addApproval(db, 1, 7, 'spawn', payload);

  const row = getApproval(db, id);
  assert.ok(row);
  assert.equal(row.state, 'pending');
  assert.equal(row.payload.name, 'audit');
  assert.equal(row.runId, 7);
});

test('只有第一票算数：批准之后再拒绝不生效', () => {
  const db = freshDb();
  const id = addApproval(db, 1, 7, 'spawn', payload);

  assert.equal(decideApproval(db, id, 'approved', '人点了批准'), true);
  assert.equal(decideApproval(db, id, 'rejected', '另一个窗口点了拒绝'), false, '第二票必须落空');
  assert.equal(getApproval(db, id)!.state, 'approved');
});

test('默认只列 pending，处理过的不会反复弹出来', () => {
  const db = freshDb();
  const a = addApproval(db, 1, 7, 'spawn', payload);
  addApproval(db, 1, 7, 'spawn', { ...payload, name: 'docs' });
  decideApproval(db, a, 'rejected');

  assert.deepEqual(listApprovals(db).map((x) => x.payload.name), ['docs']);
  assert.equal(listApprovals(db, 'all').length, 2);
});

test('取消任务时只收该任务的单子，别的不动', () => {
  const db = freshDb();
  db.prepare(
    `INSERT INTO tasks (id, master, task, state, config_snapshot, created_at, updated_at)
     VALUES (2, 'a', 't2', 'running', '{}', 0, 0)`,
  ).run();
  const mine = addApproval(db, 1, 7, 'spawn', payload);
  const other = addApproval(db, 2, 9, 'spawn', payload);

  assert.equal(expirePending(db, 1, '任务被取消'), 1);
  assert.equal(getApproval(db, mine)!.state, 'expired');
  assert.equal(getApproval(db, other)!.state, 'pending');
});

test('等待中被人批准 → waitApproval 立刻返回 approved', async () => {
  const db = freshDb();
  const id = addApproval(db, 1, 7, 'spawn', payload);

  setTimeout(() => decideApproval(db, id, 'approved', 'ok'), 30);
  assert.equal(await waitApproval(db, id, undefined, 5000, 10), 'approved');
});

test('没人处理 → 超时按拒绝算（默认安全，不能因为没人看就放行）', async () => {
  const db = freshDb();
  const id = addApproval(db, 1, 7, 'spawn', payload);

  assert.equal(await waitApproval(db, id, undefined, 60, 10), 'expired');
  assert.equal(getApproval(db, id)!.state, 'expired');
});

test('任务被取消 → 停止等待并把单子收掉', async () => {
  const db = freshDb();
  const id = addApproval(db, 1, 7, 'spawn', payload);
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 30);

  assert.equal(await waitApproval(db, id, ac.signal, 5000, 10), 'canceled');
  assert.equal(getApproval(db, id)!.state, 'expired');
});

/* ---------- 回执里的 spawn 形状 ---------- */

const cfg = { schema: 1, nodes: [], root: null as unknown as Config['root'], maxSummary: 200, maxDetail: 4000 };
const wrap = (json: string) => '好的\n\n```' + FENCE + '\n' + json + '\n```\n';

function receipt(body: Record<string, unknown>): string {
  return wrap(JSON.stringify({ summary: '结论', artifacts: [], dispatch: [], ...body }));
}

test('正常 spawn 被解析出来，可选字段缺了也没关系', () => {
  const r = parseReceipt(receipt({
    spawn: [
      { name: 'audit', why: '需要独立审计', task: '审一遍' },
      { name: 'docs', why: '要写文档', task: '写说明书', model: 'hy4free', role: 'executor' },
    ],
  }), cfg);

  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.receipt.spawn.length, 2);
  assert.equal(r.receipt.spawn[1].model, 'hy4free');
  assert.equal(r.receipt.spawn[0].model, undefined);
});

test('spawn 缺 why 直接拒：理由要写给人看，不能空着让人猜', () => {
  const r = parseReceipt(receipt({ spawn: [{ name: 'audit', task: '审一遍' }] }), cfg);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.why, /why/);
});

test('spawn 缺 task 直接拒：批准后要立刻派活', () => {
  const r = parseReceipt(receipt({ spawn: [{ name: 'audit', why: '因为' }] }), cfg);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.why, /task/);
});

test('spawn 名字不合法要拒（它要拼进路径和文件名）', () => {
  for (const bad of ['../etc', 'a b', '', 'x'.repeat(20), '名字']) {
    const r = parseReceipt(receipt({ spawn: [{ name: bad, why: '因为', task: '做' }] }), cfg);
    assert.equal(r.ok, false, `「${bad}」应该被拒`);
  }
});

test('大写名字会被规范成小写（否则同一个名字能开出两个节点）', () => {
  const r = parseReceipt(receipt({ spawn: [{ name: 'Audit', why: '因为', task: '做' }] }), cfg);
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.receipt.spawn[0].name, 'audit');
});

test('一轮提超过 3 个只截断，不判整轮失败', () => {
  const many = Array.from({ length: 5 }, (_, i) => ({ name: `s${i}`, why: '因为', task: '做' }));
  const r = parseReceipt(receipt({ spawn: many }), cfg);
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.receipt.spawn.length, 3);
});
