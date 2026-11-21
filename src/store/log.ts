import { DATA_DIR } from '../kernel/paths.ts';
// 私账：每轮模型说的全部原文，只给人排查用，永远不喂给模型。
// 和公账（runs/<id>.json）分开，公账小、私账大。
import fs from 'node:fs';
import path from 'node:path';

// 与 db 同源，统一在 kernel/paths.ts
const DIR = path.join(DATA_DIR, 'logs');
const MAX = 2 * 1024 * 1024;

function fileOf(id: number): string {
  return path.join(DIR, String(id).padStart(4, '0') + '.log');
}

/** 私账路径。db 的 runs.log_path 记同一个地址 */
export function logPath(id: number): string {
  return fileOf(id);
}

export function saveLog(id: number, text: string): void {
  fs.mkdirSync(DIR, { recursive: true });
  const body = text.length > MAX
    ? text.slice(0, MAX) + `\n\n…（原文 ${text.length} 字符，超过 2MB 已截断）`
    : text;
  fs.writeFileSync(fileOf(id), body, 'utf8');
}

export function readLog(id: number): string | null {
  try {
    return fs.readFileSync(fileOf(id), 'utf8');
  } catch {
    return null;
  }
}

export function hasLog(id: number): boolean {
  return fs.existsSync(fileOf(id));
}
