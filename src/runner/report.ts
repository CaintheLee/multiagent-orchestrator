// 收口简报：把下级这一轮的交付整理成「上级能直接读」的一段文本。
//
// 单独放一处的理由：它要读磁盘（把小的文本产物直接带上来），
// 和路由那种纯算术不是一类东西；混在 runTree 里既不好测也不好读。
import fs from 'node:fs';
import type { NodeConfig } from '../kernel/tree.ts';
import type { RunRecord } from '../store/runs.ts';

/** 超过这个大小的产物不再内联，避免一份日志/数据文件把提示词撑爆 */
const INLINE_MAX_BYTES = 6000;
/** 内联进简报的字符上限 */
const INLINE_MAX_CHARS = 1200;

export function reportText(kr: RunRecord, kid: NodeConfig): string {
  const lines = [`### ${kid.id}（${kid.name}）· ${kr.state.toUpperCase()} · ${(kr.ms / 1000).toFixed(1)}s`];
  lines.push(`- 它说：${kr.summary || kr.error || '（没说）'}`);
  for (const a of kr.artifacts) {
    lines.push(`- 产物：${a.path}（${a.bytes} 字节）`);
    // 小文本文件直接把内容带上来：上级经常懒得打开文件，只凭摘要就判合格
    if (a.bytes <= INLINE_MAX_BYTES && /\.(txt|md|json|html|svg|csv|log)$/i.test(a.path)) {
      try {
        const text = fs.readFileSync(a.path, 'utf8');
        lines.push('  实际内容是：');
        lines.push('  ' + text.replace(/\n/g, '\n  ').slice(0, INLINE_MAX_CHARS));
      } catch {
        lines.push('  （读不到内容）');
      }
    }
  }
  for (const t of kr.tell ?? []) lines.push(`- 它给 ${t.to} 留了话：${t.msg}`);
  // 点名提问优先展示：上级在长报告里最容易漏掉的就是这一行
  for (const a of kr.ask ?? []) lines.push(`- **它在问 ${a.to}：${a.question}**`);
  if (kr.question) lines.push(`- 它提问：${kr.question}`);
  for (const w of kr.warnings) lines.push(`- 提示：${w}`);
  return lines.join('\n');
}
