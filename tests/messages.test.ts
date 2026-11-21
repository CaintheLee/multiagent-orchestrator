// 点对点留言的三条硬规矩：只送一次、只送本人、任务结束即作废。
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDB } from '../src/store/db.ts';
import {
  addMessage, dropPending, listMessages, takeMessages,
} from '../src/store/messages.ts';
import { parseReceipt } from '../src/protocol/receipt.ts';
import { FENCE } from '../src/protocol/schema.ts';
import type { Config } from '../src/kernel/tree.ts';

function freshDb() {
  const db = openDB(':memory:');
  db.prepare(
    `INSERT INTO tasks (id, master, task, state, config_snapshot, created_at, updated_at)
     VALUES (1, 'a', 't', 'running', '{}', 0, 0)`,
  ).run();
  return db;
}

test('留言进库是 pending，能按任务列出来', () => {
  const db = freshDb();
  addMessage(db, 1, 20, 'b', 'c', '地图接缝按 4px 对齐');

  const all = listMessages(db, 1);
  assert.equal(all.length, 1);
  assert.equal(all[0].from, 'b');
  assert.equal(all[0].to, 'c');
  assert.equal(all[0].state, 'pending');
});

test('取走之后立刻变 delivered，再取就是空的（不会重复塞给同一个节点）', () => {
  const db = freshDb();
  addMessage(db, 1, 20, 'b', 'c', '一句话');

  const first = takeMessages(db, 1, 'c');
  assert.equal(first.length, 1);
  assert.equal(first[0].body, '一句话');

  assert.deepEqual(takeMessages(db, 1, 'c'), [], '同一条留言只能投一次');
  assert.equal(listMessages(db, 1)[0].state, 'delivered');
});

test('只投给收件人，别人的留言不会被顺走', () => {
  const db = freshDb();
  addMessage(db, 1, 20, 'b', 'c', '给 c 的');
  addMessage(db, 1, 20, 'b', 'd', '给 d 的');

  assert.equal(takeMessages(db, 1, 'c').length, 1);
  assert.equal(takeMessages(db, 1, 'd').length, 1);
  assert.equal(takeMessages(db, 1, 'e').length, 0, '没有自己的留言就应该是空的');
});

test('不同任务的留言互相隔离（同一节点名也不会串）', () => {
  const db = freshDb();
  db.prepare(
    `INSERT INTO tasks (id, master, task, state, config_snapshot, created_at, updated_at)
     VALUES (2, 'a', 't2', 'running', '{}', 0, 0)`,
  ).run();
  addMessage(db, 1, 20, 'b', 'c', '任务一的');
  addMessage(db, 2, 30, 'b', 'c', '任务二的');

  const got = takeMessages(db, 2, 'c');
  assert.equal(got.length, 1);
  assert.equal(got[0].body, '任务二的');
});

test('任务结束时把没投出去的全部作废，不留僵尸', () => {
  const db = freshDb();
  addMessage(db, 1, 20, 'b', 'c', '永远没人收');

  assert.equal(dropPending(db, 1), 1);
  assert.equal(listMessages(db, 1)[0].state, 'dropped');
  assert.deepEqual(takeMessages(db, 1, 'c'), [], '作废的不能再被取走');
});

/* ---------- 回执里的 tell 形状 ---------- */

const cfg = { schema: 1, nodes: [], root: null as unknown as Config['root'], maxSummary: 200, maxDetail: 4000 };
const wrap = (json: string) => '好的\n\n```' + FENCE + '\n' + json + '\n```\n';
const receipt = (body: Record<string, unknown>) =>
  wrap(JSON.stringify({ summary: '结论', artifacts: [], dispatch: [], ...body }));

test('正常 tell 被解析出来，to 会规范成小写', () => {
  const r = parseReceipt(receipt({ tell: [{ to: 'C', msg: '地图接缝按 4px' }] }), cfg);
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.receipt.tell.length, 1);
    assert.equal(r.receipt.tell[0].to, 'c');
  }
});

test('收件人不合法的条目被丢掉，但整轮不判失败（一句话没写好不该毁掉交付）', () => {
  for (const bad of ['../x', 'a b', '', '名字']) {
    const r = parseReceipt(receipt({ tell: [{ to: bad, msg: '内容' }] }), cfg);
    assert.equal(r.ok, true, `「${bad}」只该丢这条，不该毁整轮`);
    if (r.ok) assert.equal(r.receipt.tell.length, 0);
  }
});

test('模型把 tell 写成单个对象也认（这是它最常犯的写法）', () => {
  const r = parseReceipt(receipt({ tell: { to: 'a', msg: 'b 线已交付' } }), cfg);
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.receipt.tell.length, 1);
    assert.equal(r.receipt.tell[0].to, 'a');
  }
});

test('空消息和超长消息只丢那一条，不影响整轮', () => {
  const a = parseReceipt(receipt({ tell: [{ to: 'c', msg: '  ' }] }), cfg);
  assert.equal(a.ok, true);
  if (a.ok) assert.equal(a.receipt.tell.length, 0);

  const b = parseReceipt(receipt({ tell: [{ to: 'c', msg: 'x'.repeat(600) }] }), cfg);
  assert.equal(b.ok, true);
  if (b.ok) assert.equal(b.receipt.tell.length, 0);
});

test('一轮超过 3 条只截断，不判整轮失败', () => {
  const many = Array.from({ length: 5 }, (_, i) => ({ to: 'c', msg: `第 ${i} 条` }));
  const r = parseReceipt(receipt({ tell: many }), cfg);
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.receipt.tell.length, 3);
});
