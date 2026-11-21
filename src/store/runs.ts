import { DATA_DIR } from '../kernel/paths.ts';
// 运行记录：一轮一个文件，写完才 rename 到正式路径。
// 单个文件坏了只丢一轮，不会像单文件 JSON 那样一次全没。
import fs from 'node:fs';
import path from 'node:path';
import type { Artifact, Ask, Dispatch, SpawnRequest, Stray, Tell } from '../protocol/schema.ts';
import type { Usage } from '../adapters/usage.ts';

export type RunRecord = {
  id: number;
  parent?: number;
  node: string;
  plugin: string;
  task: string;
  state: 'done' | 'failed' | 'blocked' | 'canceled';
  startedAt: string;
  ms: number;
  summary: string;
  question?: string;
  artifacts: Artifact[];
  /**
   * 这一轮写了、但没通过校验的文件（越界、备份失败、不存在）。
   * 不记的话，失败的一轮在界面上就是「毫无产出」，而文件其实躺在磁盘上（#40）。
   */
  stray?: Stray[];
  dispatch: Dispatch[];
  /** 这一轮用的模型与输入规模，用来估算成本（真 token 数要 provider 给，现在先记代理指标） */
  model?: string;
  promptBytes?: number;
  /** 这一轮的真实 token 用量（从 CLI 会话日志读），拿不到就没有这个字段 */
  usage?: Usage;
  /** 这一轮提出的派生请求（全部需要用户批准） */
  spawn?: SpawnRequest[];
  /** 这一轮发给同任务其他节点的留言 */
  tell?: Tell[];
  /** 这一轮明确在问谁（父级必须处理，不能当没看见） */
  ask?: Ask[];
  /** 这一轮做完的是哪个阶段（对应 tasks.plan 里的 id） */
  phase?: string;
  /** 判通过时给的证据片段；老记录里没有这个字段 */
  evidence?: string[];
  /** 收口轮的判断：通过 / 打回。普通工作轮没有这个字段 */
  verdict?: 'pass' | 'rework';
  warnings: string[];
  error?: string;
};

// MA_DATA_DIR 只给测试用：把落盘位置挪到临时目录，别把真实 .data 写花
const DIR = DATA_DIR;
const RUNS = path.join(DIR, 'runs');
const LEGACY = path.join(DIR, 'runs.json');

function readOne(file: string): RunRecord | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as RunRecord;
  } catch {
    return null;
  }
}

/** 老版本把全部轮次塞在 runs.json 里，第一次读时搬到 runs/ 目录 */
function migrateLegacy(): void {
  if (!fs.existsSync(LEGACY)) return;
  try {
    const all = JSON.parse(fs.readFileSync(LEGACY, 'utf8')) as RunRecord[];
    if (!Array.isArray(all) || !all.length) return;
    fs.mkdirSync(RUNS, { recursive: true });
    for (const rec of all) {
      if (typeof rec?.id !== 'number') continue;
      const file = path.join(RUNS, String(rec.id).padStart(4, '0') + '.json');
      if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify(rec, null, 2), 'utf8');
    }
    fs.renameSync(LEGACY, LEGACY + '.migrated');
    console.log(`已把 ${all.length} 条历史从 runs.json 迁到 runs/`);
  } catch {
    // 迁移失败不影响后续：老文件留着，新记录照常写
  }
}

export function loadRuns(): RunRecord[] {
  migrateLegacy();
  let files: string[];
  try {
    files = fs.readdirSync(RUNS).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const out: RunRecord[] = [];
  for (const f of files) {
    const rec = readOne(path.join(RUNS, f));
    if (rec && typeof rec.id === 'number') out.push(rec);
  }
  return out.sort((a, b) => a.id - b.id);
}

/** 这轮的落盘路径。db 那边要记同一个地址，所以对外暴露 */
export function runPath(id: number): string {
  return path.join(RUNS, String(id).padStart(4, '0') + '.json');
}

export function saveRun(rec: RunRecord): void {
  fs.mkdirSync(RUNS, { recursive: true });
  const file = runPath(rec.id);
  const tmp = path.join(RUNS, `.${rec.id}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(rec, null, 2), 'utf8');
  // rename 是原子的：读的人要么看到旧文件，要么看到完整新文件，不会看到半截
  fs.renameSync(tmp, file);
}

export function nextId(): number {
  const all = loadRuns();
  return all.length ? Math.max(...all.map((r) => r.id)) + 1 : 1;
}
