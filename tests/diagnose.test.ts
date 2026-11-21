// 失败诊断：提示词要带够现场信息，输出要能被清理成可读文本。
//
// 这两条都是纯函数，不需要起 CLI。真正调模型那一层由 scheduler 负责，
// 这里只锁「诊断说明里必须有轮次编号」和「回执块别混进正文」。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDiagnosisBrief, cleanDiagnosis } from '../src/kernel/diagnose.ts';

test('诊断提示词带轮次编号、失败原因与产物路径', () => {
  const brief = buildDiagnosisBrief({
    taskId: 42,
    task: '把五条线的资产清点一遍',
    state: 'failed',
    error: '证据核不上',
    runs: [
      { id: 1, node: 'a', state: 'done', ms: 3000, summary: '派活', artifacts: [] },
      {
        id: 2, node: 'b', state: 'failed', ms: 9000, summary: '交了一半',
        error: '产物越界', warnings: ['没拿到回执'], artifacts: [{ path: 'D:/x/a.csv' }],
      },
    ],
  });
  assert.match(brief, /#1 a done/);
  assert.match(brief, /#2 b failed/);
  assert.match(brief, /证据核不上/);
  assert.match(brief, /产物越界/);
  assert.match(brief, /D:\/x\/a\.csv/);
  assert.match(brief, /### 1\. 直接原因/);
  assert.match(brief, /### 4\. 下一轮的具体指令/);
  // 必须明确禁止它动手，否则它会顺手续跑
  assert.match(brief, /不要派活、不要开线、不要改任何文件/);
});

test('轮次很多时只带最后 12 轮，避免提示词无限增长', () => {
  const runs = Array.from({ length: 30 }, (_, i) => ({
    id: i + 1, node: 'a', state: 'done', ms: 1000, summary: '第' + (i + 1) + '轮', artifacts: [],
  }));
  const brief = buildDiagnosisBrief({ taskId: 1, task: 't', state: 'failed', error: '', runs });
  assert.ok(brief.includes('#30 a done'), '最后一轮要在');
  assert.ok(!brief.includes('#1 a done'), '最早的轮次要被截掉');
  assert.match(brief, /一共跑了 30 轮/, '总数要如实写');
});

test('诊断输出剥掉回执块并截断', () => {
  const raw = [
    '### 1. 直接原因',
    '第 2 轮 b 因为产物越界被判失败。',
    '',
    '```agent-autoloop',
    '{"summary":"这段不该出现在诊断里"}',
    '```',
    '',
    '### 2. 根因',
    '验收口径没写清。',
  ].join('\n');
  const out = cleanDiagnosis(raw);
  assert.ok(!out.includes('agent-autoloop'), '回执块要丢掉');
  assert.ok(!out.includes('这段不该出现在诊断里'));
  assert.match(out, /第 2 轮 b 因为产物越界/);
});

test('空输出不炸', () => {
  assert.equal(cleanDiagnosis(''), '');
  assert.equal(cleanDiagnosis('   \n  '), '');
});
