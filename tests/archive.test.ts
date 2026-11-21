// 归档区：任务结束后产物要有一份长期可查的副本 + manifest。
//
// 锁住四件事：①真的复制了文件 ②清单带字节数与 sha256 ③不在盘上的进 missing
// ④归档只复制、不动原件（这条最容易写错成「移动」，那样 .sandbox 就空了）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { archiveTask, readManifest, removeArchive } from '../src/kernel/archive.ts';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ma-arch-'));
}

function sha(p: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

test('归档复制产物、写 manifest，原件不动', () => {
  const ws = tmpDir();
  const arch = tmpDir();
  const a = path.join(ws, 'report.md');
  const b = path.join(ws, 'data.csv');
  fs.writeFileSync(a, '第一行\n第二行\n');
  fs.writeFileSync(b, 'a,b\n1,2\n');

  const dir = archiveTask({
    taskId: 7,
    state: 'done',
    task: '做点东西',
    createdAt: Date.parse('2026-11-21T10:00:00Z'),
    endedAt: Date.parse('2026-11-21T10:12:00Z'),
    project: { name: '示例', root: 'D:/YourProject' },
    runs: [
      { id: 1, node: 'a', state: 'done', ms: 1000, summary: '派活', artifacts: [] },
      {
        id: 2, node: 'b', state: 'done', ms: 2000, summary: '交了',
        artifacts: [{ path: a, bytes: 0 }, { path: b, bytes: 0 }],
      },
    ],
    root: arch,
    now: new Date('2026-11-21T10:12:30Z'),
  });

  assert.ok(dir, '应当创建归档目录');
  assert.match(dir!, /2026-11[\\/]t7$/);

  // 原件还在
  assert.ok(fs.existsSync(a), '归档是复制，不能把 .sandbox 里的原件搬走');
  assert.ok(fs.existsSync(b));

  const mf = readManifest(7, arch);
  assert.ok(mf, 'manifest.json 要能读回来');
  assert.equal(mf!.stats.files, 2);
  // 中文按 UTF-8 是 3 字节，直接按磁盘实际大小算，别硬编码
  assert.equal(mf!.stats.bytes, fs.statSync(a).size + fs.statSync(b).size);
  assert.equal(mf!.artifacts.length, 2);
  assert.equal(mf!.runs.length, 2);
  assert.equal(mf!.state, 'done');

  // 每个产物都带 sha256 且与源一致
  for (const art of mf!.artifacts) {
    assert.equal(art.sha256, sha(art.from), 'sha256 要与源文件一致：' + art.from);
    assert.ok(art.kept, '应当复制成功');
    assert.ok(fs.existsSync(path.join(dir!, art.kept!)), '清单里的 kept 要真实存在');
  }
});

test('登记了但不在盘上的产物进 missing，不抛错', () => {
  const ws = tmpDir();
  const arch = tmpDir();
  const gone = path.join(ws, 'never-written.md');
  const ok = path.join(ws, 'ok.md');
  fs.writeFileSync(ok, 'x');

  const dir = archiveTask({
    taskId: 8,
    state: 'failed',
    task: '半途失败',
    createdAt: Date.now(),
    endedAt: Date.now(),
    project: { name: '', root: '' },
    runs: [{ id: 1, node: 'b', state: 'failed', ms: 0, artifacts: [{ path: gone }, { path: ok }] }],
    root: arch,
    now: new Date('2026-11-21T10:00:00Z'),
  });
  assert.ok(dir);
  const mf = readManifest(8, arch)!;
  assert.deepEqual(mf.missing, [gone]);
  assert.equal(mf.stats.files, 1);
});

test('同一个文件被多轮登记只复制一次', () => {
  const ws = tmpDir();
  const arch = tmpDir();
  const f = path.join(ws, 'same.md');
  fs.writeFileSync(f, 'x');

  archiveTask({
    taskId: 9, state: 'done', task: 't', createdAt: Date.now(), endedAt: Date.now(),
    project: { name: '', root: '' },
    runs: [
      { id: 1, node: 'a', state: 'done', ms: 0, artifacts: [{ path: f }] },
      { id: 2, node: 'a', state: 'done', ms: 0, artifacts: [{ path: f }] },
    ],
    root: arch, now: new Date('2026-11-21T10:00:00Z'),
  });
  const mf = readManifest(9, arch)!;
  assert.equal(mf.artifacts.length, 1, '同一路径只记一条');
  assert.equal(mf.stats.files, 1);
});

test('同名不同源不会互相覆盖', () => {
  const w1 = tmpDir();
  const w2 = tmpDir();
  const arch = tmpDir();
  const f1 = path.join(w1, 'out.md');
  const f2 = path.join(w2, 'out.md');
  fs.writeFileSync(f1, 'AAA');
  fs.writeFileSync(f2, 'BBBB');

  archiveTask({
    taskId: 10, state: 'done', task: 't', createdAt: Date.now(), endedAt: Date.now(),
    project: { name: '', root: '' },
    runs: [
      { id: 1, node: 'b', state: 'done', ms: 0, artifacts: [{ path: f1 }] },
      { id: 2, node: 'b', state: 'done', ms: 0, artifacts: [{ path: f2 }] },
    ],
    root: arch, now: new Date('2026-11-21T10:00:00Z'),
  });
  const mf = readManifest(10, arch)!;
  assert.equal(mf.stats.files, 2, '两份同名文件都要留下');
  const sizes = mf.artifacts.map((a) => a.bytes).sort();
  assert.deepEqual(sizes, [3, 4], '内容不能互相覆盖：' + JSON.stringify(sizes));
});

test('删除归档：只删自己的目录，不影响别的任务', () => {
  const arch = tmpDir();
  const ws = tmpDir();
  const f = path.join(ws, 'x.md');
  fs.writeFileSync(f, 'x');
  for (const id of [11, 12]) {
    archiveTask({
      taskId: id, state: 'done', task: 't', createdAt: Date.now(), endedAt: Date.now(),
      project: { name: '', root: '' },
      runs: [{ id: 1, node: 'b', state: 'done', ms: 0, artifacts: [{ path: f }] }],
      root: arch, now: new Date('2026-11-21T10:00:00Z'),
    });
  }
  const removed = removeArchive(11, arch);
  assert.ok(removed);
  assert.equal(readManifest(11, arch), null);
  assert.ok(readManifest(12, arch), '别的任务不能被连带删掉');
});
