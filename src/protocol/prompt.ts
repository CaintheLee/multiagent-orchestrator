import { PROMPTS_DIR } from '../kernel/paths.ts';
// 把「节点 + 任务 + 下级」拼成提示词。只做文本组装，不判断业务。
import fs from 'node:fs';
import path from 'node:path';
import { childrenOf, type Config, type NodeConfig } from '../kernel/tree.ts';
import { listRoles } from '../kernel/roles.ts';
import { FENCE, SPAWN_LIMIT } from './schema.ts';

const ROLE_FALLBACK = '你是一个执行者：只做被交代的一件事，做完就停。';

/**
 * role 直接拼进 prompts/<role>.md。派生那条路已经在审批前挡过一次，
 * 这里再挡一次是因为 agents.toml 也可能是手写的——路径穿越不该靠上游记得校验。
 */
const SAFE_ROLE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export function buildPrompt(
  cfg: Config,
  node: NodeConfig,
  task: string,
  lessons = '',
  context = '',
  journal = '',
  inbox = '',
): string {
  const roleFile = SAFE_ROLE.test(node.role) ? path.join(PROMPTS_DIR, node.role + '.md') : '';
  const role = roleFile && fs.existsSync(roleFile) ? fs.readFileSync(roleFile, 'utf8').trim() : ROLE_FALLBACK;
  const kids = childrenOf(cfg, node.id);
  const fence = '```';
  const lines: string[] = [
    `你是「${node.name}」（节点 ${node.id}），在 ${node.workspace} 里干活。`,
    '',
    role,
  ];

  // 职责模板清单：主控开线时要选角色，只给 id 它不知道各自干什么，会一路默认 executor
  if (kids.length) {
    const cat = listRoles().filter((r) => r.usage).map((r) => '- ' + r.id + '：' + r.usage).join('\n');
    if (cat) lines.push('', '## 可用的职责模板（spawn 的 role 只能从这选；写了不存在的名字会退回 executor）', cat);
  }

  // 项目索引：只有带队伍的节点需要知道「这个项目现在是什么状态、该先读哪几份」
  if (kids.length && context) {
    lines.push('', '## 项目现状（动手前先看，按这里指的路径去读原文）', context);
  }

  // 同任务里其他线的留言：放在任务正文之前，读完照着调整，不要求回复
  if (inbox) {
    lines.push('', '## 别人给你留的话（同一条任务里的其他线，读完照它调整，不用回复）', inbox);
  }

  // 最近做过什么：防止主控把上个月已经做过的事再派一遍
  if (kids.length && journal) {
    lines.push('', '## 这个项目最近做过的任务（先看这里，别重复劳动）', journal);
  }

  if (kids.length && lessons) {
    lines.push('', '## 以前踩过的坑（派活和验收时注意）', lessons);
  }

  if (kids.length) {
    lines.push('', '## 你的下级');
    for (const k of kids) lines.push(`- ${k.id}（${k.name}）· 它的工作区是 ${k.workspace}`);
    lines.push(
      '',
      '要派活给下级就写进回执的 dispatch，写清楚交付物和验收口径。',
      '**派活时**（写进 dispatch.task 的指令）产物路径只写文件名，不要拼目录——下级会把它放在自己的工作区里。你自己去读资料、以及在 artifacts 里登记产物，不受这条限制。',
      '不要自己替下级做，也不要替它编结果。',
    );
  }

  lines.push(
    '',
    '## 这一轮的任务',
    task,
    '',
    '## 回执（必须给，格式不对这一轮就算失败）',
    '正文写完之后，最后输出一个 ' + FENCE + ' 代码块，里面是 JSON：',
    '',
    fence + FENCE,
  );

  const sample: Record<string, unknown> = {
    summary: '一句话结论',
    artifacts: [{ path: '<你这一轮写出来的文件路径，绝对路径或文件名都行>', kind: 'html' }],
    evidence: ['从那个文件里原样复制的第一段话', '从同一个文件里原样复制的第二段话'],
  };
  if (kids.length) sample.dispatch = [{ to: kids[0].id, task: '交给它的具体任务' }];
  lines.push(JSON.stringify(sample), fence, '');

  lines.push(
    '硬规则：',
    `- summary 不超过 ${cfg.maxSummary} 个字，写「做成了什么」，不要复述过程`,
    '- artifacts 只列你这一轮真正写出来或改过的文件；绝对路径或文件名都行（文件名按你的工作区解析）。没有就写 []',
    kids.length ? '- dispatch 只写你决定派给下级的活，可以不派（写 []）' : '- 你没有下级，dispatch 必须写 []',
    kids.length
      ? `- spawn 用来申请**新开一条产线**：name（1–8 位小写字母/数字/下划线）、why（一句话说清为什么非开不可）、task（批准后立刻派给它的活），一轮最多 ${SPAWN_LIMIT} 个。**要等人批准才生效**，所以能不新开就不新开——先看现有下级够不够用。但遇到「这类活没有归属线」（独立审计、性能压测、跨线取数）时，必须用 spawn 申请，不要硬塞给现有产线让它做不熟的活
- **spawn 的 task 必须写清楚四件事，少于 60 字直接拒**：①做什么（范围：读哪些、不改哪些）②交付物（文件名 + 落点路径）③验收口径（怎么算过：数量、字段、抽样要求）④硬约束（不许动什么、不许覆盖什么）。新线开出来就要跑一整轮，任务写得含糊等于让它自由发挥——这种活做完还不如不做
- spawn 的 why 也要说清「为什么不能塞给现有线」，只写「需要一个新线」不算理由`
      : '- 你没有下级，spawn 必须写 []',
    kids.length
      ? '- **交付物必须由下级产出**。你自己这一轮只能写规划、简报、判断；台账、报告、清单、代码这类交付物，交给对应产线去做。发现自己在写交付文档就停下来，改成派活——主控自己写的东西没人验收，等于绕过验收门'
      : '',
    '- plan 用来**把一件大事切段**：给 2–8 段，每段 {id, name, doneWhen}。给了之后，你收口判通过只代表「这一段过了」，框架会自动把下一段交给你，全部段落做完任务才结束。分段是给你自己看的推进表，不是给人看的计划书——写清每段做完的标准就行',
    '- evidence 是「你确实打开过产物」的凭证：只要这一轮有产物，就要给 2 条以上，每条从文件里**原样复制**（标点、缩进、大小写都不能改）',
    '- evidence 会被程序拿去文件里逐字搜索。自己概括的、改过标点的、没写进文件的，一条都搜不到；搜不到就判你没验，这一轮不算通过',
    '- 没有产物（纯问答、纯派活）时 evidence 写 []，不要编',
    '- tell 用来给同任务里的其他线留一句话（to 写节点名、msg 写内容）。它是**异步留言**：发完就走，对方下一轮才看得到，不要等回复；也不能用它交付产物',
    '- ask 用来**点名请谁回答**：to 写要问的节点名（问你的上级就写它的 id），question 写问题，一轮最多 3 条。它和 question 的区别：question 是「我卡住了，谁能答都行」；ask 是「我在等某个节点回答」，对方必须处理，否则这一轮判它无效',
    '- 能自己查、自己试、自己按现有规格判断的，不要用 ask 往上推。ask 只用在「答案不在你手上的资料里，且答错代价很大」的时候',
    '- 顶层只能有 summary、artifacts、dispatch、evidence、spawn、tell、ask、plan、phase、question 这十个字段，多一个都算格式错误。plan 和 phase 只在需要分段时给',
    '- 拿不准、又不知道该问谁，用 question 字段说明，然后结束这一轮',
  );
  return lines.join('\n');
}
