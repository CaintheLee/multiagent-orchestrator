// 续跑简报：超长时只能砍原任务，回答和尾部指令必须活下来；装不下就报溢出，
// 由调用方 413 拒绝，不能靠整体 slice「看起来成功了」。
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildResumeBrief, RESUME_LINES, RESUME_MAX, RESUME_TRAIL } from '../src/protocol/resume.ts';

const ANSWER = '用 800×600，只要纯风景，不要出现人物，导出 PNG。';
const TAIL = '只补还没完成的部分。派活时说清哪些跳过，收口时只验收这次新交付的。';

test('正常长度：原任务、回答、交付清单都在，顺序是任务→回答→清单', () => {
  const r = buildResumeBrief({
    id: 7,
    state: 'blocked',
    task: '做一张壁纸',
    answer: ANSWER,
    lines: ['- b：写好了 · 产物：bike.html（1200 字节）'],
  });
  assert.equal(r.overflow, false);
  assert.ok(r.brief.includes('做一张壁纸'));
  assert.ok(r.brief.includes(ANSWER));
  assert.ok(r.brief.includes('bike.html'));
  assert.ok(r.brief.indexOf('做一张壁纸') < r.brief.indexOf(ANSWER), '原任务在前，回答在后');
  assert.ok(r.brief.trimEnd().endsWith(TAIL), '尾部指令必须留在最后');
});

test('超长原任务：只砍原任务，回答和尾部指令一个字都不少', () => {
  const r = buildResumeBrief({
    id: 8,
    state: 'interrupted',
    task: '需'.repeat(30_000),
    answer: ANSWER,
    lines: ['- b：写好了'],
  });
  assert.equal(r.overflow, false, '砍完应该装得下');
  assert.ok(r.brief.length <= RESUME_MAX);
  assert.ok(r.brief.includes(ANSWER), '回答不能因为原任务长就被截掉');
  assert.ok(r.brief.includes('原任务太长，先截到这里'));
  assert.ok(r.brief.trimEnd().endsWith(TAIL));
});

test('回答本身装不下：报溢出，不做盲切', () => {
  const hugeAnswer = '答'.repeat(30_000);
  const r = buildResumeBrief({
    id: 9,
    state: 'blocked',
    task: '短任务',
    answer: hugeAnswer,
    lines: [],
  });
  assert.equal(r.overflow, true, '装不下必须明确报出来，让调用方 413');
  assert.ok(r.brief.length > RESUME_MAX);
  assert.ok(r.brief.includes(hugeAnswer), '溢出时也不该在函数里把回答切了——由调用方决定怎么办');
});

test('交付清单超过 30 条时折叠成一句提示', () => {
  const lines = Array.from({ length: 48 }, (_, i) => `- n${i}：完成`);
  const r = buildResumeBrief({ id: 10, state: 'failed', task: 'x', answer: '', lines });
  assert.equal(r.shown, RESUME_LINES + 1, '30 条 + 一条「还有 N 个」');
  assert.ok(r.brief.includes('还有 18 个节点有交付'));
  assert.equal(r.overflow, false);
});

test('没有回答、没有交付：仍然给出可执行的开头', () => {
  const r = buildResumeBrief({ id: 11, state: 'failed', task: 'x', answer: '', lines: [] });
  assert.ok(r.brief.includes('之前没有交付物，从头开始。'));
  assert.equal(r.overflow, false);
});

test('有过程记录但没有交付：不能再说「从头开始」，要说清别重复做过的事', () => {
  const trail = ['- a（失败）：已完成规划，写在 D:/YourProject/docs/plan.md · 落过 2 个文件但没通过'];
  const r = buildResumeBrief({ id: 12, state: 'failed', task: 'x', answer: '', lines: [], trail });
  assert.ok(r.brief.includes('别重复它已经做过的事'), '否则上一轮 8 分钟等于白跑：#40');
  assert.ok(!r.brief.includes('之前没有交付物，从头开始。'));
  assert.ok(r.brief.includes('上一轮的过程记录'));
  assert.ok(r.brief.includes('没通过验收'), '过程记录必须标明它们没被验收');
  assert.equal(r.overflow, false);
});

test('过程记录也要封顶，不能把正文吃光', () => {
  const trail = Array.from({ length: 40 }, (_, i) => `- n${i}（失败）：跑过一轮`);
  const r = buildResumeBrief({ id: 13, state: 'failed', task: 'x', answer: '', lines: [], trail });
  assert.ok(r.brief.includes(`还有 ${40 - RESUME_TRAIL} 轮没列出`));
  assert.ok(r.brief.length < 3000);
});
