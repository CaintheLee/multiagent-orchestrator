// /api/artifact：把一个产物文件读出来给界面预览。
//
// 抽出来单独放（决策 P1-23）的原因：这段是**唯一的文件读取出口**，
// 也是最该被反复审的地方（越界、软链、CSP 三件事都在这）。
// 混在 1400 行的 server.ts 里时，改一处要往上翻两百行才能确认上下文。
//
// 三条防线：
// 1. 先 realpath 再判归属——否则工作区里一个指向外部的软链就能读到任意文件；
// 2. 归属范围是「.sandbox 根 + 非隔离节点的工作区」，不在里面直接 403；
// 3. 主动文档（html/svg）一律加 CSP sandbox，脚本拿不到 cookie、调不动写接口。

import fs from 'node:fs';
import path from 'node:path';
import type http from 'node:http';
import { loadConfig, workspaceIsIsolated } from '../../kernel/tree.ts';
import { SANDBOX_ROOT } from '../../kernel/paths.ts';
import { inside } from '../../kernel/settle.ts';
import { previewHeaders } from '../../kernel/preview.ts';

/** 扩展名 → Content-Type。只列预览会用到的，认不出的按纯文本。 */
export const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.log': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
};

/**
 * 处理 /api/artifact。
 *
 * @returns true 表示这个请求已经被处理（调用方直接 return）
 */
export function handleArtifact(url: URL, res: http.ServerResponse, cfgFile: string): boolean {
  const target = url.searchParams.get('path') || '';
  const abs = path.resolve(target);

  let cfg;
  try {
    cfg = loadConfig(cfgFile);
  } catch {
    res.writeHead(500);
    res.end('配置读不了');
    return true;
  }

  // 先解析软链再做归属判断：否则工作区里一个指向外部的链接就能读到任意文件
  let real = abs;
  try {
    real = fs.realpathSync(abs);
  } catch {
    // 文件不存在，后面 stat 会报
  }

  // 工作区按任务隔离（.sandbox/t<id>/<节点>），配置里存的是短名，
  // 所以不能拿 node.workspace 直接 resolve——那样会指到项目根下不存在的目录。
  const roots: string[] = [];
  try { roots.push(fs.realpathSync(path.join(SANDBOX_ROOT, '.sandbox'))); } catch { /* 还没有任务 */ }
  for (const n of cfg.nodes) {
    if (workspaceIsIsolated(n)) continue;
    try { roots.push(fs.realpathSync(path.resolve(n.workspace))); } catch { /* 目录还没建 */ }
  }

  if (!roots.some((root) => inside(root, real))) {
    res.writeHead(403);
    res.end('不在任何节点的工作区内');
    return true;
  }

  try {
    const st = fs.statSync(real);
    if (!st.isFile()) throw new Error('不是文件');
    const ext = path.extname(real).toLowerCase();
    // 产物里可能有模型写的 HTML：给它 CSP sandbox，跑在不透明源里。
    // 确实需要脚本渲染的报表由人显式勾选，勾了也仍是 sandbox，只是允许执行。
    const allowScripts = url.searchParams.get('scripts') === '1';
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'text/plain; charset=utf-8',
      ...previewHeaders(ext, allowScripts),
    });
    res.end(fs.readFileSync(real));
  } catch (e) {
    res.writeHead(404);
    res.end(String(e));
  }
  return true;
}
