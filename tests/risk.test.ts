// 高风险识别：宁可多拦一次，也不能漏掉「删文件」。
//
// 但也不能见「删」就拦——「别删任何文件」是最安全的那类指令，
// 拦它只会让人以为功能坏了。这组用例锁的就是这条线。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { needsSignoff, detectRisk, riskText } from '../src/kernel/risk.ts';

const hit = (t: string) => needsSignoff(t).length > 0;

test('删除类动作要拦', () => {
  assert.ok(hit('把 .sandbox 里的临时文件删掉'));
  assert.ok(hit('删除过期资产'));
  assert.ok(hit('清空隔离区'));
  assert.ok(hit('rm -rf build'));
});

test('移动/隔离/改名/协议/覆盖都算高风险', () => {
  assert.ok(hit('把无用资产移动到隔离区'));
  assert.ok(hit('批量重命名所有图集文件'));
  assert.ok(hit('把协议版本升到 2'));
  assert.ok(hit('直接覆盖原来的清单'));
  assert.ok(hit('动一下资产库的索引'));
});

test('否定语境不拦', () => {
  assert.ok(!hit('别删任何文件，只做只读梳理'));
  assert.ok(!hit('不许删除资产，只做清点'));
  assert.ok(!hit('禁止覆盖已有文件'));
  assert.ok(!hit('不得移动任何源文件'));
});

test('日常开发动作不拦（拦了等于让人放弃这个功能）', () => {
  assert.ok(!hit('跑一遍测试并修掉失败用例'));
  assert.ok(!hit('把 player.tscn 里的引用改对'));
  assert.ok(!hit('给这个函数补三条单元测试'));
  assert.ok(!hit('写一份审计报告到 docs/ 下'));
});

test('命中时给出可读的理由，人能看出是因为哪句话', () => {
  const risks = needsSignoff('把五条线的资产全部移动到隔离区，然后清理索引');
  assert.ok(risks.length >= 1);
  const text = riskText(risks);
  assert.match(text, /移动|删除|清理|资产/);
  // 证据片段要能定位到原文
  for (const r of risks) {
    assert.ok(r.hit.length > 0, 'hit 不能是空的');
    assert.ok(typeof r.at === 'number' && r.at >= 0);
  }
});

test('只看前 4000 字：验收标准里的「不得删除」不该被当风险', () => {
  const task = '写一份报告。\n' + 'x'.repeat(5000) + '\n不要删除任何文件';
  assert.ok(!hit(task), '4000 字之后的否定句不该触发');
});

test('detectRisk 保留原文位置，供否定判定使用', () => {
  const risks = detectRisk('别删这个，但要删那个');
  assert.ok(risks.length >= 1);
  // 「别删」是否定，但「要删」是肯定，needsSignoff 应当仍然拦
  assert.ok(needsSignoff('别删这个，但要删那个').length >= 1);
});
