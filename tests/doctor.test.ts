// doctor：在花钱跑任务之前把环境问题挑出来。
// 用临时目录 + 自定义 provider（指向 node 自己）构造一个「健康」环境，
// 这样不依赖本机装没装 codebuddy。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerProvidersFrom } from '../src/adapters/table.ts';
import { runDoctor } from '../src/host/doctor.ts';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-doc-'));
fs.mkdirSync(path.join(TMP, 'prompts'), { recursive: true });
fs.writeFileSync(path.join(TMP, 'prompts', 'executor.md'), '你是执行者。\n', 'utf8');
fs.writeFileSync(path.join(TMP, 'providers.toml'), [
  '[provider.t_node]',
  `bin = ${JSON.stringify(process.execPath)}`,
  'args = "-e 0"',
].join('\n'), 'utf8');
registerProvidersFrom(path.join(TMP, 'providers.toml'));

fs.writeFileSync(path.join(TMP, 'agents.toml'), [
  '[root]',
  'id = "a"',
  'name = "主控"',
  'plugin = "t_node"',
  'workspace = "a"',
  'role = "executor"',
  'model = ""',
  '',
  '[agent.b]',
  'id = "b"',
  'parent = "a"',
  'plugin = "t_node"',
  'workspace = "b"',
  'role = "executor"',
  '',
].join('\n'), 'utf8');

test('健康环境：没有 fail 项', async () => {
  const { items, ok } = await runDoctor(TMP, 3999);
  const fails = items.filter((i) => i.level === 'fail');
  assert.equal(ok, true, '不该有 fail：' + fails.map((f) => f.title + ' / ' + f.detail).join('; '));
  assert.ok(items.some((i) => i.title.includes('2 个节点')));
  assert.ok(items.some((i) => i.title.includes('表齐全')));
});

test('provider 路径坏了要报 fail', async () => {
  const broken = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-doc2-'));
  fs.writeFileSync(path.join(broken, 'agents.toml'), [
    '[root]', 'id = "a"', 'plugin = "t_missing_bin"', 'workspace = "a"', '',
  ].join('\n'), 'utf8');
  fs.writeFileSync(path.join(broken, 'providers.toml'), `[provider.t_missing_bin]\nbin = "${path.join(broken, 'nope.exe')}"\n`, 'utf8');
  registerProvidersFrom(path.join(broken, 'providers.toml'));
  const { items, ok } = await runDoctor(broken, 3998);
  assert.equal(ok, false);
  assert.ok(items.some((i) => i.level === 'fail' && i.title.includes('t_missing_bin')));
});

test('没有 agents.toml 直接 fail', async () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-doc3-'));
  const { ok, items } = await runDoctor(empty, 3997);
  assert.equal(ok, false);
  assert.ok(items.some((i) => i.level === 'fail' && i.title.includes('agents.toml')));
});
