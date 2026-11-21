// 限量车位：并发任务再多，真正在跑的也不超过 N 个，其余排队。
// 只在本进程内有效，够用了——hub 是单进程。

export class Semaphore {
  private readonly total: number;
  private free: number;
  private waiters: Array<() => void> = [];

  constructor(total: number) {
    const n = Math.floor(Number(total));
    this.total = Number.isFinite(n) && n > 0 ? n : 1;
    this.free = this.total;
  }

  get limit(): number {
    return this.total;
  }

  /** 正在被占用的车位数 */
  busy(): number {
    return this.total - this.free;
  }

  /** 排队等车位的数量，给界面看「还有几条在等」 */
  waiting(): number {
    return this.waiters.length;
  }

  /**
   * 取一个车位。给了 signal 就能在排队期间被取消——
   * 否则车位满时取消任务，它要等前面所有轮次依次跑完才轮到它检查取消，
   * 期间任务一直挂在 cancelling（审计 P1-8）。
   */
  async acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new Error('canceled');
    if (this.free > 0) {
      this.free -= 1;
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const take = () => {
        signal?.removeEventListener('abort', onAbort);
        // 车位到手时已经取消了：把位置让给下一个，别占着
        if (signal?.aborted) {
          this.release();
          reject(new Error('canceled'));
          return;
        }
        resolve();
      };
      const onAbort = () => {
        const i = this.waiters.indexOf(take);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(new Error('canceled'));
      };
      this.waiters.push(take);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  release(): void {
    const next = this.waiters.shift();
    if (next) {
      next();
      return;
    }
    if (this.free < this.total) this.free += 1;
  }
}
