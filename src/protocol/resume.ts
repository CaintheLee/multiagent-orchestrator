// 续跑简报：把「原任务 + 人的回答 + 已交付清单」拼成一条新任务。
//
// 单独放在这里是为了能测：这段逻辑有两处必须成立——
// 1. 超长时只砍原任务，不能把回答或末尾的指令切掉；
// 2. 实在装不下就明确报溢出，由调用方拒绝，不做整体 slice。
/** 任务正文上限。和 host 侧的 MAX_TASK 保持一个数 */
export const RESUME_MAX = 20_000;
/** 交付清单最多列几条 */
export const RESUME_LINES = 30;
/** 过程记录最多列几条。失败/卡住的轮次也要留痕，但不能把正文吃光 */
export const RESUME_TRAIL = 12;
/** 原任务最少保留多少字：再少就看不出在说什么了 */
const HEAD_MIN = 200;

export type ResumeInput = {
  /** 被打断的那个任务 id，写进简报里做追溯 */
  id: number;
  /** 它当时的终态 */
  state: string;
  /** 原任务正文 */
  task: string;
  /** 人对上次提问的回答，没有就空串 */
  answer: string;
  /** 「- 节点：结论 · 产物：…」这类已交付条目 */
  lines: string[];
  /**
   * 没通过验收的轮次留痕：「- a（失败）：做了什么 · 提问：…」。
   * 不加这段，一个跑满 8 分钟、写了文件但被判越界的任务，
   * 在续跑看来和「从没跑过」一模一样（#40）。
   */
  trail?: string[];
  max?: number;
};

export type ResumeResult = {
  brief: string;
  /** true 表示怎么砍都装不下，调用方应拒绝（413），不要再 slice */
  overflow: boolean;
  /** 实际用到的交付条目数（含「还有 N 个」那一条） */
  shown: number;
};

export function buildResumeBrief(input: ResumeInput): ResumeResult {
  const max = input.max ?? RESUME_MAX;
  const answer = input.answer;

  // 清单本身也要限：30 条封顶，超出的折成一句提示，
  // 否则 48 个节点的交付光清单就能把两万字吃光
  const shownLines = input.lines.slice(0, RESUME_LINES);
  if (input.lines.length > shownLines.length) {
    shownLines.push(`- …还有 ${input.lines.length - shownLines.length} 个节点有交付，产物都在各自工作区里`);
  }

  // 过程记录同样封顶：它的作用是「别从零开始」，不是完整复盘
  const trail = (input.trail ?? []).slice(0, RESUME_TRAIL);
  if ((input.trail?.length ?? 0) > trail.length) {
    trail.push(`- …还有 ${(input.trail?.length ?? 0) - trail.length} 轮没列出，原文在 .data/logs/`);
  }

  const compose = (head: string) => [
    head,
    '',
    ...(answer
      ? ['## 我对你上次提问的回答（按这个继续，不要再问一遍）', answer, '']
      : []),
    `## 这是任务 #${input.id} 的续跑（它当时没跑完：${input.state}）`,
    input.lines.length
      ? '下面这些已经交付，**不要重做，也不要覆盖已有文件**：'
      : trail.length
        ? '上一轮没有可复用的产物，但有过程记录（见下）。**别重复它已经做过的事**，先看它卡在哪。'
        : '之前没有交付物，从头开始。',
    ...shownLines,
    ...(trail.length
      ? ['', '## 上一轮的过程记录（这些都没通过验收，不要当成已完成）', ...trail]
      : []),
    '',
    '只补还没完成的部分。派活时说清哪些跳过，收口时只验收这次新交付的。',
  ].join('\n');

  let head = input.task;
  let brief = compose(head);
  // 每次按超出量砍原任务。回答和尾部指令永远不动——它们是这次续跑的全部意义
  for (let i = 0; brief.length > max && head.length > HEAD_MIN && i < 20; i++) {
    const cut = Math.max(HEAD_MIN, head.length - (brief.length - max) - 100);
    if (cut >= head.length) break;
    head = head.slice(0, cut) + '\n…（原任务太长，先截到这里，其余按上下文继续）';
    brief = compose(head);
  }

  return {
    brief,
    overflow: brief.length > max,
    shown: shownLines.length,
  };
}
