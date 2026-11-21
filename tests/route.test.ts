// 路由决策的单元测试：以前这些规则只能靠端到端跑树覆盖，
// 抽成 planRoutes 之后可以直接喂数据验证每一条拦截。
import test from 'node:test';
import assert from 'node:assert/strict';
import { planRoutes } from '../src/runner/route.ts';
import { MAX_REWORK } from '../src/kernel/guard.ts';
import type { NodeConfig } from '../src/kernel/tree.ts';
import type { RunRecord } from '../src/store/runs.ts';

const kid = (id: string): NodeConfig => ({
  id, parent: 'a', name: id, plugin: 'codebuddy', workspace: id,
  timeoutMin: 5, access: 'write', role: 'executor', model: '',
});

const kids = [kid('b'), kid('c')];

function rec(over: Partial<RunRecord>): RunRecord {
  return {
    id: 1, node: 'a', plugin: 'codebuddy', task: 't', state: 'done',
    startedAt: '', ms: 0, summary: 's', artifacts: [], dispatch: [], warnings: [],
    ...over,
  };
}

const plan = (over: Partial<Parameters<typeof planRoutes>[0]>) => planRoutes({
  parentId: 'a',
  dispatch: [],
  kids,
  runs: [],
  currentRunId: 99,
  approved: new Map(),
  maxFanout: 8,
  maxRework: MAX_REWORK,
  log: () => {},
  ...over,
});

test('正常派活：两条都进 list', () => {
  const p = plan({ dispatch: [{ to: 'b', task: '写 x' }, { to: 'c', task: '写 y' }] });
  assert.deepEqual(p.list.map((d) => d.to), ['b', 'c']);
  assert.equal(p.rejected, 0);
});

test('没有这个下级：拒绝且计数，不抛异常', () => {
  const p = plan({ dispatch: [{ to: 'zzz', task: 'x' }] });
  assert.equal(p.list.length, 0);
  assert.equal(p.rejected, 1);
});

test('打回到上限：这一条被跳过，并给出 SKIPPED 说明', () => {
  const runs = [
    rec({ id: 1, verdict: 'rework', dispatch: [{ to: 'b', task: '改 1' }] }),
    rec({ id: 2, verdict: 'rework', dispatch: [{ to: 'b', task: '改 2' }] }),
    rec({ id: 3, verdict: 'rework', dispatch: [{ to: 'b', task: '改 3' }] }),
  ];
  const p = plan({ dispatch: [{ to: 'b', task: '改 4' }], runs });
  assert.equal(p.list.length, 0);
  assert.equal(p.rejected, 1);
  assert.match(p.reports.join('\n'), /达到上限/);
});

test('同一段指令：第二次就跳过（当前记录必须排除）', () => {
  const same = '第一行改成大写，改完把整个文件重写一遍，别的不要动';
  const runs = [rec({ id: 5, verdict: 'rework', dispatch: [{ to: 'b', task: same }] })];
  // 当前记录就是 id=5：第一次允许
  assert.equal(plan({ dispatch: [{ to: 'b', task: same }], runs, currentRunId: 5 }).list.length, 1);
  // 下一轮（id=6）同一段话：拦下
  const p = plan({ dispatch: [{ to: 'b', task: same }], runs, currentRunId: 6 });
  assert.equal(p.list.length, 0);
  assert.match(p.reports.join('\n'), /前 80 字完全一样/);
});

test('审批文本优先：dispatch 里偷换的任务不算数', () => {
  const p = plan({
    dispatch: [{ to: 'b', task: '只写个说明' }],
    approved: new Map([['b', '真正要做的活']]),
  });
  assert.equal(p.list[0].task, '真正要做的活');
});

test('批准了但没派活：补一条', () => {
  const p = plan({ dispatch: [], approved: new Map([['c', '补的活']]) });
  assert.deepEqual(p.list, [{ to: 'c', task: '补的活' }]);
});

test('扇出超限：只跑前 N 条，其余进 dropped 并留说明', () => {
  const many = Array.from({ length: 10 }, (_, i) => ({ to: 'b', task: `任务 ${i}` }));
  const p = plan({ dispatch: many, maxFanout: 4 });
  assert.equal(p.list.length, 4);
  assert.equal(p.dropped.length, 6);
});
