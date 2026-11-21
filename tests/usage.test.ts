// token 用量读取：从 CLI 会话日志里按工作区聚合。
// 规则有三条必须成立：只看这一轮的会话、按 messageId 去重、别的 cwd 不能混进来。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readUsageFrom } from '../src/adapters/usage.ts';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-usage-'));
const DIR = path.join(ROOT, 'proj-demo');
fs.mkdirSync(DIR, { recursive: true });
const CWD = path.join(os.tmpdir(), 'ma-ws-demo');

const line = (over: Record<string, unknown>) => JSON.stringify(over);
const usageLine = (id: string, cwd: string, input: number, output: number, total: number) => line({
  type: 'function_call',
  id,
  cwd,
  providerData: {
    messageId: id,
    rawUsage: {
      prompt_tokens: input,
      completion_tokens: output,
      total_tokens: total,
      prompt_cache_hit_tokens: 100,
      credit: 0.5,
    },
  },
});

fs.writeFileSync(path.join(DIR, 's1.jsonl'), [
  usageLine('m1', CWD, 1000, 200, 1200),
  // 同一条调用的重复行：不能算两次
  usageLine('m1', CWD, 1000, 200, 1200),
  usageLine('m2', CWD, 2000, 300, 2300),
  // 别的工作区：必须忽略
  usageLine('m9', path.join(os.tmpdir(), 'other-ws'), 9999, 999, 10998),
  line({ type: 'message', cwd: CWD, id: 'no-usage' }),
].join('\n'), 'utf8');

test('按工作区聚合，并按 messageId 去重', () => {
  const u = readUsageFrom(ROOT, CWD, Date.now() - 10_000);
  assert.ok(u);
  assert.equal(u.input, 3000);
  assert.equal(u.output, 500);
  assert.equal(u.total, 3500);
  assert.equal(u.steps, 2, '同一条调用出现两次只能算一次');
  assert.equal(u.cacheRead, 200);
});

test('别的轮次的会话文件不参与统计', () => {
  // since 设到未来：文件 mtime 落在窗口之外
  assert.equal(readUsageFrom(ROOT, CWD, Date.now() + 60_000), null);
});

test('工作区对不上就返回 null，不拿别人的数字冒充', () => {
  assert.equal(readUsageFrom(ROOT, path.join(os.tmpdir(), 'nope'), Date.now() - 10_000), null);
});

test('会话目录不存在时安静返回 null', () => {
  assert.equal(readUsageFrom(path.join(ROOT, 'missing'), CWD, Date.now() - 10_000), null);
});
