// 取消的护栏：必须杀掉整棵树。
// 只杀直接子进程的话，孙进程会活下来继续写工作区——那些文件没人认领，也没人清理。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { killTree } from '../src/adapters/spawn.ts';

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// 父进程自己再起一个孙进程，两个都睡 60 秒
const SCRIPT = [
  "const { spawn } = require('node:child_process');",
  "const g = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 60000)'], { stdio: 'ignore', windowsHide: true });",
  'process.stdout.write(JSON.stringify({ parent: process.pid, grand: g.pid }) + "\\n");',
  'setTimeout(() => {}, 60000);',
].join('');

async function launch(): Promise<{ parent: number; grand: number; child: ReturnType<typeof spawn> }> {
  const child = spawn(process.execPath, ['-e', SCRIPT], {
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
  });
  const pids = await new Promise<{ parent: number; grand: number }>((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error('8 秒内没拿到 pid')), 8000);
    child.stdout?.on('data', (d: Buffer) => {
      buf += d.toString('utf8');
      const first = buf.split('\n')[0];
      if (!first) return;
      try {
        const j = JSON.parse(first);
        clearTimeout(timer);
        resolve(j);
      } catch {
        // 还没收全，等下一次
      }
    });
  });
  return { ...pids, child };
}

test('killTree 杀掉整棵树，孙进程不残留', async () => {
  const { parent, grand, child } = await launch();
  try {
    assert.ok(alive(parent), '父进程应在跑');
    assert.ok(alive(grand), '孙进程应在跑');

    killTree(parent);
    await new Promise((r) => setTimeout(r, 1500));

    assert.equal(alive(parent), false, '父进程应已退出');
    assert.equal(alive(grand), false, '孙进程也必须退出，否则它会继续写工作区');
  } finally {
    try { child.kill('SIGKILL'); } catch {}
  }
});

test('killTree 对不存在的 pid 不抛异常', () => {
  assert.doesNotThrow(() => killTree(0));
  assert.doesNotThrow(() => killTree(undefined));
  assert.doesNotThrow(() => killTree(999999));
});
