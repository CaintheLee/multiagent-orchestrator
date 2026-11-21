// 每轮 token 用量：从 CLI 自己的会话日志里读，不猜、不换算。
//
// codebuddy 每次调用会在 ~/.codebuddy/projects/<工作区>/<session>.jsonl 里落一条会话，
// 每次模型调用的 providerData.rawUsage 带 prompt_tokens / completion_tokens / credit。
// 一轮里可能有多次模型调用（工具循环），所以要把这一轮的全部 step 加起来。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type Usage = {
  /** 提示词 token（含缓存命中） */
  input: number;
  /** 生成 token */
  output: number;
  total: number;
  /** 命中缓存的 token，用来解释「为什么输入很大但很便宜」 */
  cacheRead: number;
  /** provider 记的 credit，没有就是 0 */
  credit: number;
  /** 这一轮里实际发生了几次模型调用 */
  steps: number;
};

const DEFAULT_ROOT = path.join(os.homedir(), '.codebuddy', 'projects');
/** 超过这个大小的会话文件不读，避免一个巨型日志拖住收尾 */
const MAX_FILE = 32 * 1024 * 1024;

function empty(): Usage {
  return { input: 0, output: 0, total: 0, cacheRead: 0, credit: 0, steps: 0 };
}

function add(a: Usage, b: Usage): Usage {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    total: a.total + b.total,
    cacheRead: a.cacheRead + b.cacheRead,
    credit: a.credit + b.credit,
    steps: a.steps + b.steps,
  };
}

/**
 * 在 root 下找「工作区 = cwd、且在这轮开始之后写过」的会话文件，累加 usage。
 * 找不到返回 null——宁可显示「未知」，也不要拿别的轮次的数字冒充。
 */
export function readUsageFrom(root: string, cwd: string, sinceMs: number): Usage | null {
  const target = path.resolve(cwd).toLowerCase();
  let dirs: fs.Dirent[];
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }

  let out: Usage | null = null;
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const dir = path.join(root, d.name);
    try {
      // 目录 mtime 是子项变动时间；两分钟缓冲覆盖「目录刚创建、文件还在写」
      if (fs.statSync(dir).mtimeMs < sinceMs - 120_000) continue;
    } catch {
      continue;
    }

    let files: string[];
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue;
    }

    for (const f of files) {
      const p = path.join(dir, f);
      let st: fs.Stats;
      try {
        st = fs.statSync(p);
      } catch {
        continue;
      }
      // 上一轮的会话文件 mtime 在这轮开始之前，直接跳过
      if (st.mtimeMs < sinceMs - 5_000 || st.size > MAX_FILE) continue;

      let text: string;
      try {
        text = fs.readFileSync(p, 'utf8');
      } catch {
        continue;
      }
      if (!text.includes('rawUsage')) continue;

      const seen = new Set<string>();
      let acc = empty();
      for (const line of text.split('\n')) {
        if (!line.includes('rawUsage')) continue;
        let o: {
          type?: string;
          id?: string;
          cwd?: string;
          providerData?: { messageId?: string; rawUsage?: Record<string, unknown> };
        };
        try {
          o = JSON.parse(line);
        } catch {
          continue;
        }
        if (path.resolve(String(o.cwd || '')).toLowerCase() !== target) continue;
        const u = o.providerData?.rawUsage;
        if (!u) continue;
        // 同一次模型调用可能在多行里出现，按 messageId 去重
        const key = String(o.providerData?.messageId || o.id || '');
        if (key && seen.has(key)) continue;
        if (key) seen.add(key);
        acc.input += Number(u.prompt_tokens ?? 0);
        acc.output += Number(u.completion_tokens ?? 0);
        acc.total += Number(u.total_tokens ?? 0);
        acc.cacheRead += Number(u.prompt_cache_hit_tokens ?? u.cache_read_input_tokens ?? 0);
        acc.credit += Number(u.credit ?? 0);
        acc.steps += 1;
      }
      if (acc.steps) out = out ? add(out, acc) : acc;
    }
  }
  return out;
}

/** 生产用：root 取 codebuddy 的默认会话目录，可用 CODEBUDDY_PROJECTS 覆盖 */
export function readUsage(cwd: string, sinceMs: number): Usage | null {
  return readUsageFrom(process.env.CODEBUDDY_PROJECTS || DEFAULT_ROOT, cwd, sinceMs);
}
