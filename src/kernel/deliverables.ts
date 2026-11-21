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

/** 裸路径：不含空白与常见中文标点。带空格的路径要靠引号包裹才能认出来 */
const BARE_PATH = /[A-Za-z]:[\\/][^\s"'`，。；、）)|*?<>]*/g;
/** 引号/反引号包裹的路径：允许空格，覆盖「D:\My Docs\report.md」这种 */
const QUOTED_PATH = /[`"']([A-Za-z]:[\\/][^`"']+)[`"']/g;
/** 行首序号：`1.` `1)` `1、` `【1】` `-` `*` `·` */
const BULLET = /^(?:[-*·]|【\d+】|\d+[.)、])\s*/;

/**
 * 段落是否到此结束。
 *
 * 空行**不算**结束：markdown 里清单项之间常夹空行，一遇空行就停会漏掉后半截
 * （实测：六项清单中间空一行，只认出前两项，剩下四项永远不检查）。
 */
function isHardEnd(line: string): boolean {
  const s = line.trim();
  if (!s) return false;
  // 大标题 / 粗体小标题 / 分隔线：这是下一个段落
  if (s.startsWith('━━') || s.startsWith('#') || s.startsWith('---')) return true;
  // 「【说明】」是段落标记，但「【1】」是列表序号——前者结束，后者继续
  if (s.startsWith('【') && !/^【\d+】/.test(s)) return true;
  return false;
}

/** 这一行像不像清单项：有路径，或者有序号/项目符号 */
function looksLikeItem(line: string): boolean {
  const s = line.trim();
  if (!s) return false;
  if (/[A-Za-z]:[\\/]/.test(s)) return true;
  return BULLET.test(s);
}

/** 从一行里抠出路径。引号包裹的优先，再补裸路径（去重） */
function pathsIn(line: string): string[] {
  const body = line.trim().replace(BULLET, '');
  const out: string[] = [];
  for (const m of body.matchAll(QUOTED_PATH)) {
    const p = m[1].trim().replace(/[.,;:!?]+$/, '');
    if (p) out.push(p);
  }
  for (const m of body.match(BARE_PATH) ?? []) {
    const p = m.replace(/[.,;:!?]+$/, '');
    if (!p) continue;
    // 引号路径被裸匹配又截了一次（`D:\My Docs\x.md` → `D:\My`）：
    // 是已识别路径的前缀就丢掉，否则会多出一个永远不存在的「交付物」
    if (out.some((q) => q.startsWith(p))) continue;
    if (!out.includes(p)) out.push(p);
  }
  return out;
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
    if (isHardEnd(line)) break;
    if (!line.trim()) continue;
    // 既不是路径也不是列表项：一段说明文字，清单到此为止。
    // 不加这条会把后面正文里提到的其它路径也算成交付物，造成误判。
    if (!looksLikeItem(line)) break;
    for (const p of pathsIn(line)) {
      if (!out.includes(p)) out.push(p);
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
