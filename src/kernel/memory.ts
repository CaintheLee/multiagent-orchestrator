import { DATA_DIR } from './paths.ts';
// 教训库：从历史打回里提炼出来的「下次别再这样」。
// 由 `learn` 命令生成，派活时注入主控提示词。执行者不读——它只需要照做。
// 项目索引（context.md）也放这里：手写，告诉主控「这个项目现在是什么状态、先读哪几份」。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 记忆目录：默认跟库一起放在 cwd/.data/memory。
// 但 cwd 不是项目根时（比如从别处 node <repo>\src\host\server.ts 启动），
// 三个 load 会静默返回空——表现就是「agent 没有记忆」，而且没有任何报错。
// 所以这里加一层兜底：cwd 下找不到 memory 目录，就退回本文件往上两级的项目根。
const PKG_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function memoryDir(): string {
  const fromCwd = path.join(DATA_DIR, 'memory');
  if (fs.existsSync(fromCwd)) return fromCwd;
  const fromPkg = path.join(PKG_ROOT, '.data', 'memory');
  if (fs.existsSync(fromPkg)) {
    console.error(`记忆目录不在 cwd（${process.cwd()}），改用 ${fromPkg}`);
    return fromPkg;
  }
  return fromCwd;
}

const DIR = memoryDir();
const FILE = path.join(DIR, 'lessons.md');
const CONTEXT = path.join(DIR, 'context.md');
const MAX_INJECT = 900;
/** 项目索引比教训长，注入上限放宽一些，但也别把提示词撑爆。
 *  2600 是量出来的：写到「禁忌」正好 2481，2400 会把最后两条约束切掉——
 *  截断位置落在哪比总长度更危险，宁可多给 200 字。 */
const MAX_CONTEXT = 2600;

export function loadLessons(): string {
  try {
    const text = fs.readFileSync(FILE, 'utf8').trim();
    if (!text) return '';
    return text.length > MAX_INJECT ? text.slice(0, MAX_INJECT) + '\n…（更长的略）' : text;
  } catch {
    return '';
  }
}

/** 项目索引：没有这个文件就返回空，主控按「不知道项目背景」的方式干活 */
export function loadContext(): string {
  try {
    const text = fs.readFileSync(CONTEXT, 'utf8').trim();
    if (!text) return '';
    return text.length > MAX_CONTEXT ? text.slice(0, MAX_CONTEXT) + '\n…（更长的略）' : text;
  } catch {
    return '';
  }
}

export function contextFile(): string {
  return CONTEXT;
}

export function saveLessons(text: string): void {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, text.trim() + '\n', 'utf8');
  fs.renameSync(tmp, FILE);
}

export function lessonsFile(): string {
  return FILE;
}

/* ---------- 任务流水：这个项目最近做过什么 ---------- */

const JOURNAL = path.join(DIR, 'journal.md');
/** 只留最近这么多条：它是"别重复劳动"的提示，不是完整档案 */
const JOURNAL_KEEP = 40;
const MAX_JOURNAL_INJECT = 800;

/**
 * 任务进终态时记一笔。纯拼接已有事实，不调模型，成本为零。
 * 目的只有一个：下次主控派活前能看到「这些活最近做过」，避免重复劳动。
 */
export function appendJournal(line: string): void {
  try {
    fs.mkdirSync(path.dirname(JOURNAL), { recursive: true });
    const old = fs.existsSync(JOURNAL)
      ? fs.readFileSync(JOURNAL, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean)
      : [];
    old.push('- ' + line.replace(/\s+/g, ' ').trim());
    fs.writeFileSync(JOURNAL, old.slice(-JOURNAL_KEEP).join('\n') + '\n', 'utf8');
  } catch {
    // 流水写不进去不能影响任务本身
  }
}

export function loadJournal(limit = 15): string {
  try {
    const lines = fs.readFileSync(JOURNAL, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean);
    const text = lines.slice(-limit).join('\n');
    return text.length > MAX_JOURNAL_INJECT ? text.slice(-MAX_JOURNAL_INJECT) : text;
  } catch {
    return '';
  }
}

/* ---------- 对话记忆：agent 自己记「我们聊过什么」 ---------- */

const TALK = path.join(DIR, 'talk.md');
/** 留多少条对话摘要。一条约 120–160 字，60 条 ≈ 9 KB，够回溯两周的零散对话 */
const TALK_KEEP = 60;
const MAX_TALK_INJECT = 1000;

/**
 * 追加一条对话记忆。
 *
 * 和 journal 的区别：journal 记「任务做了什么」，talk 记「人跟 agent 聊了什么、
 * 决定了什么」。session 一断，后者是唯一能把话接上的东西。
 */
export function appendTalk(line: string): void {
  try {
    fs.mkdirSync(path.dirname(TALK), { recursive: true });
    const old = fs.existsSync(TALK)
      ? fs.readFileSync(TALK, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean)
      : [];
    old.push('- ' + line.replace(/\s+/g, ' ').trim());
    fs.writeFileSync(TALK, old.slice(-TALK_KEEP).join('\n') + '\n', 'utf8');
  } catch {
    // 记忆写不进去不能影响对话本身
  }
}

export function loadTalk(limit = 12): string {
  try {
    const lines = fs.readFileSync(TALK, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean);
    const text = lines.slice(-limit).join('\n');
    return text.length > MAX_TALK_INJECT ? text.slice(-MAX_TALK_INJECT) : text;
  } catch {
    return '';
  }
}

export function talkFile(): string {
  return TALK;
}
