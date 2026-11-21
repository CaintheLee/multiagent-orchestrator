// 护栏：把已经在真实运行中验证过的行为锁住。
// 每个用例都对应一次踩过的坑，不再重演。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseReceipt } from '../src/protocol/receipt.ts';
import { FENCE } from '../src/protocol/schema.ts';
import { checkArtifacts } from '../src/kernel/settle.ts';
import { parseToml } from '../src/kernel/tree.ts';
import type { Config, NodeConfig } from '../src/kernel/tree.ts';

const rootNode: NodeConfig = {
  id: 'b',
  parent: '',
  name: '执行者',
  plugin: 'codex',
  workspace: os.tmpdir(),
  timeoutMin: 5,
  access: 'write',
  role: 'executor',
  model: '',
  extraDirs: [],
};

const cfg: Config = {
  schema: 1,
  nodes: [rootNode],
  root: rootNode,
  maxSummary: 200,
  maxDetail: 4000,
};

const node = cfg.root;

function wrap(json: string): string {
  return '正文随便写点什么\n\n```agent-autoloop\n' + json + '\n```\n';
}

test('正常回执能解析', () => {
  const r = parseReceipt(wrap('{"summary":"做好了","artifacts":[]}'), cfg);
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.receipt.summary, '做好了');
});

test('没有回执块要失败，并给出原因', () => {
  const r = parseReceipt('我写完了，但是忘了给回执', cfg);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.why, /没有找到/);
});

test('summary 超过 200 字要失败（#19 的真实故障）', () => {
  const long = '啊'.repeat(305);
  const r = parseReceipt(wrap(JSON.stringify({ summary: long, artifacts: [] })), cfg);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.why, /305/);
});

test('顶层带多余字段要失败（autoloop 示例里的 outcome）', () => {
  const r = parseReceipt(wrap('{"summary":"好了","artifacts":[],"outcome":"done"}'), cfg);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.why, /outcome/);
});

test('回执不是合法 JSON 要失败', () => {
  const r = parseReceipt(wrap('{summary: 好了}'), cfg);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.why, /JSON/);
});

test('artifacts 里有一项没有 path 要失败', () => {
  const r = parseReceipt(wrap('{"summary":"好了","artifacts":[{"kind":"html"}]}'), cfg);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.why, /path/);
});

test('有多个回执块时取最后一个（正文可能引用过格式示例）', () => {
  const text =
    '格式是这样的：\n```agent-autoloop\n{"summary":"这是示例","artifacts":[]}\n```\n\n做完了：\n```agent-autoloop\n{"summary":"真的做完了","artifacts":[]}\n```\n';
  const r = parseReceipt(text, cfg);
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.receipt.summary, '真的做完了');
});

test('产物在工作区内且真的存在，才算数', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-art-'));
  const file = path.join(dir, 'out.html');
  fs.writeFileSync(file, '<h1>ok</h1>');
  const n: NodeConfig = { ...node, workspace: dir };
  const { ok, bad } = checkArtifacts({ artifacts: [{ path: file, kind: 'html', bytes: 0 }] }, n);
  assert.equal(bad.length, 0);
  assert.equal(ok.length, 1);
  assert.equal(ok[0].bytes, 11);
});

test('产物在工作区外要拒绝（越界写文件的唯一防线）', () => {
  const inside = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-in-'));
  const outside = path.join(os.tmpdir(), 'ma-outside-' + Date.now() + '.txt');
  fs.writeFileSync(outside, 'x');
  const n: NodeConfig = { ...node, workspace: inside };
  const { ok, bad } = checkArtifacts({ artifacts: [{ path: outside, kind: 'txt', bytes: 0 }] }, n);
  assert.equal(ok.length, 0);
  assert.equal(bad.length, 1);
  assert.match(bad[0], /不在工作区/);
  fs.rmSync(outside, { force: true });
});

test('产物文件不存在要拒绝', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-miss-'));
  const n: NodeConfig = { ...node, workspace: dir };
  const { ok, bad } = checkArtifacts(
    { artifacts: [{ path: path.join(dir, 'nope.html'), kind: 'html', bytes: 0 }] },
    n,
  );
  assert.equal(ok.length, 0);
  assert.match(bad[0], /不存在/);
});

test('TOML 能读出各个段', () => {
  const raw = parseToml(`
schema = 1

[root]
id = "b"
name = "执行者"
timeout_min = 5

[protocol]
max_summary = 200
`);
  assert.equal(raw[''].schema, 1);
  assert.equal(raw.root.id, 'b');
  assert.equal(raw.root.timeout_min, 5);
  assert.equal(raw.protocol.max_summary, 200);
});

test('TOML 里不是 key = value 的行要直接报错，不静默跳过', () => {
  assert.throws(() => parseToml('[root]\nid "b"\n'), /key = value/);
});

test('畸形深层对象不会让解析器抛异常（否则这一轮会卡在 running）', () => {
  // 手工拼 12000 层嵌套：JSON.parse 能过，JSON.stringify 会爆栈
  const deep = '{"a":'.repeat(12000) + '1' + '}'.repeat(12000);
  const body = '{"summary":"x","artifacts":[' + deep + '],"dispatch":[]}';
  const r = parseReceipt('```' + FENCE + '\n' + body + '\n```', { schema: 1, nodes: [], root: {}, maxSummary: 200, maxDetail: 4000 } as unknown as Config);
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.match(r.why, /没有 path|不合法/);
    assert.ok(r.raw.length < 2000, 'raw 必须是截断过的安全文本');
  }
});

// ---- ask：点名请谁回答 ----
// 和 question 的区别是「责任明确」：question 交给框架往上抛，ask 必须由指定节点处理。
// 没有它，子 agent 的疑问只能一路冒到人，中间那层主控形同虚设。
test('ask 能解析出 to 和 question', () => {
  const r = parseReceipt(
    wrap(JSON.stringify({
      summary: '做完了但要确认口径',
      artifacts: [],
      ask: [{ to: 'a', question: '持枪用腰射还是抵肩？' }],
    })),
    cfg,
  );
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.receipt.ask.length, 1);
  assert.equal(r.receipt.ask[0].to, 'a');
  assert.match(r.receipt.ask[0].question, /腰射/);
});

test('ask.to 可以是 user，表示只能人来答', () => {
  const r = parseReceipt(
    wrap(JSON.stringify({ summary: 's', artifacts: [], ask: [{ to: 'user', question: '发布目标？' }] })),
    cfg,
  );
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.receipt.ask[0].to, 'user');
});

test('ask 里的坏条目丢单条，不判整轮失败', () => {
  const r = parseReceipt(
    wrap(JSON.stringify({
      summary: 's',
      artifacts: [],
      ask: [
        { to: 'a', question: '这个可以吗' },
        { to: 'BAD NAME', question: '非法节点名' },
        { to: 'a', question: '' },
        { to: 'a', question: 'x'.repeat(500) },
      ],
    })),
    cfg,
  );
  assert.equal(r.ok, true, '一条问题写坏不该让整份交付作废');
  if (!r.ok) return;
  assert.equal(r.receipt.ask.length, 1);
});

test('ask 数量超限时截断到 3 条', () => {
  const ask = Array.from({ length: 6 }, (_, i) => ({ to: 'a', question: `问题 ${i}` }));
  const r = parseReceipt(wrap(JSON.stringify({ summary: 's', artifacts: [], ask })), cfg);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.receipt.ask.length, 3);
});

test('ask 写成单个对象也能接住（模型常这么写）', () => {
  const r = parseReceipt(
    wrap(JSON.stringify({ summary: 's', artifacts: [], ask: { to: 'a', question: '一个问题' } })),
    cfg,
  );
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.receipt.ask.length, 1);
});
