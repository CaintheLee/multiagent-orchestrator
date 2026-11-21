// 右侧 agent 介绍框（#inspector）的滚动位置：4 秒轮询会重绘它，
// 以前每次重绘都把 scrollTop 归零，用户一滚就被弹回顶部。
// 这个页面没有 DOM 测试环境，只能锁源码里的关键写法——改动这块时先看这两条。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync('ui/index.html', 'utf8');
const fn = (/function renderInspector\(\)\{([\s\S]*?)\n\}/.exec(html) || [])[1] || '';

test('renderInspector 不能再无条件把面板滚回顶部', () => {
  assert.ok(fn, '找不到 renderInspector，正则要跟着改');
  assert.ok(!/insp\.scrollTop\s*=\s*0\b/.test(fn), '重绘时把 scrollTop 归零，就是这次要修的 bug');
});

test('同一个面板重绘时保留位置，切换节点才回到顶部', () => {
  assert.match(fn, /const key = selected \|\| '__master__'/, '要有「当前面板」的标识');
  assert.match(fn, /key === inspLastKey \? insp\.scrollTop : 0/, '同一个面板取当前位置，换面板取 0');
  assert.match(fn, /insp\.scrollTop = keepTop/, '重绘完要把位置放回去');
  assert.match(fn, /inspLastKey = key/, '渲染后要记住这次是哪个面板');
});

test('日志/监控面板仍是「只在新增时滚到底」，别把那条改坏', () => {
  assert.ok(
    /if \(grew\) box\.scrollTop = box\.scrollHeight;/.test(html),
    '监控栏的自动滚动带 grew 守卫，属于正常行为，不在这次修复范围',
  );
});

test('续跑入口有三个：顶栏、任务动态栏、开始任务旁边', () => {
  assert.ok(/id="resumeBtn"/.test(html), '顶栏的续跑按钮要在');
  assert.ok(/id="monResume"/.test(html), '任务动态栏也要有一个，人盯进展的地方不用再往顶栏找');
  assert.ok(/id="breakResume"/.test(html), '「开始任务」旁边的断点继续按钮');
  assert.match(html, /function paintResumeBtn\(b, label\)/, '三个按钮要共用同一份状态计算，否则文案会不一致');
  assert.match(html, /\$\('#monResume'\)\.onclick = doResume/, '三个按钮都绑同一个处理函数');
  // 以前用 hidden 控制可见性，不可续时按钮直接消失，看起来像「没有这个功能」
  assert.ok(
    /b\.hidden = !curTask/.test(html),
    '按钮应当常显（有任务就显示），不可续时用禁用态和文案说明',
  );
});
