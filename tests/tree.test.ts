// 跑真 runTree，但把「调模型」换成假的：不起 CLI、不花钱，专门锁住
// 多层树验收、打回上限、空 dispatch 派生这三条分支——它们以前只有口头结论，没有用例。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Config, NodeConfig } from '../src/kernel/tree.ts';
import type { RunOpts } from '../src/adapters/table.ts';
import type { RunRecord } from '../src/store/runs.ts';

// 落盘挪到临时目录：这一步必须在动态 import 之前，那几个模块在加载时就读环境变量
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-tree-data-'));
process.env.MA_DATA_DIR = DATA;

const { openDB, createTask } = await import('../src/store/db.ts');
const { runTree } = await import('../src/runner/runTree.ts');
const { decideApproval } = await import('../src/store/approvals.ts');
const { listCheckpoints } = await import('../src/store/checkpoints.ts');

const DB = openDB(path.join(DATA, 'test.db'));
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-tree-work-'));

function node(id: string, parent: string, name = id): NodeConfig {
  return {
    id,
    parent,
    name,
    plugin: 'codebuddy',
    workspace: id,
    timeoutMin: 5,
    access: 'write',
    role: id === 'a' ? 'dispatcher' : 'executor',
    model: 'hy4free',
  };
}

function cfgOf(nodes: NodeConfig[]): Config {
  return { schema: 1, nodes, root: nodes[0], maxSummary: 200, maxDetail: 4000 };
}

const FENCE = 'agent-autoloop';

function respond(receipt: Record<string, unknown>) {
  return {
    exitCode: 0,
    stdout: '做完了。\n\n```' + FENCE + '\n' + JSON.stringify(receipt) + '\n```\n',
    stderr: '',
    ms: 1,
    killed: false,
    canceled: false,
  };
}

type Runner = (plugin: string, o: RunOpts) => Promise<ReturnType<typeof respond>>;

/** 从提示词里认出「这一轮是谁、是不是收口轮」，测试靠这个分派假回执 */
function who(prompt: string): { id: string; review: boolean } {
  const id = /节点 ([a-z0-9_-]+)/.exec(prompt)?.[1] ?? '?';
  return { id, review: prompt.includes('## 下级交回的结果') };
}

async function run(
  nodes: NodeConfig[],
  task: string,
  runner: Runner,
): Promise<{ rec: RunRecord | null; logs: string[]; taskId: number }> {
  const cfg = cfgOf(nodes);
  const taskId = createTask(DB, { master: cfg.root.id, task, configSnapshot: '{}' });
  const logs: string[] = [];
  const rec = await runTree(cfg, cfg.root, task, (l) => logs.push(l), {
    db: DB,
    taskId,
    root: ROOT,
    runner: runner as never,
  });
  return { rec, logs, taskId };
}

test('多层树：a 的收口能核到 c 的产物，不会因为 b 自己没写文件就空过', async () => {
  const nodes = [node('a', ''), node('b', 'a'), node('c', 'b')];
  const calls: string[] = [];
  let aReview = 0;
  let bReview = 0;

  const runner: Runner = async (_p, o) => {
    const { id, review } = who(o.prompt);
    calls.push(id + (review ? ':review' : ':work'));

    if (id === 'a' && !review) {
      return respond({ summary: '派给 b', dispatch: [{ to: 'b', task: '写 note.txt' }] });
    }
    if (id === 'b' && !review) {
      return respond({ summary: '派给 c', dispatch: [{ to: 'c', task: '写 note.txt' }] });
    }
    if (id === 'c') {
      fs.writeFileSync(path.join(o.cwd, 'note.txt'), '第一行内容：龙须面\n第二行内容：自行车\n', 'utf8');
      return respond({
        summary: '写好了',
        artifacts: [{ path: 'note.txt' }],
        evidence: ['第一行内容：龙须面', '第二行内容：自行车'],
      });
    }
    // 收口轮：第一遍故意不给证据，程序应该打回；补验时给出真实片段才算过
    if (id === 'b') {
      bReview += 1;
      return bReview === 1
        ? respond({ summary: '通过' })
        : respond({ summary: '通过', evidence: ['第一行内容：龙须面', '第二行内容：自行车'] });
    }
    aReview += 1;
    return aReview === 1
      ? respond({ summary: '通过' })
      : respond({ summary: '通过', evidence: ['第一行内容：龙须面', '第二行内容：自行车'] });
  };

  const { rec, logs, taskId } = await run(nodes, '写一份 note.txt', runner);

  assert.equal(aReview, 2, 'a 的第一次「通过」没有证据，必须被打回补验；只判一次说明它拿到的是空产物清单');
  assert.equal(bReview, 2, 'b 同样：c 的产物必须先落进 b 的验收清单');
  assert.equal(rec?.state, 'done');
  assert.equal(rec?.verdict, 'pass');
  assert.ok(calls.includes('c:work'));
  assert.ok(
    logs.some((l) => l.includes('证据核不上') || l.includes('要求重读产物')),
    '日志里应该有证据核不上的痕迹：\n' + logs.join('\n'),
  );

  // 每轮都要落状态快照：续跑只读它，不回头扫 runs/json
  const cp = listCheckpoints(DB, taskId);
  assert.ok(cp.length >= 3, `应有 a/b/c 三条快照，实际 ${cp.length}`);
  const c = cp.find((x) => x.nodeId === 'c');
  assert.equal(c?.state, 'done');
  assert.equal(c?.artifacts.length, 1, 'c 交的产物要进快照，否则续跑以为它什么都没做');
});

test('同一段打回指令重复时收场，不会无限跑收口', async () => {
  const nodes = [node('a', ''), node('b', 'a')];
  let aReview = 0;
  let bWork = 0;
  const SAME = '第一行要改成大写，改完把整个文件重写一遍，别的不要动';

  const runner: Runner = async (_p, o) => {
    const { id, review } = who(o.prompt);
    if (id === 'a' && !review) {
      return respond({ summary: '派给 b', dispatch: [{ to: 'b', task: '写 bad.txt' }] });
    }
    if (id === 'b') {
      bWork += 1;
      fs.writeFileSync(path.join(o.cwd, 'bad.txt'), 'first line\nsecond line\n', 'utf8');
      return respond({
        summary: '写好了',
        artifacts: [{ path: 'bad.txt' }],
        evidence: ['first line', 'second line'],
      });
    }
    // 每一轮收口都给一模一样的打回指令：这就是「空转」的形态
    aReview += 1;
    return respond({ summary: '不合格', dispatch: [{ to: 'b', task: SAME }] });
  };

  const { rec, logs } = await run(nodes, '写一份 bad.txt', runner);

  assert.equal(aReview, 2, '第一次打回允许重派，第二次同一段话就该停下；再多就是空转');
  assert.equal(bWork, 2, 'b 只应被执行两次（初次 + 一次重派）');
  assert.equal(rec?.state, 'blocked', '停下时要落 blocked，让人能接手，而不是判 pass/failed 混过去');
  assert.ok(
    logs.some((l) => l.includes('同一段打回指令')),
    '日志里应说明是因为指令重复才停：\n' + logs.join('\n'),
  );
});

test('spawn 带 dispatch=[] 也会创建审批单，批准后照常派活并收口', async () => {
  const nodes = [node('a', '')];
  let aReview = 0;
  let tmpWork = 0;

  const runner: Runner = async (_p, o) => {
    const { id, review } = who(o.prompt);
    if (id === 'a' && !review) {
      // 关键形状：只申请开线，这一轮不派活
      return respond({
        summary: '需要一条独立产线',
        dispatch: [],
        spawn: [{ name: 'tmp', why: '这条线要单独跑，不和现有节点抢工作区', task: "在工作区里写一个 tmp.txt：第一行 hello world，第二行写今天日期。只写这一个文件，不要读其他目录，不要改任何已有文件。验收：文件存在、两行内容正确、UTF-8 编码。" }],
      });
    }
    if (id === 'a' && review) {
      aReview += 1;
      return respond({ summary: '通过', evidence: ['临时线写的内容', '第二段可以核对的话'] });
    }
    tmpWork += 1;
    fs.writeFileSync(path.join(o.cwd, 'tmp.txt'), '临时线写的内容\n第二段可以核对的话\n', 'utf8');
    return respond({
      summary: '写好了',
      artifacts: [{ path: 'tmp.txt' }],
      evidence: ['临时线写的内容', '第二段可以核对的话'],
    });
  };

  const cfg = cfgOf(nodes);
  const taskId = createTask(DB, { master: 'a', task: '开一条线写 tmp.txt', configSnapshot: '{}' });
  const logs: string[] = [];

  // 审批是阻塞的：另开一个循环去点「批准」，模拟人在这边看着
  const approver = (async () => {
    for (let i = 0; i < 200; i++) {
      const row = DB.prepare(
        "SELECT id FROM approvals WHERE task_id = ? AND state = 'pending' ORDER BY id LIMIT 1",
      ).get(taskId) as { id: number } | undefined;
      if (row) {
        assert.equal(decideApproval(DB, Number(row.id), 'approved'), true);
        return true;
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    return false;
  })();

  const rec = await runTree(cfg, cfg.root, '开一条线写 tmp.txt', (l) => logs.push(l), {
    db: DB,
    taskId,
    root: ROOT,
    runner: runner as never,
  });
  const approved = await approver;

  assert.equal(approved, true, 'dispatch 为空时也必须把审批单建出来，否则请求会静默丢掉');
  assert.equal(tmpWork, 1, '批准后应该立刻按审批单派活');
  assert.equal(aReview, 1, '派出去的活要有收口');
  assert.equal(rec?.verdict, 'pass');
});

test('派生被拒绝时不能判 done：要落 blocked 并说清楚原因', async () => {
  const nodes = [node('a', '')];
  let aReview = 0;

  const runner: Runner = async (_p, o) => {
    const { id, review } = who(o.prompt);
    if (review) {
      aReview += 1;
      return respond({ summary: '通过' });
    }
    assert.equal(id, 'a');
    return respond({
      summary: '需要一条独立产线',
      dispatch: [],
      spawn: [{ name: 'tmp', why: '这条线要单独跑', task: "在工作区里写一个 tmp.txt：第一行 hello world，第二行写今天日期。只写这一个文件，不要读其他目录，不要改任何已有文件。验收：文件存在、两行内容正确、UTF-8 编码。" }],
    });
  };

  const cfg = cfgOf(nodes);
  const taskId = createTask(DB, { master: 'a', task: '开一条线', configSnapshot: '{}' });
  const logs: string[] = [];

  const rejecter = (async () => {
    for (let i = 0; i < 200; i++) {
      const row = DB.prepare(
        "SELECT id FROM approvals WHERE task_id = ? AND state = 'pending' ORDER BY id LIMIT 1",
      ).get(taskId) as { id: number } | undefined;
      if (row) {
        decideApproval(DB, Number(row.id), 'rejected');
        return true;
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    return false;
  })();

  const rec = await runTree(cfg, cfg.root, '开一条线', (l) => logs.push(l), {
    db: DB,
    taskId,
    root: ROOT,
    runner: runner as never,
  });
  assert.equal(await rejecter, true);

  assert.equal(rec?.state, 'blocked', '派生被拒后仍然 done 就是把人蒙在鼓里');
  assert.equal(aReview, 0, '没有派活就不该再跑收口');
  assert.match(String(rec?.question), /派生都没落地/);
});

test('派生的 role 带路径穿越时直接拒，不建审批单', async () => {
  const nodes = [node('a', '')];

  const runner: Runner = async () =>
    respond({
      summary: '开条线',
      dispatch: [],
      spawn: [{ name: 'tmp', why: '独立产线', task: "在工作区里写一个 tmp.txt：第一行 hello world，第二行写今天日期。只写这一个文件，不要读其他目录，不要改任何已有文件。验收：文件存在、两行内容正确、UTF-8 编码。", role: '../secrets' }],
    });

  const cfg = cfgOf(nodes);
  const taskId = createTask(DB, { master: 'a', task: '开一条线', configSnapshot: '{}' });
  const logs: string[] = [];
  const rec = await runTree(cfg, cfg.root, '开一条线', (l) => logs.push(l), {
    db: DB,
    taskId,
    root: ROOT,
    runner: runner as never,
  });

  const rows = DB.prepare('SELECT COUNT(*) AS n FROM approvals WHERE task_id = ?').get(taskId) as { n: number };
  assert.equal(Number(rows.n), 0, '不合法的 role 不该占用一次人的审批');
  assert.equal(rec?.state, 'blocked');
  assert.ok(logs.some((l) => l.includes('role') && l.includes('不合法')), logs.join('\n'));
});

// 下级点名问上级时，上级不能装没看见直接判通过——
// 不拦的话，子 agent 的疑问只能一路冒到人，中间那层主控等于不存在。
test('下级 ask 上级，上级直接判通过会被打回并要求回答', async () => {
  const nodes = [node('a', ''), node('b', 'a')];
  const cfg = cfgOf(nodes);
  const calls: string[] = [];
  let bWork = 0;
  let aReview = 0;

  const prompt = (o: RunOpts) => o.prompt;
  const runner: Runner = async (_plugin, o) => {
    const w = who(prompt(o));
    calls.push(`${w.id}:${w.review ? 'review' : 'work'}`);
    if (w.id === 'b' && !w.review) {
      bWork++;
      if (bWork === 1) {
        return respond({
          summary: '做完了，但口径要确认',
          artifacts: [],
          dispatch: [],
          ask: [{ to: 'a', question: '持枪用腰射还是抵肩？' }],
        });
      }
      return respond({ summary: '按腰射重做完了', artifacts: [], dispatch: [] });
    }
    if (w.id === 'a' && !w.review) {
      return respond({
        summary: '派给 b',
        artifacts: [],
        dispatch: [{ to: 'b', task: '做那个东西' }],
      });
    }
    // a 的收口轮
    aReview++;
    if (aReview === 1) {
      // 第一次就想直接判通过：必须被拦下
      return respond({ summary: '可以了', artifacts: [], dispatch: [] });
    }
    if (aReview === 2) {
      // 看到「下级还在等你回答」后，回答并派回去
      return respond({
        summary: '回答：用腰射',
        artifacts: [],
        dispatch: [{ to: 'b', task: '按腰射做，不要抵肩' }],
      });
    }
    return respond({ summary: '这次真的好了', artifacts: [], dispatch: [] });
  };

  const { rec, logs } = await run(nodes, '把东西做出来', runner);

  assert.ok(calls.includes('b:work'), 'b 应该被派活');
  assert.ok(aReview >= 3, `a 至少收口 3 轮（首次判通过被拦 → 回答 → 最终通过），实际 ${aReview}`);
  assert.ok(
    logs.some((l) => l.includes('再收口一次') || l.includes('没处理下级的提问')),
    '日志里要有「它想直接判过但被拦」的痕迹：\n' + logs.join('\n'),
  );
  assert.equal(rec?.verdict, 'pass', '回答完之后应该能正常收口');
});

// 收口轮主控自己写了汇总报告、evidence 引用报告里的话：这是正常做法，
// 如果只拿下级产物当核对对象，这种 evidence 一条都搜不到（#44 的真实原因）。
test('收口轮的 evidence 可以引用它自己写的汇总报告', async () => {
  const nodes = [node('a', ''), node('b', 'a')];
  let aReview = 0;

  const runner: Runner = async (_plugin, o) => {
    const w = who(o.prompt);
    if (w.id === 'b' && !w.review) {
      const f = path.join(o.cwd, 'b_out.txt');
      fs.writeFileSync(f, '下级交付：清点 1568 件\n', 'utf8');
      return respond({ summary: '交了', artifacts: [{ path: f, kind: 'txt' }], dispatch: [] });
    }
    if (w.id === 'a' && !w.review) {
      return respond({ summary: '派活', artifacts: [], dispatch: [{ to: 'b', task: '清点资产' }] });
    }
    aReview++;
    // 主控收口时自己写一份汇总，证据从自己的报告里抄
    const f = path.join(o.cwd, 'summary.md');
    fs.writeFileSync(f, '五线合计 12017 件\n状态分布：已签收 0\n', 'utf8');
    return respond({
      summary: '收口通过',
      artifacts: [{ path: f, kind: 'md' }],
      dispatch: [],
      evidence: ['五线合计 12017 件', '状态分布：已签收 0'],
    });
  };

  const { rec, logs } = await run(nodes, '清点资产', runner);
  assert.equal(aReview, 1, '证据能对上就不该被打回重判');
  assert.equal(rec?.verdict, 'pass', '引用自己的报告必须能通过：\n' + logs.join('\n'));
});

// 阶段推进：主控用 plan 声明四段，收口判 pass 只代表「这一段过了」。
// 不推进的话就是 #45 —— 第一段跑完就判 pass，后三段压根没开始，任务却显示完成。
test('给了 plan 就必须跑完全部段落才结束任务', async () => {
  const nodes = [node('a', ''), node('b', 'a')];
  const calls: string[] = [];
  let aWork = 0;
  let aReview = 0;

  const PLAN = [
    { id: '1', name: '审计', doneWhen: '五份报告' },
    { id: '2', name: '标记', doneWhen: '行数=12047' },
    { id: '3', name: '隔离', doneWhen: '清单经人确认' },
    { id: '4', name: '冒烟', doneWhen: '新增错误=0' },
  ];

  const runner: Runner = async (_plugin, o) => {
    const w = who(o.prompt);
    calls.push(`${w.id}:${w.review ? 'review' : 'work'}`);
    if (w.id === 'a' && !w.review) {
      aWork++;
      const m = /第 (\d+)\/4 段/.exec(o.prompt);
      if (!m) {
        // 第一轮：声明四段计划，同时派第一段
        return respond({ summary: '拆成四段', plan: PLAN, dispatch: [{ to: 'b', task: '做第 1 段' }] });
      }
      return respond({ summary: '派第 ' + m[1] + ' 段', dispatch: [{ to: 'b', task: '做第 ' + m[1] + ' 段' }] });
    }
    if (w.id === 'b' && !w.review) {
      return respond({ summary: '这一段做完了', dispatch: [] });
    }
    // a 的收口：判这一段通过，并标明是哪一段
    aReview++;
    const m = /第 (\d+)\/4 段/.exec(o.prompt);
    const nth = m ? Number(m[1]) : 1;
    return respond({ summary: '第 ' + nth + ' 段通过', dispatch: [], evidence: [], phase: String(nth) });
  };

  const { rec, logs } = await run(nodes, '四段任务', runner);

  assert.equal(aWork, 4, `主控应该被推着做四段（实际 ${aWork} 段）:\n` + logs.join('\n'));
  assert.equal(aReview, 4, `每段收口一次（实际 ${aReview} 次）`);
  assert.ok(logs.some((l) => l.includes('第 2/4 段')), '日志里要能看到推进到第二段');
  assert.ok(logs.some((l) => l.includes('阶段全部完成')), '全部段落结束要有明确记录');
  assert.equal(rec?.verdict, 'pass');
});

// 申请里没写清楚要新线做什么，就不该开：一条线开出来要跑一整轮、还要落盘。
// 短任务（"写个文件"这种）产出的东西没人能验收，比不开更糟。
test('派生申请的任务描述太短就拒，不建审批单', async () => {
  const nodes = [node('a', '')];
  const runner: Runner = async () =>
    respond({
      summary: '开条线',
      dispatch: [],
      spawn: [{ name: 'tmp', why: '这条线要单独跑，不和现有节点抢工作区', task: '写个文件' }],
    });

  const cfg = cfgOf(nodes);
  const taskId = createTask(DB, { master: 'a', task: '开一条线', configSnapshot: '{}' });
  const logs: string[] = [];
  await runTree(cfg, cfg.root, '开一条线', (l) => logs.push(l), {
    db: DB,
    taskId,
    root: ROOT,
    runner: runner as never,
  });

  assert.match(logs.join('\n'), /task 只有 4 字/, '要说明短在哪、要求多少');
  const pending = DB.prepare(
    "SELECT COUNT(*) AS n FROM approvals WHERE task_id = ? AND state = 'pending'",
  ).get(taskId) as { n: number };
  assert.equal(pending.n, 0, '短任务不该占用一次人的审批注意力');
});

// 协议允许 8 段，但单节点收口上限是 6 次。阶段推进时如果不清零，7–8 段的任务
// 即使每段一次通过，也会在第 7 段收口前被判 blocked（外部审计 M4）。
test('8 段计划能跑完，不会被收口上限拦下（协议允许的上限）', async () => {
  const nodes = [node('a', ''), node('b', 'a')];
  const PLAN = Array.from({ length: 8 }, (_, i) => ({ id: String(i + 1), name: '第' + (i + 1) + '段' }));
  let aReview = 0;

  const runner: Runner = async (_p, o) => {
    const w = who(o.prompt);
    if (w.id === 'a' && !w.review) {
      const m = /第 (\d+)\/8 段/.exec(o.prompt);
      if (!m) return respond({ summary: '切八段', plan: PLAN, dispatch: [{ to: 'b', task: '做第 1 段' }] });
      return respond({ summary: '派第 ' + m[1] + ' 段', dispatch: [{ to: 'b', task: '做第 ' + m[1] + ' 段' }] });
    }
    if (w.id === 'b' && !w.review) return respond({ summary: '这一段做完', dispatch: [] });
    aReview++;
    return respond({ summary: '这一段通过', dispatch: [] });
  };

  const { rec, logs } = await run(nodes, '八段任务', runner);
  assert.equal(rec?.state, 'done', '8 段应该跑完而不是 blocked:////n' + logs.join('\n'));
  assert.equal(aReview, 8, `应该收口 8 次（每段一次），实际 ${aReview}`);
});
