import fs from 'node:fs';

/**
 * 轮次 json 的解析缓存。
 *
 * 一轮一个文件、写完不再改，但界面每 4 秒拉一次任务详情——
 * 一千轮的任务等于每 4 秒读一千个文件、解析一千次 JSON，
 * 这些都发生在 HTTP 处理函数里，会直接卡住其它请求（外部审计 m1）。
 *
 * 键用 path，值里存 mtime + size：文件被重写（续跑、补验）时自然失效，
 * 不需要主动清理。上限 500 条，超了先丢最早插入的一批。
 */
type Entry = { key: string; data: unknown };

const MAX = 500;
const cache = new Map<string, Entry>();

export function readRunJson<T>(file: string): T | null {
  let key: string;
  try {
    const st = fs.statSync(file);
    key = `${st.mtimeMs}:${st.size}`;
  } catch {
    return null;
  }
  const hit = cache.get(file);
  if (hit && hit.key === key) return hit.data as T;
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8')) as T;
    if (cache.size >= MAX) {
      let n = Math.ceil(MAX / 4);
      for (const k of cache.keys()) {
        cache.delete(k);
        if (--n <= 0) break;
      }
    }
    cache.set(file, { key, data });
    return data;
  } catch {
    return null;
  }
}
