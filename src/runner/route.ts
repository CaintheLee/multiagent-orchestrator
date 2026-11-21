// 路由决策：这一轮到底该派给谁、哪些被拦下、为什么。
//
// 从 runTree 里抽出来的原因：这段逻辑是纯算术（打回次数、同段指令、下级名单、扇出上限），
// 但以前和「起进程、等人审批、跑收口」缠在一个 800 行的函数里，只能靠端到端测试覆盖。
// 抽出来之后可以单独喂数据验证，任何一条拦截规则改坏了会立刻红。
import type { Dispatch } from '../protocol/schema.ts';
import type { NodeConfig } from '../kernel/tree.ts';
import type { RunRecord } from '../store/runs.ts';
import { reworkTimes, sameInstructionTimes } from '../kernel/guard.ts';

export type Routed = { to: string; task: string };

export type RouteInput = {
  /** 当前节点 id（打回次数按「谁打回谁」算） */
  parentId: string;
  /** 这一轮回执里的 dispatch */
  dispatch: Dispatch[];
  /** 当前节点的直接下级 */
  kids: NodeConfig[];
  /** 本次任务已经产生的轮次（用来数打回次数） */
  runs: RunRecord[];
  /** 当前这条记录的 id：数「同段指令」时必须排除自己 */
  currentRunId: number;
  /** 审批通过的 name → task，执行文本以它为准 */
  approved: Map<string, string>;
  maxFanout: number;
  maxRework: number;
  log: (line: string) => void;
};

export type RoutePlan = {
  /** 真正要跑的（已截到 maxFanout） */
  list: Routed[];
  /** 超出扇出上限、这一轮不跑的 */
  dropped: Routed[];
  /** 给收口轮看的 SKIPPED 说明 */
  reports: string[];
  /** 被拦下的条数：>0 且 list 为空，说明这一轮白派了 */
  rejected: number;
};

export function planRoutes(input: RouteInput): RoutePlan {
  const { parentId, dispatch, kids, runs, currentRunId, approved, maxFanout, maxRework, log } = input;
  const reports: string[] = [];
  const routed: Routed[] = [];
  let rejected = 0;

  for (const d of dispatch) {
    // 不在下级名单里的不进池，否则 laneOf 会拿到一个不存在的节点
    if (!kids.some((k) => k.id === d.to)) {
      log(`  路由拒绝：${parentId} 没有下级「${d.to}」，这条不派`);
      rejected += 1;
      continue;
    }

    // 打回多少次是「我打回它」的次数。叶节点自己的工作轮 verdict 是空的，
    // 只看它自己永远是 0 次
    const times = reworkTimes(runs, parentId, d.to);
    if (times >= maxRework) {
      log(`  ${d.to} 已经被打回 ${times} 次，不再派`);
      reports.push(`### ${d.to} · SKIPPED\n- 已经被打回 ${times} 次，达到上限 ${maxRework}，不再重派`);
      rejected += 1;
      continue;
    }

    // 上一轮已经用同一段话打回过它：派下去也是同一个结果
    const same = sameInstructionTimes(runs, parentId, d.to, d.task, currentRunId);
    if (same >= 1) {
      log(`  ${d.to} 收到的是第 ${same + 1} 次同一段打回指令，不再派`);
      reports.push(
        `### ${d.to} · SKIPPED\n- 这一轮的打回指令和上一轮前 80 字完全一样，再派一次也是同一个结果，先停下`,
      );
      rejected += 1;
      continue;
    }

    // 审批过的是「这件事」：执行文本一律以审批单为准
    const forced = approved.get(d.to);
    if (forced !== undefined && forced !== d.task) {
      log(`  ${d.to} 的执行文本以审批单为准（dispatch 里写的不算）`);
    }
    routed.push(forced !== undefined ? { to: d.to, task: forced } : { to: d.to, task: d.task });
  }

  // 批准了却没在 dispatch 里派活的，补一条：点头就意味着同意做这件事
  for (const [name, task] of approved) {
    if (!routed.some((d) => d.to === name)) {
      log(`  ${name} 批准了但没派活，按审批单补一条`);
      routed.push({ to: name, task });
    }
  }

  if (routed.length > maxFanout) {
    log(`  派活过多：${routed.length} 条，只跑前 ${maxFanout} 条，其余 ${routed.length - maxFanout} 条没派`);
  }

  return {
    list: routed.slice(0, maxFanout),
    dropped: routed.slice(maxFanout),
    reports,
    rejected,
  };
}
