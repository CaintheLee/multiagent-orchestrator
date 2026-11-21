// 对话写前确认：只有用户点了「允许修改」才给写权限。
//
// 这里锁的是解析层——它是唯一能把 plan 模式切成可写的入口。
// 解析失败必须返回 null（宁可让它再问一次，也不要凭一段坏 JSON 给权限）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEditPlan } from '../src/host/chat.ts';

const wrap = (body: string) => '我要改这些：\n```ma-edit-plan\n' + body + '\n```\n';

test('正常计划能解析出文件与理由', () => {
  const p = parseEditPlan(wrap(JSON.stringify({
    files: ['D:/YourProject/scripts/player.gd', 'D:/YourProject/scenes/player.tscn'],
    reason: '引用路径写错了',
    risk: 'low',
  })));
  assert.ok(p);
  assert.deepEqual(p!.files, ['D:/YourProject/scripts/player.gd', 'D:/YourProject/scenes/player.tscn']);
  assert.equal(p!.reason, '引用路径写错了');
  assert.equal(p!.risk, 'low');
});

test('目录不算授权：写路径以斜杠结尾的直接丢弃', () => {
  const p = parseEditPlan(wrap(JSON.stringify({ files: ['D:/YourProject/scripts/'] })));
  assert.equal(p, null, '只剩目录时应当拒绝');
});

test('目录与文件混在一起时只保留文件', () => {
  const p = parseEditPlan(wrap(JSON.stringify({ files: ['D:/YourProject/scripts/', 'D:/YourProject/a.gd'] })));
  assert.deepEqual(p!.files, ['D:/YourProject/a.gd']);
});

test('坏 JSON 不给权限', () => {
  assert.equal(parseEditPlan(wrap('{不是 json}')), null);
});

test('空列表不给权限', () => {
  assert.equal(parseEditPlan(wrap(JSON.stringify({ files: [] }))), null);
});

test('最多 12 个文件，多的截掉', () => {
  const files = Array.from({ length: 20 }, (_, i) => `D:/YourProject/f${i}.gd`);
  const p = parseEditPlan(wrap(JSON.stringify({ files })));
  assert.equal(p!.files.length, 12);
});

test('没有块就是普通回答，不产生授权', () => {
  assert.equal(parseEditPlan('现在项目在 N2 阶段，下一步该做 N3。'), null);
  assert.equal(parseEditPlan(''), null);
});

test('非字符串数组的元素被忽略，不会变成 "undefined" 路径', () => {
  const p = parseEditPlan(wrap(JSON.stringify({ files: [null, 123, 'D:/YourProject/ok.gd'] })));
  assert.deepEqual(p!.files, ['D:/YourProject/ok.gd']);
});
