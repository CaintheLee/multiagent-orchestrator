// 守门员：用算术判断「这轮还该不该继续」，不调模型、不读磁盘。
// 交给模型审「有没有浪费 token」，本身就是一次 token 浪费。
import type { RunRecord } from '../store/runs.ts';

export type Verdict = { stop: false } | { stop: true; why: string };

/** 同一件事最多打回几次（同段话重复的情形另算，见下） */
export const MAX_REWORK = 3;

/**
 * 父节点把同一个下级打回了几次。
 *
 * 为什么必须按「谁打回谁」算：叶节点自己的工作轮 verdict 永远是空的，
 * 带 rework 的是父节点的验收轮。只按 `r.node === 子节点` 过滤，叶节点永远是 0 次，
 * 两条防返工规则全都触发不了（审计 P1-6）。
 */
export function reworkTimes(runs: RunRecord[], parent: string, child: string): number {
  return runs.filter(
    (r) => r.node === parent && r.verdict === 'rework' && r.dispatch.some((d) => d.to === child),
  ).length;
}

/** 两次打回给下级的指令，前这么多字符相同就算「在重复自己」 */
const SAME_INSTRUCTION_PREFIX = 80;

/**
 * 同一个上级给同一个下级，已经给过几次「前 80 字完全一样」的打回指令。
 *
 * 为什么放在路由处算而不是在子节点的 guard 里算：叶节点自己的轮次里没有
 * rework 记录（那是父节点的验收轮），拿它自己过滤永远是 0 次，这条规则触发不了。
 * 父节点手里正好有 `parent / child / task` 三样东西，按「谁打回谁」数才是对的。
 *
 * `exceptId` 传当前这条记录：当前 review 轮的 dispatch 也算一次 rework，
 * 不排除的话第一次打回就会被自己数成「重复」。
 */
export function sameInstructionTimes(
  runs: RunRecord[],
  parent: string,
  child: string,
  task: string,
  exceptId = -1,
): number {
  const head = task.slice(0, SAME_INSTRUCTION_PREFIX);
  if (!head) return 0;
  return runs.filter(
    (r) =>
      r.id !== exceptId
      && r.node === parent
      && r.verdict === 'rework'
      && r.dispatch.some(
        (d) => d.to === child && d.task.slice(0, SAME_INSTRUCTION_PREFIX) === head,
      ),
  ).length;
}

export function guard(thisRun: RunRecord[], budget: number): Verdict {
  if (budget <= 0) {
    return { stop: true, why: '轮次预算用完' };
  }

  const reworks = thisRun.filter((r) => r.verdict === 'rework');

  // 形态 2 先判：两次打回说的是同一段话，说明主控没看新输出，或执行者没理解
  // 必须先于次数判断，否则这条永远走不到
  if (reworks.length >= 2) {
    const first = (reworks[reworks.length - 2].dispatch[0]?.task ?? '').slice(0, SAME_INSTRUCTION_PREFIX);
    const second = (reworks[reworks.length - 1].dispatch[0]?.task ?? '').slice(0, SAME_INSTRUCTION_PREFIX);
    if (first && first === second) {
      return { stop: true, why: '两次打回给的是同一段指令，在空转' };
    }
  }

  // 形态 1：同一件事反复打回，执行者已经改不动了
  if (reworks.length >= MAX_REWORK) {
    return {
      stop: true,
      why: `同一件事已打回 ${reworks.length} 次，再试大概率还是同一个结果，需要人看一眼`,
    };
  }

  return { stop: false };
}

/** 执行者是不是在原地打转：输出里反复出现「再试一次」这类话 */
export function looksStuck(stdout: string): boolean {
  const markers = [/再试一次/g, /还是不行/g, /换一种方法/g, /我再改/g, /重新来一遍/g];
  const hits = markers.reduce((n, re) => n + (stdout.match(re)?.length ?? 0), 0);
  return hits >= 4;
}
