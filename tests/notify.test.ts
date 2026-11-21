// 通知：格式按地址判断、状态过滤、正文长度。都是纯函数，不需要真发请求。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  payloadFor,
  shouldNotify,
  notifyText,
  stateText,
  DEFAULT_NOTIFY_ON,
} from '../src/kernel/notify.ts';

test('企业微信地址用 msgtype=text', () => {
  const { body, hint } = payloadFor(
    { webhook: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abc' },
    '任务 #1 失败',
  );
  assert.equal(hint, '企业微信');
  assert.deepEqual(body, { msgtype: 'text', text: { content: '任务 #1 失败' } });
});

test('Server酱用 title + desp', () => {
  const { body, hint } = payloadFor(
    { webhook: 'https://sctapi.ftqq.com/SCT123.send' },
    '任务 #2 完成\n正文第二行',
  );
  assert.equal(hint, 'Server酱');
  assert.equal((body as { title: string }).title, '任务 #2 完成');
  assert.match((body as { desp: string }).desp, /正文第二行/);
});

test('PushPlus 用 title + content', () => {
  const { body, hint } = payloadFor(
    { webhook: 'https://www.pushplus.plus/send?token=x' },
    '任务 #3 卡住',
  );
  assert.equal(hint, 'PushPlus');
  assert.equal((body as { title: string }).title, '任务 #3 卡住');
});

test('认不出的地址走通用 JSON，不会拒发', () => {
  const { body, hint } = payloadFor({ webhook: 'https://example.com/hook' }, 'hello');
  assert.equal(hint, '通用 JSON');
  assert.equal((body as { text: string }).text, 'hello');
});

test('默认只通知 blocked / failed / done', () => {
  const cfg = { targets: [{ webhook: 'https://x' }], on: [] };
  for (const s of DEFAULT_NOTIFY_ON) assert.ok(shouldNotify(cfg, s), s + ' 应当通知');
  assert.ok(!shouldNotify(cfg, 'running'));
  assert.ok(!shouldNotify(cfg, 'canceled'));
  assert.ok(!shouldNotify(cfg, 'paused'), '暂停是人自己点的，不用再喊一遍');
});

test('自定义 on 覆盖默认', () => {
  const cfg = { targets: [{ webhook: 'https://x' }], on: ['canceled'] };
  assert.ok(shouldNotify(cfg, 'canceled'));
  assert.ok(!shouldNotify(cfg, 'done'));
});

test('没配通道就什么都不发', () => {
  assert.equal(shouldNotify(undefined, 'failed'), false);
});

test('通知正文短、带编号与原因', () => {
  const t = notifyText(42, 'failed', '把五条线的资产清点一遍并出总表', '证据核不上\n第二行');
  assert.match(t, /^任务 #42 失败/);
  assert.match(t, /资产清点/);
  assert.match(t, /原因：证据核不上/);
  // 锁屏只显示前两行，正文不能长
  assert.ok(t.split('\n')[1].length <= 80, '第二行要短：' + t.split('\n')[1].length);
});

test('状态中文名齐全', () => {
  for (const [k, v] of Object.entries({
    done: '已完成', failed: '失败', blocked: '卡住等你回答',
    canceled: '被取消', paused: '已暂停', interrupted: '被打断',
  })) {
    assert.equal(stateText(k), v);
  }
  assert.equal(stateText('weird'), 'weird', '不认识的原样返回，不要编');
});
