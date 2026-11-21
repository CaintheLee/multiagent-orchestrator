// 隔离的护栏：同一个节点被两个任务同时用，路径必须分开。
// 这条如果坏了，两个任务的产物会互相覆盖，且不可逆。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveWorkspace, workspaceIsIsolated, type NodeConfig } from '../src/kernel/tree.ts';

const ROOT = '<repo>';

function mk(workspace: string): NodeConfig {
  return {
    id: 'b', parent: 'a', name: '执行者', plugin: 'codebuddy',
    workspace, timeoutMin: 8, access: 'write', role: 'executor', model: 'hy4free', extraDirs: [],
  };
}

test('两个任务用同一节点，路径必须不同', () => {
  const n = mk('b');
  const a = resolveWorkspace(n, 7, ROOT);
  const b = resolveWorkspace(n, 8, ROOT);
  assert.notEqual(a, b, '不同任务不能共用目录');
  assert.ok(a.includes('t7'), '路径要带任务号');
  assert.ok(b.includes('t8'));
});

test('同一任务同一节点，路径稳定', () => {
  const n = mk('b');
  assert.equal(resolveWorkspace(n, 7, ROOT), resolveWorkspace(n, 7, ROOT));
});

test('短名会被放到 .sandbox 下', () => {
  const p = resolveWorkspace(mk('b'), 7, ROOT);
  assert.ok(p.includes('.sandbox'), '必须在 .sandbox 里');
  assert.ok(p.endsWith('b'), '末级是节点名');
});

test('绝对路径的原样返回，作为老配置兼容', () => {
  const p = resolveWorkspace(mk('D:/old/place'), 7, ROOT);
  assert.equal(p, 'D:/old/place');
});

test('能区分配置是否支持隔离', () => {
  assert.equal(workspaceIsIsolated(mk('b')), true);
  assert.equal(workspaceIsIsolated(mk('D:/old/place')), false);
  assert.equal(workspaceIsIsolated(mk('')), false);
});

test('空 workspace 直接报错，不静默兜底', () => {
  assert.throws(() => resolveWorkspace(mk(''), 7, ROOT), /空的/);
});

test('相对路径和带分隔符的 workspace 一律拒（否则能跑出 .sandbox）', () => {
  for (const bad of ['../escape', './here', 'a/b', 'a\\b', '.', '..']) {
    assert.throws(() => resolveWorkspace(mk(bad), 7, ROOT), /不安全/, `「${bad}」应该被拒`);
  }
});

test('超长或含非法字符的短名也拒', () => {
  assert.throws(() => resolveWorkspace(mk('a'.repeat(20)), 7, ROOT), /不安全/);
  assert.throws(() => resolveWorkspace(mk('a b'), 7, ROOT), /不安全/);
});

test('隔离判定和新规则一致：相对路径不算隔离', () => {
  assert.equal(workspaceIsIsolated(mk('../escape')), false);
  assert.equal(workspaceIsIsolated(mk('b')), true);
});
