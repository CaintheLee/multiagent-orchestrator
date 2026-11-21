// 车道并发：同一条车道串行，不同车道并行。
//
// 车道键取「执行节点 id」，不是随便挑的：一个节点只有一个工作区
// (.sandbox/t<任务>/<节点>)，两个进程同时往里写就是真冲突。
// 所以同节点必须串行，这是约束不是保守；不同节点天然隔离，可以并行。
//
// 注意：这里**不管并发上限**。车位由 runTree 在真正起进程处（runOnce）申请，
// 因为主控轮不经过这个函数，两边都申请会互相等死。

export type LaneResult<R> =
  | { ok: true; value: R }
  | { ok: false; error: string };

export type LaneOpts<T> = {
  laneOf: (item: T) => string;
};

/**
 * 把 items 按车道排队执行，结果按**输入下标**归位。
 *
 * 三条硬保证：
 * 1. 同车道串行 —— 前一条没结束，后一条不会开始
 * 2. 一条失败不断链 —— 前一条抛异常，同车道后续照常跑（否则会静默丢活）
 * 3. 结果按下标归位 —— 不按完成顺序，否则 reports 会张冠李戴
 */
export async function runLanes<T, R>(
  items: T[],
  worker: (item: T, index: number) => Promise<R>,
  opts: LaneOpts<T>,
): Promise<Array<LaneResult<R>>> {
  const out: Array<LaneResult<R>> = new Array(items.length);
  const chains = new Map<string, Promise<void>>();

  const one = async (item: T, i: number): Promise<void> => {
    try {
      out[i] = { ok: true, value: await worker(item, i) };
    } catch (e) {
      out[i] = { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  };

  await Promise.all(
    items.map((item, i) => {
      const lane = String(opts.laneOf(item) || '__');
      const prev = chains.get(lane) ?? Promise.resolve();
      // 两个分支都给 one：上一条失败也要把下一条接上，不能断链
      const next = prev.then(() => one(item, i), () => one(item, i));
      chains.set(lane, next.then(() => undefined, () => undefined));
      return next;
    }),
  );

  return out;
}
