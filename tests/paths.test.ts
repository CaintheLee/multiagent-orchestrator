// 路径归属是「越界写文件」和「偷读外部文件」的唯一关口，必须逐条钉死。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkArtifacts, inside } from '../src/kernel/settle.ts';
import type { NodeConfig } from '../src/kernel/tree.ts';
import type { Receipt } from '../src/protocol/schema.ts';

function mkNode(workspace: string): NodeConfig {
  return {
    id: 'b', parent: 'a', name: '执行者', plugin: 'codebuddy',
    workspace, timeoutMin: 8, access: 'write', role: 'executor', model: 'hy4free',
  };
}

function tmpDir(): string {
  // 临时目录本身可能是软链（macOS 的 /var → /private/var），先解析再当根
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ma-paths-')));
}

function receipt(paths: string[]): Receipt {
  return {
    summary: 'x',
    artifacts: paths.map((p) => ({ path: p, kind: 'txt', bytes: 0 })),
    dispatch: [],
    evidence: [],
  };
}

test('inside：根目录自己不算在根里', () => {
  const root = tmpDir();
  assert.equal(inside(root, root), false);
});

test('inside：以两点开头的合法文件名不能被误判成越界', () => {
  const root = tmpDir();
  // 这就是老写法 startsWith('..') 会误杀的 case
  assert.equal(inside(root, path.join(root, '..notes.md')), true);
  assert.equal(inside(root, path.join(root, '..foo', 'bar.txt')), true);
});

test('inside：真的跳出去要判 false', () => {
  const root = tmpDir();
  assert.equal(inside(root, path.join(root, '..')), false);
  assert.equal(inside(root, path.join(root, '..', 'x.txt')), false);
  assert.equal(inside(root, path.join(root, 'a', '..', '..', 'x.txt')), false);
});

test('只给文件名时按工作区解析，不按进程 cwd', () => {
  const root = tmpDir();
  fs.writeFileSync(path.join(root, 'r_b.txt'), '内容');

  const r = checkArtifacts(receipt(['r_b.txt']), mkNode(root));

  assert.equal(r.bad.length, 0, '相对路径不该被当成越界：' + r.bad.join('; '));
  assert.equal(r.ok.length, 1);
  assert.equal(r.ok[0].path, path.join(root, 'r_b.txt'));
});

test('绝对路径落在工作区外 → 拒绝', () => {
  const root = tmpDir();
  const outside = path.join(tmpDir(), 'secret.txt');
  fs.writeFileSync(outside, '不该被读到');

  const r = checkArtifacts(receipt([outside]), mkNode(root));

  assert.equal(r.ok.length, 0);
  assert.match(r.bad[0], /不在工作区/);
});

test('工作区里的软链指向外部 → 拒绝（否则 evidence 会读到外部内容）', (t) => {
  const root = tmpDir();
  const outside = path.join(tmpDir(), 'secret.txt');
  fs.writeFileSync(outside, '绝密内容');
  const link = path.join(root, 'link.txt');
  try {
    fs.symlinkSync(outside, link, 'file');
  } catch {
    t.skip('当前账户没有创建符号链接的权限，跳过');
    return;
  }

  const r = checkArtifacts(receipt([link]), mkNode(root));

  assert.equal(r.ok.length, 0, '软链解析后在外面，必须拒绝');
  assert.match(r.bad[0], /不在工作区/);
});

test('文件不存在 / 目录 / 空父目录都报出来，不静默通过', () => {
  const root = tmpDir();
  fs.mkdirSync(path.join(root, 'sub'));

  const r = checkArtifacts(receipt(['nope.txt', 'sub']), mkNode(root));

  assert.equal(r.ok.length, 0);
  assert.match(r.bad[0], /文件不存在/);
  assert.match(r.bad[1], /不是一个文件/);
});

test('产物路径归一成真实路径，后续读取不会又走回软链', () => {
  const root = tmpDir();
  fs.writeFileSync(path.join(root, 'x.txt'), '内容');
  const r = checkArtifacts(receipt(['x.txt']), mkNode(root));
  assert.equal(r.ok.length, 1);
  assert.equal(fs.realpathSync(r.ok[0].path), r.ok[0].path);
});

test('工作区里的目录联接指向外部 → 拒绝（Windows 下 junction 不需要管理员权限）', (t) => {
  const root = tmpDir();
  const outside = tmpDir();
  fs.writeFileSync(path.join(outside, 'secret.txt'), '绝密内容');
  const jump = path.join(root, 'jump');
  try {
    fs.symlinkSync(outside, jump, 'junction');
  } catch {
    t.skip('当前环境不支持 junction');
    return;
  }

  const r = checkArtifacts(receipt([path.join(jump, 'secret.txt')]), mkNode(root));

  assert.equal(r.ok.length, 0, '穿过联接后已经在工作区外，必须拒绝');
  assert.match(r.bad[0], /不在工作区/);
});
