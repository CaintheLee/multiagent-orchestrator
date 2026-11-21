// 能力基线（evals）：一组固定输入 → 固定判断，跑的是「规则是否还按预期工作」。
//
// 和单测的区别：单测按模块组织，跑的是实现细节；evals 按「对外承诺的行为」组织，
// 只从 SDK 入口调，改了内部结构也不用改这里。它不调模型、不花钱、秒级跑完。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseReceipt, evidenceProblem, buildResumeBrief, guard, sameInstructionTimes,
  parseToml, resolveWorkspace, MAX_REWORK,
  type Config, type NodeConfig, type RunRecord,
} from '../src/sdk.ts';

export type Case = { name: string; run: () => string | null };

const FENCE = 'agent-autoloop';
const wrap = (json: string) => '正文\n\n```' + FENCE + '\n' + json + '\n```\n';

const node: NodeConfig = {
  id: 'b', parent: 'a', name: '执行者', plugin: 'codebuddy', workspace: 'b',
  timeoutMin: 5, access: 'write', role: 'executor', model: '',
};
const cfg: Config = { schema: 1, nodes: [node], root: node, maxSummary: 200, maxDetail: 4000 };

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-eval-'));
const goodFile = path.join(TMP, 'note.txt');
fs.writeFileSync(goodFile, '第一行：龙须面\n第二行：自行车\n', 'utf8');
const artifacts = [{ path: goodFile, kind: 'txt', bytes: fs.statSync(goodFile).size }];

function rec(over: Partial<RunRecord>): RunRecord {
  return {
    id: 1, node: 'a', plugin: 'codebuddy', task: 't', state: 'done',
    startedAt: '', ms: 0, summary: 's', artifacts: [], dispatch: [], warnings: [],
    ...over,
  };
}

export const cases: Case[] = [
  {
    name: '回执：合法 JSON 能解析出 dispatch',
    run: () => {
      const r = parseReceipt(wrap('{"summary":"派活","dispatch":[{"to":"b","task":"写 x"}],"artifacts":[]}'), cfg);
      if (!r.ok) return r.why;
      return r.receipt.dispatch.length === 1 ? null : '没解析出 dispatch';
    },
  },
  {
    name: '回执：多余字段整轮拒绝（格式错误不能放过）',
    run: () => {
      const r = parseReceipt(wrap('{"summary":"x","artifacts":[],"dispatch":[],"extra":1}'), cfg);
      return !r.ok && /不认识的字段/.test(r.why) ? null : '带多余字段竟然通过了';
    },
  },
  {
    name: '回执：空 summary 拒绝',
    run: () => {
      const r = parseReceipt(wrap('{"summary":"  ","artifacts":[],"dispatch":[]}'), cfg);
      return !r.ok ? null : '空 summary 竟然通过了';
    },
  },
  {
    name: '回执：太短的 evidence 被丢掉，但不判整轮失败',
    run: () => {
      const r = parseReceipt(wrap('{"summary":"好","artifacts":[],"dispatch":[],"evidence":["ok","第一行：龙须面"]}'), cfg);
      if (!r.ok) return '一条短 evidence 把整轮判死了：' + r.why;
      return r.receipt.evidence.length === 1 ? null : `应只剩 1 条，实际 ${r.receipt.evidence.length}`;
    },
  },
  {
    name: '证据：原样抄的片段能核上',
    run: () => {
      const miss = evidenceProblem(['第一行：龙须面', '第二行：自行车'], artifacts);
      return miss.length ? '抄原文却核不上：' + miss.join('/') : null;
    },
  },
  {
    name: '证据：概括过的片段核不上（防放水）',
    run: () => {
      const miss = evidenceProblem(['第一行是面条', '第二行是车子'], artifacts);
      return miss.length === 2 ? null : '概括内容竟然核上了';
    },
  },
  {
    name: '证据：只给一条不算通过',
    run: () => {
      const miss = evidenceProblem(['第一行：龙须面'], artifacts);
      return miss.some((m) => m.includes('至少给 2 条')) ? null : '一条 evidence 被当成够了';
    },
  },
  {
    name: '证据：没有产物时不要求 evidence',
    run: () => {
      const miss = evidenceProblem([], []);
      return miss.length === 0 ? null : '纯派活轮被要求给 evidence';
    },
  },
  {
    name: '续跑：超长原任务被截，回答和尾部指令完整保留',
    run: () => {
      const answer = '用 800×600，只要纯风景。';
      const r = buildResumeBrief({ id: 1, state: 'failed', task: '需'.repeat(30_000), answer, lines: ['- b：好了'] });
      if (r.overflow) return '砍完仍然溢出';
      if (!r.brief.includes(answer)) return '回答被截掉了';
      return r.brief.trimEnd().endsWith('只补还没完成的部分。派活时说清哪些跳过，收口时只验收这次新交付的。')
        ? null : '尾部指令丢失';
    },
  },
  {
    name: '续跑：装不下时报溢出，不静默截断',
    run: () => {
      const r = buildResumeBrief({ id: 1, state: 'blocked', task: '短', answer: '答'.repeat(30_000), lines: [] });
      return r.overflow ? null : '装不下却报成功';
    },
  },
  {
    name: '守卫：同一件事打回三次叫停',
    run: () => {
      const runs = [
        rec({ id: 1, verdict: 'rework', dispatch: [{ to: 'b', task: '缺 A' }] }),
        rec({ id: 2, verdict: 'rework', dispatch: [{ to: 'b', task: '缺 B' }] }),
        rec({ id: 3, verdict: 'rework', dispatch: [{ to: 'b', task: '缺 C' }] }),
      ];
      const v = guard(runs, 12);
      return v.stop && /打回 3 次/.test(v.why) ? null : '第三次打回没有叫停';
    },
  },
  {
    name: '守卫：同一段打回指令第二次就拦（排除当前记录）',
    run: () => {
      const same = '不合格式，请原样改写为单行纯文本，不要加任何前缀或后缀';
      const runs = [rec({ id: 1, verdict: 'rework', dispatch: [{ to: 'b', task: same }] })];
      // 当前记录就是 id=1：必须排除自己，否则第一次打回就被算成重复
      const first = sameInstructionTimes(runs, 'a', 'b', same, 1);
      // 下一轮（id=2）回头看：上一轮给过同一段话 → 1
      const prev = sameInstructionTimes(runs, 'a', 'b', same, 2);
      if (first !== 0) return `第一次打回被自己数成重复（${first}）`;
      return prev === 1 ? null : `第二次应数到 1，实际 ${prev}`;
    },
  },
  {
    name: '配置：重复 [agent.x] 段直接报错',
    run: () => {
      try {
        parseToml('[agent.b]\nid = "b"\n[agent.b]\nid = "c"\n');
        return '重复段被静默覆盖';
      } catch (e) {
        return /出现了两次/.test(String(e)) ? null : '报错信息不对：' + String(e);
      }
    },
  },
  {
    name: '路径：workspace 写 ../ 被拒',
    run: () => {
      try {
        resolveWorkspace({ ...node, workspace: '../escape' }, 1, TMP);
        return '路径逃逸被放行';
      } catch {
        return null;
      }
    },
  },
  {
    name: '上限常量：MAX_REWORK 仍是 3（改了要同步文档和测试）',
    run: () => (MAX_REWORK === 3 ? null : `MAX_REWORK=${MAX_REWORK}`),
  },
];
