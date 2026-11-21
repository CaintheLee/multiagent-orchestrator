import { PROMPTS_DIR } from './paths.ts';
// 职责模板清单：prompts/<role>.md 有哪些，各自是什么。
//
// 为什么要有这个：role 原来是自由字符串，模型写个 auditor 这种不存在的名字，
// 提示词会静默退化成通用兜底（ROLE_FALLBACK），跑出来的活完全没有角色约束，
// 而且没人知道。开线时让人从模板里选，写死的角色才有对应的行为约束。
import fs from 'node:fs';
import path from 'node:path';

export type RoleInfo = {
  id: string;
  /** 标题里的第一段，例如「审计（平级 · 只认事实）」 */
  title: string;
  /** 分组：编排 / 工程 / 内容 … */
  group: string;
  /** 模板头部的 `> 适用：` 一行：这个角色适合干什么活。没写就是空 */
  usage: string;
};

let cache: RoleInfo[] | null = null;

export function listRoles(refresh = false): RoleInfo[] {
  if (cache && !refresh) return cache;
  const dir = PROMPTS_DIR;
  let files: string[] = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.md'));
  } catch {
    cache = [];
    return cache;
  }
  const out: RoleInfo[] = files.map((f) => {
    const id = f.slice(0, -3);
    let head = '';
    try {
      head = fs.readFileSync(path.join(dir, f), 'utf8').split(/\r?\n/).slice(0, 6).join('\n');
    } catch {}
    const title = (/^#\s+(.+)$/m.exec(head)?.[1] || id).trim().slice(0, 80);
    // 分组名取到第一个分隔符为止：有些模板写的是「> 分组：通用附加段 · 这是附加段，正常用法是追加」
    // 整行吃进去会把下拉的分组标题撑成一句话
    const groupRaw = (/^>\s*分组\s*[:：]\s*(.+)$/m.exec(head)?.[1] || '未分组').trim();
    const group = groupRaw.split(/[·，,（(]/)[0].trim().slice(0, 12) || '未分组';
    const usage = (/^>\s*适用\s*[:：]\s*(.+)$/m.exec(head)?.[1] || '').trim().slice(0, 120);
    return { id, title, group, usage };
  });
  out.sort((a, b) => a.group.localeCompare(b.group, 'zh') || a.id.localeCompare(b.id));
  cache = out;
  return cache;
}

/** role 有没有对应的模板文件。没有就别让它静默退化 */
export function roleExists(role: string): boolean {
  return listRoles().some((r) => r.id === role);
}
