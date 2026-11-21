// 车道并发是纯逻辑，可以不起进程就测清楚。
// 重点不是「跑得快」，而是三条不能破的保证：串行、不断链、归位。
// 车位（并发上限）由 runTree 在 runOnce 里申请，不在这里，所以这里不测车位。
import test from 'node:test';
import assert from 'node:assert/strict';
import { runLanes } from '../src/kernel/lane.ts';
import { Semaphore } from '../src/kernel/pool.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 记录同时在跑的数量与峰值 */
function meter() {
  let now = 0;
  let peak = 0;
  return {
    enter() {
      now += 1;
      if (now > peak) peak = now;
    },
    exit() {
      now -= 1;
    },
    get peak() {
      return peak;
    },
  };
}

test('同一条车道串行：三条活不会同时跑', async () => {
  const m = meter();
  const order: number[] = [];

  const out = await runLanes(
    [1, 2, 3],
    async (n) => {
      m.enter();
      order.push(n);
      await sleep(10);
      m.exit();
      return n * 10;
    },
    { laneOf: () => 'b' },
  );

  assert.equal(m.peak, 1, '同一节点同时只能有一个轮次，否则两个进程写同一个工作区');
  assert.deepEqual(order, [1, 2, 3]);
  assert.deepEqual(out.map((r) => (r.ok ? r.value : null)), [10, 20, 30]);
});

test('不同车道并行：三条线同时跑', async () => {
  const m = meter();

  await runLanes(
    ['d', 'e', 'f'],
    async (id) => {
      m.enter();
      await sleep(20);
      m.exit();
      return id;
    },
    { laneOf: (id) => id },
  );

  assert.equal(m.peak, 3);
});

test('同车道前一条抛异常，后一条照样跑（不能断链）', async () => {
  const ran: number[] = [];

  const out = await runLanes(
    [1, 2],
    async (n) => {
      if (n === 1) throw new Error('boom');
      ran.push(n);
      return n;
    },
    { laneOf: () => 'b' },
  );

  assert.deepEqual(ran, [2], '第一条失败后，同车道的第二条必须继续');
  assert.equal(out[0].ok, false);
  assert.equal(out[1].ok, true);
  if (!out[0].ok) assert.match(out[0].error, /boom/);
});

test('一条车道抛异常不影响另一条车道', async () => {
  const done: string[] = [];

  const out = await runLanes(
    ['d', 'e'],
    async (id) => {
      if (id === 'd') throw new Error('d 挂了');
      await sleep(5);
      done.push(id);
      return id;
    },
    { laneOf: (id) => id },
  );

  assert.deepEqual(done, ['e']);
  assert.equal(out[0].ok, false);
  assert.equal(out[1].ok, true);
});

test('结果按输入下标归位，不按完成顺序', async () => {
  // 故意让后面的先完成：30 最慢，10 最快
  const out = await runLanes(
    [30, 10, 20],
    async (ms) => {
      await sleep(ms / 10);
      return ms;
    },
    { laneOf: (x) => String(x) },
  );

  assert.deepEqual(out.map((r) => (r.ok ? r.value : null)), [30, 10, 20]);
});

test('空车道键也能跑（不会因为 laneOf 返回空串就丢活）', async () => {
  const out = await runLanes([1, 2], async (n) => n, { laneOf: () => '' });
  // 空串会被归一成同一条车道，所以是串行，但两个都要跑到
  assert.deepEqual(out.map((r) => (r.ok ? r.value : null)), [1, 2]);
});

test('空输入返回空数组，不炸', async () => {
  const out = await runLanes([], async () => 1, { laneOf: () => 'a' });
  assert.deepEqual(out, []);
});

/* ---------- 车位 ---------- */

test('信号量不会超发', async () => {
  const pool = new Semaphore(2);
  const m = meter();

  await Promise.all(
    Array.from({ length: 10 }, async () => {
      await pool.acquire();
      m.enter();
      await sleep(5);
      m.exit();
      pool.release();
    }),
  );

  assert.equal(m.peak, 2);
  assert.equal(pool.busy(), 0);
});

test('释放时把车位直接交给队首，不经过 free（否则会多放一个进来）', async () => {
  const pool = new Semaphore(1);
  await pool.acquire();
  const next = pool.acquire();
  assert.equal(pool.waiting(), 1);

  pool.release();
  await next;
  assert.equal(pool.waiting(), 0);
  assert.equal(pool.busy(), 1);
  pool.release();
});

test('车位归还后能再拿到（异常路径也必须还）', async () => {
  const pool = new Semaphore(1);
  try {
    await pool.acquire();
    throw new Error('模拟 worker 抛异常');
  } catch {
    pool.release();
  }
  assert.equal(pool.busy(), 0);
  await pool.acquire();
  assert.equal(pool.busy(), 1);
  pool.release();
});

test('池大小非法时退化成 1，不会变成 0 或 NaN', () => {
  assert.equal(new Semaphore(0).limit, 1);
  assert.equal(new Semaphore(-3).limit, 1);
  assert.equal(new Semaphore(Number.NaN).limit, 1);
  assert.equal(new Semaphore(2.7).limit, 2);
});

test('等车位时可以被取消，不用等前面全部跑完', async () => {
  const pool = new Semaphore(1);
  await pool.acquire();                      // 占满
  const ac = new AbortController();
  const waiting = pool.acquire(ac.signal);
  setTimeout(() => ac.abort(), 20);

  await assert.rejects(waiting, /canceled/);
  assert.equal(pool.busy(), 1, '被取消的排队者不能占着车位');
  pool.release();
  assert.equal(pool.busy(), 0);
});
