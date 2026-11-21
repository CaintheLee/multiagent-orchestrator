// 证据核对：判通过时必须拿得出「只有读过文件才写得出的片段」。
// 这些用例锁住的是零 token 防放水那条线，改动 verifyEvidence 的语义前先看这里。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseReceipt } from '../src/protocol/receipt.ts';
import { evidenceProblem, verifyEvidence } from '../src/kernel/settle.ts';
import type { Config, NodeConfig } from '../src/kernel/tree.ts';

const node: NodeConfig = {
  id: 'b',
  parent: 'a',
  name: '执行者',
  plugin: 'codebuddy',
  workspace: os.tmpdir(),
  timeoutMin: 5,
  access: 'write',
  role: 'executor',
  model: 'hy4free',
  extraDirs: [],
};
const cfg: Config = { schema: 1, nodes: [node], root: node, maxSummary: 200, maxDetail: 4000 };

function wrap(json: string): string {
  return '正文\n\n```agent-autoloop\n' + json + '\n```\n';
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-ev-'));
const htmlFile = path.join(tmp, 'bike.html');
fs.writeFileSync(htmlFile, '<svg id="wheel"><circle r="40"/></svg>\n蚰蜒骑着自行车\n', 'utf8');
const pngFile = path.join(tmp, 'shot.png');
fs.writeFileSync(pngFile, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));

test('evidence 能解析出来', () => {
  const r = parseReceipt(
    wrap('{"summary":"好了","artifacts":[],"dispatch":[],"evidence":["蚰蜒骑着自行车"]}'),
    cfg,
  );
  assert.equal(r.ok, true);
  if (r.ok) assert.deepEqual(r.receipt.evidence, ['蚰蜒骑着自行车']);
});

test('没有 evidence 字段时按空数组处理（老回执还能跑）', () => {
  const r = parseReceipt(wrap('{"summary":"好了","artifacts":[],"dispatch":[]}'), cfg);
  assert.equal(r.ok, true);
  if (r.ok) assert.deepEqual(r.receipt.evidence, []);
});

test('太短的 evidence 被丢掉，但不让整轮回执失败（执行者本来就无需给证据）', () => {
  const r = parseReceipt(wrap('{"summary":"好了","artifacts":[],"evidence":["ok"]}'), cfg);
  assert.equal(r.ok, true, '一条随手写的「ok」不该把整个交付判死');
  if (r.ok) assert.deepEqual(r.receipt.evidence, [], '短条目要被过滤掉，不能当证据用');
});

test('evidence 不是数组要拒', () => {
  const r = parseReceipt(wrap('{"summary":"好了","artifacts":[],"evidence":"蚰蜒骑着自行车"}'), cfg);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.why, /字符串数组/);
});

test('文件里真有这段 → 全中', () => {
  const miss = verifyEvidence(['<svg id="wheel">', '蚰蜒骑着自行车'], [
    { path: htmlFile, kind: 'html', bytes: 0 },
  ]);
  assert.deepEqual(miss, []);
});

test('文件里没有这段 → 报出来（概括过、编的都会落在这）', () => {
  const miss = verifyEvidence(['蚰蜒骑着独轮车', '<svg id="wheel">'], [
    { path: htmlFile, kind: 'html', bytes: 0 },
  ]);
  assert.deepEqual(miss, ['蚰蜒骑着独轮车']);
});

test('标点改过就搜不到，这是故意的', () => {
  const miss = verifyEvidence(['蚰蜒骑着自行车。'], [{ path: htmlFile, kind: 'html', bytes: 0 }]);
  assert.deepEqual(miss, ['蚰蜒骑着自行车。']);
});

test('只有二进制产物时跳过核对，不误伤', () => {
  const miss = verifyEvidence(['随便什么'], [{ path: pngFile, kind: 'png', bytes: 0 }]);
  assert.deepEqual(miss, []);
});

test('verifyEvidence 只做匹配，空数组不报错（策略在 evidenceProblem 里）', () => {
  assert.deepEqual(verifyEvidence([], [{ path: htmlFile, kind: 'html', bytes: 0 }]), []);
});

test('产物路径不存在时不抛错，当没有可核对内容', () => {
  const miss = verifyEvidence(['x'.repeat(10)], [
    { path: path.join(tmp, 'nope.txt'), kind: 'txt', bytes: 0 },
  ]);
  assert.deepEqual(miss, []);
});

test('有产物却一条证据都不给 → 判不合格（这是防放水的核心）', () => {
  const miss = evidenceProblem([], [{ path: htmlFile, kind: 'html', bytes: 0 }]);
  assert.equal(miss.length, 1);
  assert.match(miss[0], /一条 evidence 都没给/);
});

test('没有产物就不要求证据（纯问答、纯派活）', () => {
  assert.deepEqual(evidenceProblem([], []), []);
  assert.deepEqual(evidenceProblem(undefined, []), []);
});

test('只给一条证据也不行，必须两处', () => {
  const miss = evidenceProblem(['<svg id="wheel">'], [{ path: htmlFile, kind: 'html', bytes: 0 }]);
  assert.equal(miss.length, 1);
  assert.match(miss[0], /至少给 2 条/);
});

test('evidence 超过 6 条只截断，不判整轮失败（认真核对不该被罚）', () => {
  const many = Array.from({ length: 10 }, (_, i) => `第 ${i} 段足够长的证据片段`);
  const r = parseReceipt(wrap(JSON.stringify({ summary: '好了', artifacts: [], evidence: many })), cfg);
  assert.equal(r.ok, true, '多给几条证据是好事，不该把整份回执判死');
  if (r.ok) assert.equal(r.receipt.evidence.length, 6);
});
