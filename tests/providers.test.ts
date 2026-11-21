// 自定义 provider：providers.toml 能接新 CLI，不改代码。
// 这里锁住三件事：参数替换、stdin 模式、写坏时的报错。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PROVIDERS, providerOf, registerProvidersFrom } from '../src/adapters/table.ts';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-prov-'));

const file = path.join(TMP, 'providers.toml');
fs.writeFileSync(file, [
  '[provider.t_mytool]',
  'label = "My Tool"',
  `bin = ${JSON.stringify(process.execPath)}`,
  'args = "-p --model {model} {prompt}"',
  '',
  '[provider.t_pipe]',
  `bin = ${JSON.stringify(process.execPath)}`,
  'args = "-p"',
  'stdin = true',
  '',
].join('\n'), 'utf8');

test('providers.toml 注册出两个 provider', () => {
  const added = registerProvidersFrom(file);
  assert.deepEqual(added.sort(), ['t_mytool', 't_pipe']);
  assert.ok(PROVIDERS.t_mytool);
});

test('args 模板里 {model} 和 {prompt} 会被整体替换（不会被再拆开）', () => {
  const p = providerOf('t_mytool');
  const args = p.args({ prompt: '写 一个 文件', cwd: TMP, timeoutMs: 1000, access: 'write', model: 'hy4free' });
  assert.deepEqual(args.slice(0, 3), ['-p', '--model', 'hy4free']);
  assert.equal(args[3], '写 一个 文件', '带空格的提示词必须是一个参数');
  assert.equal(p.stdin, false);
});

test('stdin 模式：提示词不进 argv', () => {
  const p = providerOf('t_pipe');
  const args = p.args({ prompt: 'x', cwd: TMP, timeoutMs: 1000, access: 'write' });
  assert.deepEqual(args, ['-p']);
  assert.equal(p.stdin, true);
});

test('bin 不存在时报错，而不是起一个空进程', () => {
  const bad = path.join(TMP, 'bad.toml');
  fs.writeFileSync(bad, `[provider.t_missing]\nbin = "${path.join(TMP, 'nope.exe')}"\n`, 'utf8');
  registerProvidersFrom(bad);
  assert.throws(() => providerOf('t_missing').bin(), /不存在/);
});

test('provider 名不合法直接拒绝', () => {
  const bad = path.join(TMP, 'badname.toml');
  fs.writeFileSync(bad, `[provider."../evil"]\nbin = "x"\n`, 'utf8');
  assert.throws(() => registerProvidersFrom(bad), /不合法/);
});

test('没有 providers.toml 时静默跳过', () => {
  assert.deepEqual(registerProvidersFrom(path.join(TMP, 'nope.toml')), []);
});
