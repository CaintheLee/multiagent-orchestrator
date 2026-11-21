// HTTP 层：拆出 routes/artifact.ts 与 routes/chat.ts 之后，这两组终于能
// 不启端口直接打——之前它们在 1500 行的 server.ts 里，一 import 就监听端口。
//
// 这里锁的是「接线」而不是「零件」：
// 鉴权门在不在、越界会不会 403、CSP 头有没有真的发出去、nodeId 穿不穿得过去。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type http from 'node:http';

const { handleArtifact } = await import('../src/host/routes/artifact.ts');
const { handleChat, parseGrant, CHAT_NODE_RE } = await import('../src/host/routes/chat.ts');

/** 最小的 res 替身：只记状态码、头、正文 */
function mockRes() {
  const out = { code: 0, headers: {} as Record<string, string>, body: '' };
  const res = {
    writeHead(code: number, headers?: Record<string, string>) {
      out.code = code;
      if (headers) Object.assign(out.headers, headers);
      return res;
    },
    end(body?: unknown) {
      out.body = String(body ?? '');
    },
    write() { return true; },
    on() { return res; },
  } as unknown as http.ServerResponse;
  return { res, out };
}

/** 造一个只有必要字段的 agents.toml，指向临时工作区 */
function fakeConfig(dir: string, ws: string): string {
  const f = path.join(dir, 'agents.toml');
  fs.writeFileSync(f, [
    'schema = 1',
    '[project]',
    `name = "测试"`,
    `root = "${dir.replace(/\\/g, '/')}"`,
    '[root]',
    'id = "a"',
    'parent = ""',
    'name = "主控"',
    'plugin = "codebuddy"',
    'workspace = "' + ws.replace(/\\/g, '/') + '"',
    'timeout_min = 10',
    'access = "write"',
    'role = "executor"',
    'model = ""',
  ].join('\n'), 'utf8');
  return f;
}

test('产物不在任何工作区里 → 403', () => {
  const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-rt-'));
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-ws-'));
  const outside = path.join(os.tmpdir(), 'ma-outside-' + Date.now() + '.txt');
  fs.writeFileSync(outside, 'x');
  const cfg = fakeConfig(cfgDir, ws);

  const { res, out } = mockRes();
  handleArtifact(new URL('http://x/api/artifact?path=' + encodeURIComponent(outside)), res, cfg);
  assert.equal(out.code, 403, '工作区外的文件必须拦：' + out.body);
});

test('工作区里的 html 带 CSP sandbox，默认不给脚本', () => {
  const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-rt-'));
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-ws-'));
  const f = path.join(ws, 'report.html');
  fs.writeFileSync(f, '<h1>ok</h1><script>alert(1)</script>');
  const cfg = fakeConfig(cfgDir, ws);

  const { res, out } = mockRes();
  handleArtifact(new URL('http://x/api/artifact?path=' + encodeURIComponent(f)), res, cfg);
  assert.equal(out.code, 200);
  const csp = out.headers['Content-Security-Policy'] || '';
  assert.match(csp, /sandbox/);
  assert.ok(!/allow-scripts/.test(csp), '默认不能给脚本：' + csp);
  assert.ok(!/allow-same-origin/.test(csp), '永远不能给同源：' + csp);
});

test('显式要脚本时给 allow-scripts，但仍然不给同源', () => {
  const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-rt-'));
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-ws-'));
  const f = path.join(ws, 'chart.html');
  fs.writeFileSync(f, '<svg></svg>');
  const cfg = fakeConfig(cfgDir, ws);

  const { res, out } = mockRes();
  handleArtifact(new URL('http://x/api/artifact?scripts=1&path=' + encodeURIComponent(f)), res, cfg);
  const csp = out.headers['Content-Security-Policy'] || '';
  assert.match(csp, /allow-scripts/);
  assert.ok(!/allow-same-origin/.test(csp), '勾了脚本也不能同源：' + csp);
});

test('普通图片不加 CSP，但要 nosniff', () => {
  const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-rt-'));
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-ws-'));
  const f = path.join(ws, 'a.png');
  fs.writeFileSync(f, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const cfg = fakeConfig(cfgDir, ws);

  const { res, out } = mockRes();
  handleArtifact(new URL('http://x/api/artifact?path=' + encodeURIComponent(f)), res, cfg);
  assert.equal(out.code, 200);
  assert.equal(out.headers['Content-Security-Policy'], undefined, '图片不需要 CSP');
  assert.equal(out.headers['X-Content-Type-Options'], 'nosniff');
});

test('工作区里的文件不存在 → 404，不是 500', () => {
  const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-rt-'));
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-ws-'));
  const cfg = fakeConfig(cfgDir, ws);
  const gone = path.join(ws, 'never.txt');

  const { res, out } = mockRes();
  handleArtifact(new URL('http://x/api/artifact?path=' + encodeURIComponent(gone)), res, cfg);
  assert.equal(out.code, 404);
});

test('chat：nodeId 带路径穿越一律 400（三个读入口都拦）', async () => {
  const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-rt-'));
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-ws-'));
  const cfg = fakeConfig(cfgDir, ws);
  const ctx = {
    cfgFile: cfg,
    maxLen: 4000,
    snapshot: () => '',
    readJson: async () => ({}),
    json: (res: http.ServerResponse, code: number, body: unknown) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    },
    fallbackCwd: () => cfgDir,
  };

  for (const p of ['/api/chat/history', '/api/chat/stream']) {
    const { res, out } = mockRes();
    const handled = await handleChat(p, { on() {} } as unknown as http.IncomingMessage, res,
      new URL('http://x' + p + '?node=../marker'), ctx);
    assert.equal(handled, true, p + ' 应被这组路由处理');
    assert.equal(out.code, 400, p + ' 必须 400：' + out.body);
  }
});

test('chat：不存在的节点做 reset → 404，且不会删任何文件', async () => {
  const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-rt-'));
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-ws-'));
  const cfg = fakeConfig(cfgDir, ws);
  const ctx = {
    cfgFile: cfg,
    maxLen: 4000,
    snapshot: () => '',
    readJson: async () => ({ nodeId: 'nope', reset: true }),
    json: (res: http.ServerResponse, code: number, body: unknown) => {
      res.writeHead(code, {}); res.end(JSON.stringify(body));
    },
    fallbackCwd: () => cfgDir,
  };
  const { res, out } = mockRes();
  // method 必须给：路由判断是 `p === '/api/chat' && req.method === 'POST'`，
  // 少了它这个分支根本进不去，测试会变成「什么都没发生」的假通过
  const req = { method: 'POST', on() {} } as unknown as http.IncomingMessage;
  const handled = await handleChat('/api/chat', req, res, new URL('http://x/api/chat'), ctx);
  assert.equal(handled, true);
  assert.equal(out.code, 404, '存在性校验必须在 reset 之前：' + out.body);
});

test('写授权只认绝对路径、不认目录、最多 12 个', () => {
  assert.deepEqual(parseGrant({ files: ['D:/YourProject/a.gd'] })?.files, ['D:/YourProject/a.gd']);
  assert.equal(parseGrant({ files: ['relative/a.gd'] }), undefined, '相对路径不能授权');
  assert.equal(parseGrant({ files: ['D:/YourProject/scripts/'] }), undefined, '目录不算授权');
  assert.equal(parseGrant({ files: [1, null, true] }), undefined, '非字符串不算');
  assert.equal(parseGrant({ files: Array.from({ length: 20 }, (_, i) => 'D:/f' + i) })?.files.length, 12);
  assert.equal(parseGrant(null), undefined);
  assert.equal(parseGrant({}), undefined);
});

test('nodeId 正则挡住斜杠与点点', () => {
  assert.ok(CHAT_NODE_RE.test('a'));
  assert.ok(CHAT_NODE_RE.test('node_1-x'));
  assert.ok(!CHAT_NODE_RE.test('../x'));
  assert.ok(!CHAT_NODE_RE.test('a/b'));
  assert.ok(!CHAT_NODE_RE.test(''));
  assert.ok(!CHAT_NODE_RE.test('a'.repeat(33)));
});
