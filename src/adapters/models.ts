import { DATA_DIR } from '../kernel/paths.ts';
// 可用模型清单：以 CLI 自己报的为准，缓存起来，定期刷新。
//
// 为什么不再写死：服务端会下线模型（hy4free 就是这样没的），写死的列表只会
// 让界面显示一个根本用不了的选项。这里的顺序是「实时探测 → 上次成功的缓存 → 内置兜底」，
// 并且把来源和取到的时间一起返回，界面能说清「这份列表是不是新鲜」。
import fs from 'node:fs';
import path from 'node:path';
import { PROVIDERS } from './table.ts';

export type ModelSource = 'live' | 'cache' | 'fallback';

export type ModelList = {
  models: string[];
  /** live=刚从 CLI 问到；cache=上次成功的结果；fallback=内置兜底 */
  source: ModelSource;
  /** 这份列表的取得时间 */
  at: number;
  /** 哪些 provider 提供了列表（现在只有 codebuddy） */
  from: string[];
  /** 最近一次探测失败的原因，成功时为 undefined */
  error?: string;
};

const FILE = path.join(DATA_DIR, 'models.json');
/** 实时列表缓存 10 分钟；兜底列表只缓存 1 分钟，好让下次请求快点重试 */
const TTL_LIVE = 10 * 60_000;
const TTL_WEAK = 60_000;
/** 连缓存都没有时的兜底：CLI 的三个通用档位，不带任何具体厂商型号 */
const FALLBACK = ['fast-model', 'balanced-model', 'deep-model'];

let snap: ModelList | null = null;
let inflight: Promise<ModelList> | null = null;

function readCache(): ModelList | null {
  try {
    const j = JSON.parse(fs.readFileSync(FILE, 'utf8')) as ModelList;
    if (Array.isArray(j.models) && j.models.length && typeof j.at === 'number') {
      return { ...j, source: 'cache', from: Array.isArray(j.from) ? j.from : [] };
    }
  } catch {
    // 没有缓存或缓存坏了都走兜底
  }
  return null;
}

function writeCache(m: ModelList): void {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ models: m.models, at: m.at, from: m.from }, null, 2), 'utf8');
    fs.renameSync(tmp, FILE);
  } catch {
    // 缓存写不进去不影响本次结果
  }
}

/** 逐个问支持 models() 的 provider，合并去重 */
export async function refreshModels(): Promise<ModelList> {
  const from: string[] = [];
  const got = new Set<string>();
  const errors: string[] = [];

  for (const [name, p] of Object.entries(PROVIDERS)) {
    if (!p.models) continue;
    try {
      const list = await p.models();
      for (const m of list) got.add(m);
      from.push(name);
    } catch (e) {
      errors.push(`${name}：${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const error = errors.length ? errors.join('；') : undefined;
  if (got.size) {
    snap = { models: [...got], source: 'live', at: Date.now(), from, error };
    writeCache(snap);
    return snap;
  }

  // 全失败：过期缓存也比空列表强，至少界面还能选；同时把失败原因带出去
  const cached = readCache();
  if (cached) {
    snap = { ...cached, source: 'cache', error };
    return snap;
  }
  snap = { models: FALLBACK, source: 'fallback', at: Date.now(), from: [], error };
  return snap;
}

/** 同步拿当前快照（内存或用磁盘缓存补），绝不阻塞。给「页面加载」这种不能等的场景用 */
export function peekModels(): ModelList | null {
  if (!snap) snap = readCache();
  return snap;
}

/**
 * 取模型清单。默认走缓存，过了 TTL 才重新探测；refresh=true 强制刷新。
 * 并发调用会共用同一次探测，不会同时起一串 CLI。
 */
export async function getModels(opts: { refresh?: boolean } = {}): Promise<ModelList> {
  if (!snap) snap = readCache();
  const ttl = snap?.source === 'live' ? TTL_LIVE : TTL_WEAK;
  if (!opts.refresh && snap && Date.now() - snap.at < ttl) return snap;
  if (inflight) return inflight;
  inflight = refreshModels().finally(() => { inflight = null; });
  return inflight;
}

/** 某个模型名是否在当前列表里。空字符串（用默认模型）永远算合法 */
export function modelKnown(list: ModelList, model: string): boolean {
  return !model || list.models.includes(model);
}
