// 任务归档：把一次任务交出来的产物复制到一个独立目录，附 manifest.json。
//
// 为什么要有（2026-11-21 决策 P0-11）：
// `.sandbox/t<id>/` 是运行时目录，任务一多就分不清哪份是谁的；
// 而且它会被下次同名任务覆盖、也可能被清理。归档区是「这次任务到底交了哪些文件」的
// 长期凭证：按月份分目录，一个任务一个文件夹，清单里带字节数和 sha256。
//
// 三条边界：
// 1. **只读源文件**：复制，不移动、不改动 .sandbox 里的原件。
// 2. **失败不影响任务**：归档是记账，记不上不能把已经跑完的任务判死。
// 3. **有上限**：单任务最多 ARCHIVE_MAX_FILES 个、ARCHIVE_MAX_BYTES 字节，
//    超了就只记清单不复制——避免一个任务产出几十 GB 把盘塞满。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ARCHIVE_DIR } from './paths.ts';

/** 单任务最多复制多少个文件 */
const ARCHIVE_MAX_FILES = 500;
/** 单任务最多复制多少字节（超过就只记清单） */
const ARCHIVE_MAX_BYTES = 500 * 1024 * 1024;

export type ArchivedArtifact = {
  /** 原始绝对路径 */
  from: string;
  /** 归档区里的相对路径（相对任务目录）；没复制时为 null */
  kept: string | null;
  bytes: number;
  sha256: string;
  runId: number;
  node: string;
  /** 复制失败或超限时的原因 */
  skipped?: string;
};

export type ArchiveManifest = {
  taskId: number;
  state: string;
  /** 任务正文（截断到 4000 字，清单不该比任务本身还大） */
  task: string;
  createdAt: string;
  endedAt: string;
  archivedAt: string;
  project: { name: string; root: string };
  runs: Array<{
    id: number;
    node: string;
    state: string;
    verdict: string | null;
    ms: number;
    summary: string;
  }>;
  artifacts: ArchivedArtifact[];
  /** 登记了但归档时已经不在盘上的 */
  missing: string[];
  stats: { files: number; bytes: number; skipped: number };
};

/** 月份目录：2026-11 */
function monthOf(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** 文件名里不能出现路径分隔符和 Windows 保留字符 */
function safeName(s: string): string {
  return String(s || 'x').replace(/[\\/:*?"<>|]/g, '_').slice(0, 80) || 'x';
}

function sha256File(p: string): string {
  try {
    const h = crypto.createHash('sha256');
    h.update(fs.readFileSync(p));
    return h.digest('hex');
  } catch {
    return '';
  }
}

/**
 * 归档一个任务。
 *
 * @param rows 这个任务的全部轮次（含 artifacts / summary / state / ms）
 * @returns 任务目录；没东西可归档或出错时返回 null（调用方只记日志，不判失败）
 */
export function archiveTask(input: {
  taskId: number;
  state: string;
  task: string;
  createdAt: number;
  endedAt: number | null;
  project: { name: string; root: string };
  runs: Array<{
    id: number;
    node: string;
    state: string;
    verdict?: string | null;
    ms: number;
    summary?: string;
    artifacts?: Array<{ path?: string; bytes?: number }>;
  }>;
  /** 注入点：测试用临时目录，生产用 ARCHIVE_DIR */
  root?: string;
  now?: Date;
}): string | null {
  const base = input.root || ARCHIVE_DIR;
  const now = input.now || new Date();
  const dir = path.join(base, monthOf(now), 't' + input.taskId);

  const manifest: ArchiveManifest = {
    taskId: input.taskId,
    state: input.state,
    task: String(input.task || '').slice(0, 4000),
    createdAt: new Date(input.createdAt).toISOString(),
    endedAt: input.endedAt ? new Date(input.endedAt).toISOString() : '',
    archivedAt: now.toISOString(),
    project: input.project,
    runs: input.runs.map((r) => ({
      id: r.id,
      node: r.node,
      state: r.state,
      verdict: r.verdict ?? null,
      ms: r.ms,
      summary: String(r.summary || '').slice(0, 500),
    })),
    artifacts: [],
    missing: [],
    stats: { files: 0, bytes: 0, skipped: 0 },
  };

  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    return null;
  }

  /** 同一个文件被多轮登记过：只复制一次，清单里合并 */
  const seen = new Map<string, ArchivedArtifact>();
  let totalBytes = 0;

  for (const r of input.runs) {
    for (const a of r.artifacts ?? []) {
      const from = String(a.path || '');
      if (!from) continue;
      if (seen.has(from)) continue;

      const rec: ArchivedArtifact = {
        from,
        kept: null,
        bytes: 0,
        sha256: '',
        runId: r.id,
        node: r.node,
      };

      let st: fs.Stats;
      try {
        st = fs.statSync(from);
      } catch {
        manifest.missing.push(from);
        continue;
      }
      if (!st.isFile()) {
        // 目录不复制（清单里也不该出现，产物登记只登记文件）
        manifest.missing.push(from);
        continue;
      }

      rec.bytes = st.size;
      rec.sha256 = sha256File(from);
      totalBytes += st.size;

      const over = manifest.stats.files >= ARCHIVE_MAX_FILES || totalBytes > ARCHIVE_MAX_BYTES;
      if (over) {
        rec.skipped = `超出归档上限（${ARCHIVE_MAX_FILES} 个 / ${ARCHIVE_MAX_BYTES} 字节）`;
        manifest.stats.skipped += 1;
        seen.set(from, rec);
        manifest.artifacts.push(rec);
        continue;
      }

      // 归档区里的落点：<节点>/<文件名>，同名加轮次号
      const nodeDir = safeName(r.node);
      let name = safeName(path.basename(from));
      const rel = path.join(nodeDir, name);
      const abs = path.join(dir, rel);
      try {
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        if (fs.existsSync(abs)) {
          name = safeName(path.basename(from).replace(/\.[^.]+$/, '')) + '_r' + r.id + path.extname(from);
        }
        const finalRel = path.join(nodeDir, name);
        const finalAbs = path.join(dir, finalRel);
        fs.copyFileSync(from, finalAbs);
        // 复制完核字节数：磁盘满或占用时 copyFileSync 可能不抛错但写不全
        if (fs.statSync(finalAbs).size !== st.size) {
          rec.skipped = '复制后字节数不一致';
          manifest.stats.skipped += 1;
        } else {
          rec.kept = finalRel;
          manifest.stats.files += 1;
          manifest.stats.bytes += st.size;
        }
      } catch (e) {
        rec.skipped = '复制失败：' + String((e as Error).message ?? e).slice(0, 120);
        manifest.stats.skipped += 1;
      }

      seen.set(from, rec);
      manifest.artifacts.push(rec);
    }
  }

  try {
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  } catch {
    return dir;
  }
  return dir;
}

/** 读某个任务的 manifest（界面展示用）；不存在返回 null */
export function readManifest(taskId: number, root?: string): ArchiveManifest | null {
  const base = root || ARCHIVE_DIR;
  try {
    // 月份目录不固定，扫一遍找 t<id>
    for (const m of fs.readdirSync(base)) {
      const f = path.join(base, m, 't' + taskId, 'manifest.json');
      if (fs.existsSync(f)) {
        return JSON.parse(fs.readFileSync(f, 'utf8')) as ArchiveManifest;
      }
    }
  } catch {
    // 没归档过
  }
  return null;
}

/** 删一个任务的归档目录。返回删掉的路径；不存在返回 null */
export function removeArchive(taskId: number, root?: string): string | null {
  const base = root || ARCHIVE_DIR;
  try {
    for (const m of fs.readdirSync(base)) {
      const dir = path.join(base, m, 't' + taskId);
      if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
        return dir;
      }
    }
  } catch {
    // 没有就没有
  }
  return null;
}
