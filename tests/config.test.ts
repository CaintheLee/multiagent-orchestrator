// 配置是所有轮次的输入。这里读错一个字段，整棵树都会按错的规则跑。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/kernel/tree.ts';

const BASE = `
schema = 1

[protocol]
max_summary = 200
max_detail = 4000

[root]
id = "a"
name = "主控"
plugin = "codebuddy"
workspace = "a"
timeout_min = 4
access = "write"
role = "dispatcher"
`;

function write(toml: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-cfg-'));
  const f = path.join(dir, 'agents.toml');
  fs.writeFileSync(f, toml, 'utf8');
  return f;
}

function agent(id: string, parent: string, extra = ''): string {
  return `
[agent.${id}]
id = "${id}"
parent = "${parent}"
name = "${id}"
plugin = "codebuddy"
workspace = "${id}"
${extra}`;
}

test('正常三层配置能读出来', () => {
  const cfg = loadConfig(write(BASE + agent('b', 'a') + agent('c', 'b')));
  assert.deepEqual(cfg.nodes.map((n) => n.id), ['a', 'b', 'c']);
  assert.equal(cfg.root.id, 'a');
  assert.equal(cfg.maxDetail, 4000);
});

test('parent 指向自己 → 报错（否则会派活给自己，白烧一轮预算）', () => {
  assert.throws(() => loadConfig(write(BASE + agent('b', 'b'))), /指向自己/);
});

test('两个节点互相指成环、从根走不到 → 报错，而不是当孤儿挂着', () => {
  assert.throws(() => loadConfig(write(BASE + agent('b', 'c') + agent('c', 'b'))), /走不到/);
});

test('parent 不存在 → 报错', () => {
  assert.throws(() => loadConfig(write(BASE + agent('b', 'zzz'))), /不存在/);
});

test('同一段 [agent.x] 写两遍 → 报错，不能静默覆盖', () => {
  const dup = BASE + agent('b', 'a') + agent('b', 'a');
  assert.throws(() => loadConfig(write(dup)), /出现了两次/);
});

test('超时被夹在 1–120 分钟：写 0 / 负数不会被当成立即超时', () => {
  const timeoutOf = (v: string) => {
    const cfg = loadConfig(write(BASE + agent('b', 'a', `timeout_min = ${v}\n`)));
    return cfg.nodes.find((n) => n.id === 'b')!.timeoutMin;
  };
  assert.equal(timeoutOf('0'), 1);
  assert.equal(timeoutOf('-5'), 1);
  assert.equal(timeoutOf('9999'), 120);
  assert.equal(timeoutOf('12'), 12);
});

test('缺 timeout_min 时给 10 分钟', () => {
  const cfg = loadConfig(write(BASE + agent('b', 'a')));
  assert.equal(cfg.nodes.find((n) => n.id === 'b')!.timeoutMin, 10);
});

test('没有 [root] 或 root 带 parent 都要报错', () => {
  const noRoot = BASE.replace('[root]', '[agent.a]');
  assert.throws(() => loadConfig(write(noRoot)), /没有 \[root\]|缺少 id/);
  const rootWithParent = BASE.replace('role = "dispatcher"', 'role = "dispatcher"\nparent = "b"');
  assert.throws(() => loadConfig(write(rootWithParent)), /根节点不能有 parent/);
});
