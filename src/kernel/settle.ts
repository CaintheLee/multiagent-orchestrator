// 产物校验：文件真的在、真的在这个节点的工作区里。
// 这是「越界写文件」的第一道关口，不依赖模型自觉。
import fs from 'node:fs';
import path from 'node:path';
import type { NodeConfig } from './tree.ts';
import type { Artifact, Receipt, Stray } from '../protocol/schema.ts';

/** 超过这个大小的文件不读进来核对，避免一个大视频把内存吃满 */
const EVIDENCE_MAX_BYTES = 2 * 1024 * 1024;

/** 二进制/打包类产物没法做文本匹配，直接跳过 */
const BINARY_EXT = /\.(png|jpe?g|webp|gif|bmp|ico|mp4|mov|webm|mp3|wav|ogg|pdf|zip|7z|rar|gz|glb|gltf|fbx|blend|psd|ttf|otf|woff2?)$/i;

/**
 * 这批产物里有没有能拿来做文本比对的。
 *
 * 为什么要单独暴露：全是二进制（图片/模型）或全读不到时，verifyEvidence 无从比对，
 * 返回空数组会被理解成「证据全中」——那是静默放行，不是通过。
 * 调用方拿到 false 时应该记一条提示，至少别让它悄悄过去。
 */
export function hasTextArtifacts(artifacts: Artifact[]): boolean {
  return artifacts.some((a) => {
    if (BINARY_EXT.test(a.path)) return false;
    try {
      const st = fs.statSync(a.path);
      return st.isFile() && st.size <= EVIDENCE_MAX_BYTES;
    } catch {
      return false;
    }
  });
}

/**
 * 证据核对：每一条 evidence 必须原样出现在某个文本产物里。
 * 这是零 token 的「你到底打没打开文件」检查——编造的、概括过的、改过标点的都搜不到。
 * 返回搜不到的那些（空数组 = 全中，或者压根没有可核对的文本产物）。
 */
export function verifyEvidence(evidence: string[], artifacts: Artifact[]): string[] {
  if (!evidence.length || !artifacts.length) return [];
  const texts: string[] = [];
  for (const a of artifacts) {
    if (BINARY_EXT.test(a.path)) continue;
    try {
      const st = fs.statSync(a.path);
      if (!st.isFile() || st.size > EVIDENCE_MAX_BYTES) continue;
      texts.push(fs.readFileSync(a.path, 'utf8'));
    } catch {
      // 文件读不到就当没有可核对的内容，交给 checkArtifacts 去报
    }
  }
  if (!texts.length) return [];
  return evidence.filter((e) => !texts.some((t) => t.includes(e)));
}

/**
 * 「这一轮的证据够不够」——判 pass 和补验两处用同一个口径，免得一边严一边松。
 * 有产物但没给证据算不合格；没有产物（纯问答/纯派活）不要求证据。
 */
export function evidenceProblem(ev: string[] | undefined, artifacts: Artifact[]): string[] {
  if (!artifacts.length) return [];
  const list = ev ?? [];
  if (!list.length) return ['这一轮有产物，但一条 evidence 都没给'];
  // 只抄一句搪塞不行：至少两处，且要分散在产物里
  if (list.length < 2) return ['evidence 只有 1 条，至少给 2 条'];
  return verifyEvidence(list, artifacts);
}

/**
 * target 是否落在 root 里面（root 自己不算「里面」）。
 * 不能写成 `!rel.startsWith('..')`：`..notes.md` 这种合法文件名同样以两点开头，会被误杀。
 */
export function inside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return !!rel && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
}

/** 外部产物备份到工作区时用的子目录 */
const EXTERNAL_SUBDIR = '_external';

/**
 * 把白名单目录里的产物复制一份回工作区。
 *
 * 返回备份路径；失败返回 null（调用方据此判失败，不静默放行）。
 * 复制完要核对字节数：磁盘满、权限不足、被别的进程占用时，
 * copyFileSync 有时不抛错但写不全，光看「没异常」不算成功。
 */
function backupInto(root: string, idx: number, baseDir: string, src: string): string | null {
  try {
    const dest = path.join(root, EXTERNAL_SUBDIR, String(idx), path.relative(baseDir, src));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    // 不能只比大小：同尺寸但内容不同（old → new）时会跳过复制，留下过期副本，
    // 续跑读到的是旧值。copyFileSync 本身是幂等的，直接覆盖最省心。
    fs.copyFileSync(src, dest);
    if (fs.statSync(dest).size !== fs.statSync(src).size) return null;
    return dest;
  } catch {
    return null;
  }
}

/** 扫描时跳过的目录：依赖、版本库、引擎缓存，看一眼都嫌慢 */
const SKIP_DIR = new Set(['node_modules', '.git', '.godot', '__pycache__', '.venv', 'dist', 'build', '_external']);

/** 扫到这么多条目就停：防止把一个大仓库整个走一遍 */
const SCAN_MAX_ENTRIES = 20_000;

export type ScanResult = { files: Stray[]; scanned: number; hitLimit: boolean };

/**
 * 进程异常结束（超时、被杀、没交出回执）时的产物兜底。
 *
 * 为什么需要：只有拿到回执才会走 checkArtifacts，没有回执就等于「什么都没做」——
 * #41 的 d 跑了 30 分钟、落了 145 个文件（八环节截图 + 探针 JSON），
 * 因为回执在最后没写成，界面上一个字都看不到。
 *
 * 口径刻意保守：只认 mtime 晚于开跑时间（留 2 秒余量给文件系统精度）、
 * 大小非零、不在跳过目录里的文件；扫到上限就停并如实报告，不假装扫全了。
 */
export function scanRecent(
  node: NodeConfig,
  since: number,
  extraDirs: string[] = [],
): ScanResult {
  const roots: string[] = [];
  try {
    roots.push(fs.realpathSync(path.resolve(node.workspace)));
  } catch {
    roots.push(path.resolve(node.workspace));
  }
  for (const d of extraDirs) {
    try {
      roots.push(fs.realpathSync(path.resolve(d)));
    } catch {
      roots.push(path.resolve(d));
    }
  }

  const cutoff = since - 2_000;
  /** 内部带 mtime：按时间倒序才像「这一轮写了什么」，按大小排会把大图和关键文档混在一起 */
  const files: Array<Stray & { mtime: number }> = [];
  let scanned = 0;
  let hitLimit = false;

  const walk = (dir: string, depth: number): void => {
    if (hitLimit || depth > 6) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (hitLimit) return;
      if (++scanned > SCAN_MAX_ENTRIES) { hitLimit = true; return; }
      if (SKIP_DIR.has(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(p, depth + 1);
        continue;
      }
      if (!e.isFile()) continue;
      try {
        const st = fs.statSync(p);
        if (!st.isFile() || st.size === 0 || st.mtimeMs < cutoff) continue;
        files.push({ path: p, bytes: st.size, why: '本轮写过，但没等到回执就结束了', mtime: st.mtimeMs });
      } catch {
        // 扫的这一刻被删了：跳过
      }
    }
  };

  for (const r of roots) walk(r, 0);
  files.sort((a, b) => b.mtime - a.mtime);
  return {
    files: files.slice(0, 40).map((f) => ({ path: f.path, bytes: f.bytes, why: f.why })),
    scanned,
    hitLimit,
  };
}

/**
 * 产物校验。
 *
 * 允许两种位置：
 * - 工作区内（默认，物理隔离）；
 * - `extraDirs` 白名单里的绝对目录（共享位置，如 D:/YourProject\docs）。
 *   这类产物会先复制一份到 `<工作区>/_external/`，`backup` 字段指向副本。
 *
 * 为什么外部产物必须备份：续跑、checkpoint、导出都按路径读文件，
 * 共享目录里的东西随时可能被别的进程改掉或删掉。没有副本，
 * 一轮跑完等于没留下可复用的东西（#40 的教训）。
 */
export function checkArtifacts(
  receipt: Receipt,
  node: NodeConfig,
  opts: { extraDirs?: string[]; refDirs?: string[] } = {},
): {
  ok: Artifact[];
  bad: string[];
  /** 写了但没通过的文件。失败也要留档，否则「它到底干了什么」查不到 */
  stray: Stray[];
  backedUp: Array<{ from: string; to: string }>;
} {
  const ok: Artifact[] = [];
  const bad: string[] = [];
  const stray: Stray[] = [];
  const backedUp: Array<{ from: string; to: string }> = [];
  /** 记一条「没通过」，同时把能拿到的大小带上——没有大小也总比只剩一句报错强 */
  const reject = (p: string, why: string, msg: string) => {
    bad.push(msg);
    let bytes = 0;
    try {
      const st = fs.statSync(p);
      if (st.isFile()) bytes = st.size;
    } catch {
      // 文件确实不在，留 0
    }
    stray.push({ path: p, bytes, why });
  };
  // 白名单目录也解析软链，否则配了链接目录时归属判断会全错
  const extra = (opts.extraDirs ?? []).map((d) => {
    try {
      return fs.realpathSync(d);
    } catch {
      return path.resolve(d);
    }
  });
  /**
   * 只读引用目录：收口轮会把下级的产物列进 artifacts 说明「我核了这些」。
   * 它们是下级的交付，不是本节点的交付——不复制备份，也不判越界。
   * 不认这一条的话，主控每次收口都会因为「引用了下级工作区里的文件」被判失败（#42）。
   */
  const refs = (opts.refDirs ?? []).map((d) => {
    try {
      return fs.realpathSync(d);
    } catch {
      return path.resolve(d);
    }
  });
  // 根也解析一次软链：工作区自己可能是链接，不解析的话后面比对会全错
  let root = path.resolve(node.workspace);
  try {
    root = fs.realpathSync(root);
  } catch {
    // 目录还不存在，下面逐个 stat 时会报「文件不存在」，这里不用管
  }

  for (const a of receipt.artifacts) {
    // 相对路径按工作区解析。模型经常只写文件名，按进程 cwd 解析会直接判成越界
    const abs = path.isAbsolute(a.path) ? path.resolve(a.path) : path.resolve(root, a.path);
    // 先解析软链再判归属：工作区里放一个指向外部的链接，
    // 就能把任意文件当产物交上来，而 evidence 校验还会去读它的内容
    let real = abs;
    try {
      real = fs.realpathSync(abs);
    } catch {
      // 文件不存在，后面 stat 会报
    }

    const inWorkspace = inside(root, real);
    const dirIdx = inWorkspace ? -1 : extra.findIndex((d) => inside(d, real));
    const isRef = !inWorkspace && dirIdx < 0 && refs.some((d) => inside(d, real));
    if (!inWorkspace && dirIdx < 0 && !isRef) {
      reject(real, extra.length ? '不在工作区，也不在 extra_dirs 允许的目录里' : '不在工作区（未配置 extra_dirs）',
        extra.length
          ? `${a.path}（既不在工作区 ${node.workspace} 内，也不在允许的外部目录 ${extra.join('、')} 内）`
          : `${a.path}（不在工作区 ${node.workspace} 内；要写外部目录，先在 agents.toml 的 [root] 配 extra_dirs）`);
      continue;
    }

    let st: fs.Stats;
    try {
      st = fs.statSync(real);
    } catch {
      reject(real, '文件不存在', `${a.path}（文件不存在）`);
      continue;
    }
    if (!st.isFile()) {
      reject(real, '不是一个文件', `${a.path}（不是一个文件）`);
      continue;
    }

    if (inWorkspace) {
      ok.push({ ...a, path: real, bytes: st.size });
      continue;
    }
    if (isRef) {
      // 只登记引用：不复制、不备份。它本来就是下级的产物，备份会变成两份
      ok.push({ ...a, path: real, bytes: st.size, ref: true });
      continue;
    }

    // 外部目录：先备份，备份不成不登记
    const backup = backupInto(root, dirIdx, extra[dirIdx], real);
    if (!backup) {
      reject(real, '备份到工作区失败', `${a.path}（在允许目录里，但复制备份到工作区失败，检查磁盘空间与权限）`);
      continue;
    }
    backedUp.push({ from: real, to: backup });
    ok.push({ ...a, path: real, bytes: st.size, backup });
  }
  return { ok, bad, stray, backedUp };
}
