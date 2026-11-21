// 交付清单落地检查：任务原文点了名的产物，收口时必须真的在盘上。
//
// 为什么要有这一条（2026-11-18 事故）：#45 的任务原文写着「━━━ 交付清单 ━━━」六项，
// 主控只跑完第一段就写了 dispatch []，收口轮判 pass，任务终态 done——
// 而六项产物一个都没落盘。判定当时只看「有没有派活」和「证据能不能搜到」，
// 没有任何一处去问「任务点名的文件到底在不在」。
//
// 只认任务里显式写出来的绝对路径（`D:\...` / `D:/...`），不做模糊猜测：
// 这是唯一能从任务原文机械核对的交付事实，猜错会误伤，所以宁可不猜。

import fs from 'node:fs';

/** 交付清单段落里能认出的绝对路径 */
const WIN_PATH = /[A-Za-z]:[\\/][^\s"'`，。；、）)|*?<>]*/g;

/** 段落的结束标志：下一个大标题、下一个粗体小标题、或空行 */
function isSectionEnd(line: string): boolean {
  const s = line.trim();
  return !s || s.startsWith('━━') || s.startsWith('#') || s.startsWith('【') || s.startsWith('##');
}

/**
 * 从任务原文里抠出「交付清单」段落列出的路径。
 *
 * 只认带「交付清单」字样的那一行作为段首，往后读到段落结束。
 * 没有这一段就返回空数组——不是所有任务都有清单，不能凭空要求它。
 */
export function listedDeliverables(task: string): string[] {
  if (!task) return [];
  const lines = task.split(/\r?\n/);
  const start = lines.findIndex((l) => l.includes('交付清单'));
  if (start < 0) return [];
  const out: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (isSectionEnd(line)) break;
    for (const m of line.match(WIN_PATH) ?? []) {
      // 去掉行尾可能粘上的半角标点，路径本身不会以这些结尾
      const p = m.replace(/[.,;:!?]+$/, '');
      if (p && !out.includes(p)) out.push(p);
    }
  }
  return out;
}

/**
 * 清单里还没落盘的那些。
 *
 * 目录也算落地（`fs.existsSync` 对目录为 true）：隔离区这种交付物本来就是目录。
 */
export function missingDeliverables(task: string): string[] {
  return listedDeliverables(task).filter((p) => {
    try {
      return !fs.existsSync(p);
    } catch {
      return true;
    }
  });
}
