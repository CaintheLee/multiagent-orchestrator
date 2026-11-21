// 守门员是纯函数，不需要起进程就能测
import test from 'node:test';
import assert from 'node:assert/strict';
import { guard, looksStuck, reworkTimes, sameInstructionTimes, MAX_REWORK } from '../src/kernel/guard.ts';
import type { RunRecord } from '../src/store/runs.ts';

function rec(over: Partial<RunRecord>): RunRecord {
  return {
    id: 1,
    node: 'a',
    plugin: 'codebuddy',
    task: 't',
    state: 'done',
    startedAt: new Date().toISOString(),
    ms: 1000,
    summary: 's',
    artifacts: [],
    dispatch: [],
    warnings: [],
    ...over,
  };
}

const rework = (id: number, task: string) =>
  rec({ id, verdict: 'rework', dispatch: [{ to: 'b', task }] });

test('预算用完就停', () => {
  const v = guard([], 0);
  assert.equal(v.stop, true);
  if (v.stop) assert.match(v.why, /预算/);
});

test('没有打回时继续', () => {
  assert.equal(guard([rec({ verdict: 'pass' })], 6).stop, false);
});

test('打回一次、两次都不停（给执行者改进机会）', () => {
  assert.equal(guard([rework(1, '缺 A，请补上 A')], 6).stop, false);
  assert.equal(guard([rework(1, '缺 A，请补上 A'), rework(2, '缺 B，请补上 B')], 6).stop, false);
});

test('两次打回说的是同一段话，立刻停（这是真空转）', () => {
  const same = '不合格式，请原样改写为单行纯文本，不要加任何前缀或后缀';
  const v = guard([rework(1, same), rework(2, same)], 6);
  assert.equal(v.stop, true);
  if (v.stop) assert.match(v.why, /同一段指令/);
});

test('打回三次就叫停', () => {
  const v = guard([rework(1, '缺 A'), rework(2, '缺 B'), rework(3, '缺 C')], 6);
  assert.equal(v.stop, true);
  if (v.stop) assert.match(v.why, /打回 3 次/);
});

test('执行者反复说「再试一次」判为原地打转', () => {
  const stuck = '让我再试一次。还是不行。换一种方法看看。我再改一下。';
  assert.equal(looksStuck(stuck), true);
});

test('正常输出不会被误判为打转', () => {
  assert.equal(looksStuck('已经写好 dolphin-bike.html，含海豚与自行车，动画正常。'), false);
});

test('不同节点的打回不能合并成「同一段话」（并发下必须按节点分开判）', () => {
  const same = '不合格式，请原样改写为单行纯文本，不要加任何前缀或后缀';
  const mixed = [rework(1, same), rec({ id: 2, node: 'c', verdict: 'rework', dispatch: [{ to: 'd', task: same }] })];

  // 全树混在一起判：两条不同产线的正常打回会被误判成空转
  assert.equal(guard(mixed, 12).stop, true, '这是并发引入误判的证据');

  // 按节点过滤后：每个节点各只有一次打回，不该停
  assert.equal(guard(mixed.filter((r) => r.node === 'a'), 12).stop, false);
  assert.equal(guard(mixed.filter((r) => r.node === 'c'), 12).stop, false);
});

test('打回次数按「谁打回谁」算：叶节点自己的轮次里没有 rework', () => {
  const runs = [
    rec({ id: 1, node: 'a', verdict: 'rework', dispatch: [{ to: 'b', task: '改 A' }] }),
    rec({ id: 2, node: 'b', state: 'done', verdict: undefined, dispatch: [] }),
    rec({ id: 3, node: 'a', verdict: 'rework', dispatch: [{ to: 'b', task: '改 B' }] }),
  ];
  assert.equal(reworkTimes(runs, 'a', 'b'), 2, '应按父节点 a 打回 b 的次数算');
  assert.equal(reworkTimes(runs, 'b', 'b'), 0, '叶节点自己数自己是 0，这正是旧实现的漏洞');
  assert.equal(MAX_REWORK, 3);
});

test('同段打回指令只数「上一轮真的给过」，且要排除当前这一条', () => {
  const same = '不合格式，请原样改写为单行纯文本，不要加任何前缀或后缀，照抄一遍';
  const runs = [
    rec({ id: 1, node: 'a', verdict: 'rework', dispatch: [{ to: 'b', task: same }] }),
    rec({ id: 2, node: 'a', verdict: 'rework', dispatch: [{ to: 'b', task: same }] }),
  ];
  // 当前这条（id=2）必须排除：它自己也是一条 rework，不排除就会把第一次打回算成重复
  assert.equal(sameInstructionTimes(runs, 'a', 'b', same, 2), 1);
  assert.equal(sameInstructionTimes(runs, 'a', 'b', same, 0), 2, '不排除当前记录时会多算一条');
  assert.equal(sameInstructionTimes(runs, 'a', 'b', '换一段完全不同的要求：把第一行改成大写', 2), 0);
  // 只有前 80 字参与比较：后半段不同不影响判定
  const long = 'x'.repeat(80);
  const only = [rec({ id: 1, node: 'a', verdict: 'rework', dispatch: [{ to: 'b', task: long + 'A' }] })];
  assert.equal(sameInstructionTimes(only, 'a', 'b', long + 'B', 9), 1);
});
