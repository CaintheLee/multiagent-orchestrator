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

// ---- 内置四家的参数形态 ----
// 这些字符串直接进 argv，改错了整条线就跑不起来。四家各有各的坑：
// codex 的提示词必须走 stdin（含换行的 argv 会让它静默卡死）；
// 只有 codex 有真只读；claude / gemini 的参数是照约定写的，没在本机跑过。
import { providerNames, supportsReadOnly } from '../src/adapters/table.ts';

const base = { prompt: '做点事', cwd: TMP, timeoutMs: 1000, access: 'write' };

test('codex：提示词走 stdin，access 决定 sandbox 档位', () => {
  const p = PROVIDERS.codex;
  assert.equal(p.stdin, true, 'argv 里带换行会让 codex 静默卡死');
  const w = p.args({ ...base, access: 'write' });
  assert.deepEqual(w.slice(0, 3), ['exec', '--skip-git-repo-check', '--sandbox']);
  assert.equal(w[3], 'workspace-write');
  assert.ok(!w.includes(base.prompt), '提示词不能出现在 argv 里');
  assert.equal(p.args({ ...base, access: 'read' })[3], 'read-only');
});

test('codebuddy：-p -y + 可选 model + prompt', () => {
  const p = PROVIDERS.codebuddy;
  assert.equal(p.stdin, false);
  assert.deepEqual(p.args({ ...base }), ['-p', '-y', base.prompt]);
  assert.deepEqual(p.args({ ...base, model: 'x1' }), ['-p', '-y', '--model', 'x1', base.prompt]);
});

test('claude / gemini：-p + 可选 model + prompt，且不声称只读', () => {
  for (const name of ['claude', 'gemini']) {
    const p = PROVIDERS[name];
    assert.equal(p.stdin, false, name);
    assert.deepEqual(p.args({ ...base }), ['-p', base.prompt], name);
    assert.deepEqual(p.args({ ...base, model: 'm' }), ['-p', '--model', 'm', base.prompt], name);
    assert.notEqual(p.supportsReadOnly, true, name + ' 没验证过只读，不能声称支持');
    assert.notEqual(p.verified, true, name + ' 没在本机跑过，不能标已实测');
  }
});

test('只有 codex 支持真只读', () => {
  assert.equal(supportsReadOnly('codex'), true);
  for (const n of ['codebuddy', 'claude', 'gemini']) {
    assert.equal(supportsReadOnly(n), false, n + ' 的 read 只是装饰');
  }
  assert.equal(supportsReadOnly('不存在的'), false);
});

test('四家都在表里，且有 label 与 bin', () => {
  for (const n of ['codex', 'codebuddy', 'claude', 'gemini']) {
    assert.ok(providerNames().includes(n), n + ' 应当在表里');
    assert.ok(PROVIDERS[n].label, n + ' 缺 label');
    assert.equal(typeof PROVIDERS[n].bin, 'function', n + ' 缺 bin');
  }
});

test('自定义 provider 不声称只读：它可能只是个包装脚本', () => {
  assert.equal(supportsReadOnly('t_mytool'), false);
});
