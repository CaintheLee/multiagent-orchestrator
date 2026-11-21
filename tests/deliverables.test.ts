// 交付清单落地检查：任务点了名的产物不在盘上，收口不能判通过。
// 锁住的是一次真实事故（#45：六项交付全缺，任务照样 done），改动这里的判定口径前先看用例。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listedDeliverables, missingDeliverables } from '../src/kernel/deliverables.ts';
import { buildReviewBrief } from '../src/runner/accept.ts';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-deliv-'));
const there = path.join(tmp, 'there.md');
fs.writeFileSync(there, 'x');
const gone = path.join(tmp, 'gone.csv');

const task = [
  '做四件事。',
  '',
  '━━━ 交付清单 ━━━',
  `1. ${there}`,
  `2. ${gone}`,
  `3. ${path.join(tmp, 'quarantine-dir')}`,
  '',
  '【期望输出】',
  `读完再写 ${path.join(tmp, 'later.md')}`,
].join('\n');

test('交付清单段里的绝对路径都能抠出来', () => {
  const got = listedDeliverables(task);
  assert.deepEqual(got, [there, gone, path.join(tmp, 'quarantine-dir')]);
});

test('段落外的路径不算交付物，不误伤正文里提到的文件', () => {
  assert.ok(!listedDeliverables(task).includes(path.join(tmp, 'later.md')));
});

test('盘上没有的交付物被挑出来', () => {
  const miss = missingDeliverables(task);
  assert.deepEqual(miss, [gone, path.join(tmp, 'quarantine-dir')]);
});

test('目录也算落地：隔离区这种交付物本来就是目录', () => {
  const dirTask = `━━━ 交付清单 ━━━\n1. ${tmp}\n`;
  assert.deepEqual(missingDeliverables(dirTask), []);
});

test('没有交付清单段的任务不产生要求', () => {
  assert.deepEqual(listedDeliverables('只回复 ok，dispatch 写 []'), []);
  assert.deepEqual(missingDeliverables('只回复 ok，dispatch 写 []'), []);
});

test('空任务不炸', () => {
  assert.deepEqual(missingDeliverables(''), []);
});

test('收口简报要给「派下一段」留出口，不能只有通过和打回两条路', () => {
  const brief = buildReviewBrief('原任务：分四段做', ['### b · DONE']);
  assert.match(brief, /原任务是不是分了几段/);
  assert.match(brief, /派下一段不算打回/);
});
