// 外部可写目录 + 强制备份。锁住四件事——
// 1. 白名单目录里的产物能通过，并复制一份到 <工作区>/_external/
// 2. 不在白名单的外部路径仍然判越界（#40 那种静默白跑不能复活）
// 3. 备份失败必须判失败，不能默默放行
// 4. 工作区内的产物行为不变（不产生备份）
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { checkArtifacts, inside } = await import('../src/kernel/settle.ts');
import type { NodeConfig } from '../src/kernel/tree.ts';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-extra-'));
const ws = path.join(tmp, 'ws');
const shared = path.join(tmp, 'shared');
fs.mkdirSync(ws, { recursive: true });
fs.mkdirSync(shared, { recursive: true });

const node = {
  id: 'a',
  parent: '',
  name: '主控',
  plugin: 'codebuddy',
  workspace: ws,
  timeoutMin: 30,
  access: 'write',
  role: 'dispatcher',
  model: '',
  extraDirs: [shared],
} as unknown as NodeConfig;

const receipt = (paths: string[]) =>
  ({ artifacts: paths.map((p) => ({ path: p, kind: 'md', bytes: 0 })) }) as never;

test('白名单目录里的产物通过，并备份到工作区 _external/', () => {
  const f = path.join(shared, 'plan.md');
  fs.writeFileSync(f, '第一行\n第二行\n', 'utf8');

  const { ok, bad, backedUp } = checkArtifacts(receipt([f]), node, { extraDirs: [shared] });

  assert.deepEqual(bad, [], '白名单内的文件不该被判越界');
  assert.equal(ok.length, 1);
  assert.equal(ok[0].path, fs.realpathSync(f), '原路径要保留，产物面板显示的是它');
  assert.ok(ok[0].backup, '必须有备份路径');
  assert.ok(inside(ws, ok[0].backup!), '备份必须在工作区内：' + ok[0].backup);
  assert.equal(fs.readFileSync(ok[0].backup!, 'utf8'), '第一行\n第二行\n', '备份内容要与原件一致');
  assert.equal(backedUp.length, 1);
});

test('不在白名单的外部路径仍然判越界', () => {
  const out = path.join(tmp, 'elsewhere');
  fs.mkdirSync(out, { recursive: true });
  const f = path.join(out, 'x.md');
  fs.writeFileSync(f, 'x', 'utf8');

  const { ok, bad, stray } = checkArtifacts(receipt([f]), node, { extraDirs: [shared] });
  assert.equal(ok.length, 0);
  assert.equal(bad.length, 1);
  assert.match(bad[0], /既不在工作区/);
  // 失败也要留档：只报一句「产物有问题」，人就不知道东西写在哪（#40）
  assert.equal(stray.length, 1);
  assert.equal(stray[0].path, fs.realpathSync(f));
  assert.equal(stray[0].bytes, 1, '拿得到大小就要记下来');
  assert.match(stray[0].why, /不在工作区/);
});

test('没配 extra_dirs 时，给的是「怎么配」的提示而不是无解的报错', () => {
  const f = path.join(shared, 'plan2.md');
  fs.writeFileSync(f, 'y', 'utf8');
  const { bad } = checkArtifacts(receipt([f]), node, { extraDirs: [] });
  assert.match(bad[0], /extra_dirs/);
});

test('备份失败必须判失败，不能静默放行', () => {
  const f = path.join(shared, 'plan3.md');
  fs.writeFileSync(f, 'z', 'utf8');
  // 把工作区指向一个普通文件：mkdir _external 会 ENOTDIR，备份必失败
  const fake = path.join(tmp, 'not-a-dir');
  fs.writeFileSync(fake, 'x', 'utf8');
  // 故意造一个「工作区是普通文件」的非法节点：类型上不合法，运行时要能兜住
  const broken: NodeConfig = { ...node, workspace: fake };

  const { ok, bad } = checkArtifacts(receipt([f]), broken, { extraDirs: [shared] });
  assert.equal(ok.length, 0, '备份不成就不能登记为已交付');
  assert.match(bad[0], /备份/);
});

test('文件不存在时也留一条 stray，说明它想写哪', () => {
  const ghost = path.join(shared, 'ghost.md');
  const { ok, bad, stray } = checkArtifacts(receipt([ghost]), node, { extraDirs: [shared] });
  assert.equal(ok.length, 0);
  assert.equal(bad.length, 1);
  assert.equal(stray.length, 1);
  assert.equal(stray[0].bytes, 0);
  assert.match(stray[0].why, /不存在/);
});

test('工作区内的产物不产生备份，行为与之前一致', () => {
  const f = path.join(ws, 'local.md');
  fs.writeFileSync(f, 'local', 'utf8');
  const { ok, bad } = checkArtifacts(receipt([f]), node, { extraDirs: [shared] });
  assert.deepEqual(bad, []);
  assert.equal(ok[0].backup, undefined);
  assert.equal(ok[0].bytes, 5);
});

test('软链指到白名单外仍然拦得住', () => {
  const out = path.join(tmp, 'secret');
  fs.mkdirSync(out, { recursive: true });
  const real = path.join(out, 's.md');
  fs.writeFileSync(real, 'secret', 'utf8');
  const link = path.join(shared, 'link.md');
  try {
    fs.symlinkSync(real, link);
  } catch {
    return; // Windows 没权限建软链，跳过
  }
  const { bad } = checkArtifacts(receipt([link]), node, { extraDirs: [shared] });
  assert.equal(bad.length, 1, '软链解析后落在白名单外，必须拦');
});

// 收口轮会把自己核过的下级产物列进 artifacts。那是引用，不是自己的交付——
// 不认这条，主控每轮收口都会被判「产物越界」，任务直接 failed（#42 的真实原因）。
test('收口轮引用下级工作区里的产物：不算越界，也不产生备份', () => {
  const kidWs = path.join(tmp, 'kid');
  fs.mkdirSync(kidWs, { recursive: true });
  const f = path.join(kidWs, 'b_asset_inventory.csv');
  fs.writeFileSync(f, 'a,b\n1,2\n', 'utf8');

  const { ok, bad, backedUp } = checkArtifacts(receipt([f]), node, {
    extraDirs: [shared],
    refDirs: [kidWs],
  });
  assert.deepEqual(bad, [], '下级产物是引用，不该判越界');
  assert.equal(ok.length, 1);
  assert.equal(ok[0].ref, true, '要标成 ref，快照里才不会把它当自己的交付');
  assert.equal(backedUp.length, 0, '引用不复制备份，否则同一份文件会有两份');
});

test('refDirs 之外的外部路径仍然拦', () => {
  const out = path.join(tmp, 'other-kid');
  fs.mkdirSync(out, { recursive: true });
  const f = path.join(out, 'x.csv');
  fs.writeFileSync(f, 'x', 'utf8');
  const { bad } = checkArtifacts(receipt([f]), node, { extraDirs: [shared], refDirs: [path.join(tmp, 'kid')] });
  assert.equal(bad.length, 1);
});
