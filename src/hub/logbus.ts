// 日志总线：任务跑的时候把行推进来，界面订阅着看。
// 有历史缓冲，所以中途连上也能看到前面的内容——之前刷新就丢是这个缺的。
export class LogBus {
  private lines = new Map<number, string[]>();
  private subs = new Map<number, Set<(line: string) => void>>();
  private readonly max = 2000;

  push(taskId: number, line: string): void {
    if (!taskId) return;
    let arr = this.lines.get(taskId);
    if (!arr) {
      arr = [];
      this.lines.set(taskId, arr);
    }
    arr.push(line);
    if (arr.length > this.max) arr.splice(0, arr.length - this.max);
    for (const fn of this.subs.get(taskId) ?? []) {
      try {
        fn(line);
      } catch {}
    }
  }

  history(taskId: number): string[] {
    return this.lines.get(taskId) ?? [];
  }

  subscribe(taskId: number, fn: (line: string) => void): () => void {
    let set = this.subs.get(taskId);
    if (!set) {
      set = new Set();
      this.subs.set(taskId, set);
    }
    set.add(fn);
    const bucket = set;
    return () => {
      bucket.delete(fn);
    };
  }

  /** 任务结束后释放缓冲，否则跑几百个任务会把内存吃满 */
  release(taskId: number): void {
    this.lines.delete(taskId);
    this.subs.delete(taskId);
  }
}
