// 安全边界的三处硬约束，都是外部审计指出后补的：
// 1. LAN 模式必须有令牌，回环地址免令牌（C-1）
// 2. 产物预览必须是不透明源（C-2）：默认连脚本都不给
// 3. 配置写入必须串行，否则「读整份 → 改 → 重写」会互相覆盖（M5）
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { authRequired, isLoopbackAddr, tokenMatches, tokenFromRequest, loadOrCreateToken } =
  await import('../src/kernel/auth.ts');
const { previewHeaders, isActiveDoc } = await import('../src/kernel/preview.ts');
const { mutateConfig } = await import('../src/kernel/config-lock.ts');

test('只有绑回环才免令牌；绑 0.0.0.0 或具体网卡都要', () => {
  assert.equal(authRequired('127.0.0.1'), false);
  assert.equal(authRequired('localhost'), false);
  assert.equal(authRequired('::1'), false);
  assert.equal(authRequired('0.0.0.0'), true);
  assert.equal(authRequired('192.168.x.x'), true);
});

test('回环来源免令牌，局域网来源不免', () => {
  assert.equal(isLoopbackAddr('127.0.0.1'), true);
  assert.equal(isLoopbackAddr('127.0.0.5'), true);
  assert.equal(isLoopbackAddr('::1'), true);
  assert.equal(isLoopbackAddr('::ffff:127.0.0.1'), true);
  assert.equal(isLoopbackAddr('192.168.x.x'), false);
  assert.equal(isLoopbackAddr(undefined), false);
});

test('令牌比较：长度不同直接拒，相等才放行', () => {
  assert.equal(tokenMatches('abc', 'abc'), true);
  assert.equal(tokenMatches('abc', 'abd'), false);
  assert.equal(tokenMatches('abc', 'abcd'), false);
  assert.equal(tokenMatches('', 'abc'), false);
  assert.equal(tokenMatches('abc', ''), false);
});

test('令牌可以从头、query、cookie 三处取到', () => {
  const q = new URLSearchParams('token=from-query');
  assert.deepEqual(tokenFromRequest({ 'x-ma-token': 'h' }, new URLSearchParams()), {
    token: 'h',
    fromQuery: false,
  });
  assert.deepEqual(tokenFromRequest({}, q), { token: 'from-query', fromQuery: true });
  assert.deepEqual(tokenFromRequest({ cookie: 'a=1; ma_token=cook%2Bie' }, new URLSearchParams()), {
    token: 'cook+ie',
    fromQuery: false,
  });
  assert.equal(tokenFromRequest({}, new URLSearchParams()).token, '');
});

test('令牌落盘后重启不变（否则手机上存的书签每次失效）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-token-'));
  const f = path.join(dir, 'hub.token');
  const a = loadOrCreateToken(f);
  const b = loadOrCreateToken(f);
  assert.equal(a, b);
  assert.ok(a.length >= 16);
});

test('HTML/SVG 是主动文档，图片不是', () => {
  assert.equal(isActiveDoc('.html'), true);
  assert.equal(isActiveDoc('.SVG'), true);
  assert.equal(isActiveDoc('.png'), false);
  assert.equal(isActiveDoc('.md'), false);
});

test('主动文档默认沙箱且不给脚本；允许脚本时仍是不透明源', () => {
  const plain = previewHeaders('.html', false);
  assert.match(plain['Content-Security-Policy'], /(^|;\s*)sandbox(;|$)/, '必须带 sandbox');
  assert.ok(!plain['Content-Security-Policy'].includes('allow-scripts'), '默认不给脚本');
  assert.ok(!plain['Content-Security-Policy'].includes('allow-same-origin'), '绝不给同源');

  const js = previewHeaders('.html', true);
  assert.match(js['Content-Security-Policy'], /sandbox allow-scripts/);
  assert.ok(!js['Content-Security-Policy'].includes('allow-same-origin'), '给脚本也不能给同源');

  // 图片不需要 CSP，但也不能少 nosniff
  const png = previewHeaders('.png', false);
  assert.equal(png['Content-Security-Policy'], undefined);
  assert.equal(png['X-Content-Type-Options'], 'nosniff');
});

test('配置写入串行：并发改不同字段，两处都不能丢', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-cfg-'));
  const f = path.join(dir, 'agents.toml');
  fs.writeFileSync(
    f,
    [
      'schema = 1',
      '',
      '[protocol]',
      'max_summary = 200',
      'max_detail = 4000',
      '',
      '[root]',
      'id = "a"',
      'name = "主控"',
      'plugin = "codebuddy"',
      'workspace = "a"',
      'timeout_min = 10',
      'access = "write"',
      'role = "executor"',
      'model = ""',
      '',
    ].join('\n'),
    'utf8',
  );

  // 20 个并发写，每个加一个节点 + 改一次 max_summary：
  // 没有锁的话后写的会拿旧快照把前面的节点抹掉，最后只剩一两个
  await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      mutateConfig(f, (cfg) => {
        cfg.maxSummary = 200 + i;
        cfg.nodes.push({
          id: 'n' + i,
          parent: 'a',
          name: 'n' + i,
          plugin: 'codebuddy',
          workspace: 'n' + i,
          timeoutMin: 8,
          access: 'write',
          role: 'executor',
          model: '',
          extraDirs: [],
          spawned: false,
        } as never);
      }),
    ),
  );

  const { loadConfig } = await import('../src/kernel/tree.ts');
  const back = loadConfig(f);
  const ids = new Set(back.nodes.map((n) => n.id));
  for (let i = 0; i < 20; i++) assert.ok(ids.has('n' + i), `节点 n${i} 被覆盖了`);
  assert.equal(back.maxSummary, 219, '最后一次写的值要生效');
});

test('从别的目录启动，路径基准不变（不依赖 cwd）', async () => {
  const { DATA_DIR, CONFIG_FILE, PROMPTS_DIR } = await import('../src/kernel/paths.ts');
  const { execFileSync } = await import('node:child_process');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-cwd-'));
  const mod = new URL('../src/kernel/paths.ts', import.meta.url).href;
  const code = `const m = await import(${JSON.stringify(mod)});
console.log(JSON.stringify({ d: m.DATA_DIR, c: m.CONFIG_FILE, p: m.PROMPTS_DIR }));`;
  const out = execFileSync(
    process.execPath,
    ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', code],
    { cwd: tmp, encoding: 'utf8' },
  );
  const j = JSON.parse(out.trim().split(/\r?\n/).pop() as string);
  // 换 cwd 不该改变任何一项：以前这里会指到 <cwd>\.data，从 C:/ 启动就读不到库
  assert.equal(j.d, DATA_DIR);
  assert.equal(j.c, CONFIG_FILE);
  assert.equal(j.p, PROMPTS_DIR);
});
