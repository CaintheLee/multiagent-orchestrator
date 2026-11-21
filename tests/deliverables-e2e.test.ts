// 端到端：任务点了名的交付物不在盘上时，收口轮不许判通过。
// 用的是真 runTree + 假模型，锁住 #45 那条路（六项交付全缺、照样 done）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Config, NodeConfig } from '../src/kernel/tree.ts';
import type { RunOpts } from '../src/adapters/table.ts';

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-deliv-e2e-'));
process.env.MA_DATA_DIR = DATA;

const { openDB, createTask } = await import('../src/store/db.ts');
const { runTree } = await import('../src/runner/runTree.ts');

const DB = openDB(path.join(DATA, 'test.db'));
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-deliv-work-'));
const FENCE = 'agent-autoloop';

function node(id: string, parent: string): NodeConfig {
  return {
    id,
    parent,
    name: id,
    plugin: 'codebuddy',
    workspace: id,
    timeoutMin: 5,
    access: 'write',
    role: id === 'a' ? 'dispatcher' : 'executor',
    model: 'hy4free',
    extraDirs: [],
  };
}

function payload(receipt: Record<string, unknown>) {
  return {
    exitCode: 0,
    stdout: '做完了。\n\n```' + FENCE + '\n' + JSON.stringify(receipt) + '\n```\n',
    stderr: '',
    ms: 1,
    killed: false,
    canceled: false,
  };
}

test('交付清单没落地：收口判通过会被改成 rework，并逐条点名', async () => {
  const nodes = [node('a', ''), node('b', 'a')];
  const cfg: Config = { schema: 1, nodes, root: nodes[0], maxSummary: 200, maxDetail: 4000 };
  const absent = path.join(ROOT, 'never-written', 'audit.md');
  const task = ['做四件事，四段串行。', '', '━━━ 交付清单 ━━━', `1. ${absent}`, ''].join('\n');

  const forNode = (prompt: string) =>
    prompt.includes('节点 b') ? 'b' : prompt.includes('节点 a') ? 'a' : '?';
  const isReview = (prompt: string) => prompt.includes('## 下级交回的结果');

  const logs: string[] = [];
  const taskId = createTask(DB, { master: 'a', task, configSnapshot: '{}' });
  let aReview = 0;

  const rec = await runTree(cfg, cfg.root, task, (l) => logs.push(l), {
    db: DB,
    taskId,
    root: ROOT,
    runner: (async (_p: string, o: RunOpts) => {
      const id = forNode(o.prompt);
      if (id === 'b') return payload({ summary: '审计完了', dispatch: [], evidence: [] });
      if (!isReview(o.prompt)) {
        return payload({ summary: '派第一段', dispatch: [{ to: 'b', task: '做第一段' }], evidence: [] });
      }
      aReview += 1;
      // 第一次收口：照旧写 dispatch [] 想收场；第二次：老实停下来等人
      if (aReview === 1) return payload({ summary: '第一段过了，收口', dispatch: [], evidence: [] });
      return payload({ summary: '清单没落地，等人确认', dispatch: [], question: '还差 5 项交付，继续吗', evidence: [] });
    }) as never,
  });

  const log = logs.join('\n');
  assert.match(log, /交付清单里 1 项还没落盘/);
  assert.match(log, /REWORK/);
  assert.doesNotMatch(log, /PASS/);
  // 落库的结论也得是 rework：只在日志里改不算数
  const rows = DB.prepare('SELECT verdict, state FROM runs WHERE task_id = ? AND phase = ?')
    .all(taskId, 'review') as Array<{ verdict: string | null; state: string }>;
  assert.equal(rows[0]?.verdict, 'rework');
  assert.equal(rows[0]?.state, 'done');
});
