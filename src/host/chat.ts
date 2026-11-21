// 对话模式：把 CLI 的 stream-json 转成 SSE，前端边收边显示。
//
// 和任务模式的差别：
// - 任务 = 派活 → 收口 → 落库，有回执、有验收；对话就是聊天，不验产物、不写轮次
// - 任务每轮一个短进程、上下文靠提示词拼；对话靠 CLI 自己的 session 续接
// 两者共用节点配置（模型）和项目目录，互不干扰。
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { ServerResponse } from 'node:http';
import { providerOf } from '../adapters/table.ts';
import { appendTalk, loadContext, loadJournal, loadLessons, loadTalk } from '../kernel/memory.ts';
import { DATA_DIR } from '../kernel/paths.ts';

const DATA = DATA_DIR;
const CHAT_DIR = path.join(DATA, 'chat');
/** 单轮对话上限：卡在工具循环里时不能无限占着节点 */
const CHAT_TIMEOUT_MS = 5 * 60_000;
/** 历史回放上限：只取最近这么多条。文件只追加，聊久了会有几千条，
 *  每次切节点全量 JSON.parse 会让界面越来越顿 */
const HISTORY_KEEP = 400;
/** 只读文件尾部这么多字节：大约覆盖 600 条消息，够 HISTORY_KEEP 用 */
const HISTORY_TAIL_BYTES = 256 * 1024;

export type ChatEvent =
  | { t: 'start'; sessionId: string }
  | { t: 'thinking'; text: string }
  | { t: 'text'; text: string }
  | { t: 'tool'; name: string }
  | { t: 'usage'; input: number; output: number; ms: number }
  | { t: 'plan'; plan: ChatPlan; text: string }
  | { t: 'done'; text: string; ms: number }
  | { t: 'error'; error: string };

/** 任务方案：对话里生成、人点确认才派给主控 */
export type ChatPlan = {
  goal: string;
  detail: string;
  steps: string[];
  risks: string[];
};

type Msg = { role: 'user' | 'assistant'; text: string; ts: number; ms?: number; plan?: ChatPlan };

/** 每个节点的订阅者。一个节点同时只允许一个对话进程，但可以开多个页面看 */
const subs = new Map<string, Set<ServerResponse>>();
/** 正在跑的对话进程：同一个节点不许并发，否则 session 会串 */
const live = new Map<string, ChildProcess>();
/** 最近一段对话的流式内容，SSE 晚订阅时补发 */
const recent = new Map<string, ChatEvent[]>();

function ensureDir(): void {
  fs.mkdirSync(CHAT_DIR, { recursive: true });
}

function histFile(nodeId: string): string {
  return path.join(CHAT_DIR, `${nodeId}.jsonl`);
}

function sidFile(nodeId: string): string {
  return path.join(CHAT_DIR, `${nodeId}.sid`);
}

export function chatHistory(nodeId: string): Msg[] {
  try {
    const file = histFile(nodeId);
    const st = fs.statSync(file);
    // 只读文件尾部：聊天记录是只追加的，聊上几个月会有几 MB，
    // 每次切节点都全量读 + 全量 split，界面会越来越顿（外部审计 m1）
    const start = Math.max(0, st.size - HISTORY_TAIL_BYTES);
    const len = st.size - start;
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(file, 'r');
    try {
      fs.readSync(fd, buf, 0, len, start);
    } finally {
      fs.closeSync(fd);
    }
    let text = buf.toString('utf8');
    // 从字节中间切开时第一行是半截：丢掉，否则 JSON.parse 必失败
    if (start > 0) {
      const nl = text.indexOf('\n');
      text = nl >= 0 ? text.slice(nl + 1) : '';
    }
    const lines = text
      .split(/\r?\n/)
      .filter(Boolean)
      // 只回最近 400 条，和界面需要的量对齐
      .slice(-HISTORY_KEEP);
    return lines
      .map((l) => {
        try { return JSON.parse(l) as Msg; } catch { return null; }
      })
      .filter((m): m is Msg => !!m && !!m.text);
  } catch {
    return [];
  }
}

function appendHistory(nodeId: string, m: Msg): void {
  ensureDir();
  fs.appendFileSync(histFile(nodeId), JSON.stringify(m) + '\n', 'utf8');
}

/** 清空对话：连 session 一起重置，下一句会开新会话 */
export function resetChat(nodeId: string): void {
  try { fs.unlinkSync(histFile(nodeId)); } catch {}
  try { fs.unlinkSync(sidFile(nodeId)); } catch {}
  recent.delete(nodeId);
}

function readSid(nodeId: string): string {
  try {
    return fs.readFileSync(sidFile(nodeId), 'utf8').trim();
  } catch {
    return '';
  }
}

function writeSid(nodeId: string, sid: string): void {
  ensureDir();
  fs.writeFileSync(sidFile(nodeId), sid, 'utf8');
}

function broadcast(nodeId: string, ev: ChatEvent): void {
  const list = recent.get(nodeId) ?? [];
  list.push(ev);
  // 只留最近 500 条：补发是为了接上正在打的那段，不是完整历史
  if (list.length > 500) list.splice(0, list.length - 500);
  recent.set(nodeId, list);
  for (const res of subs.get(nodeId) ?? []) {
    try { res.write(sse(ev)); } catch {}
  }
}

function sse(ev: ChatEvent): string {
  return `data: ${JSON.stringify(ev)}\n\n`;
}

export function subscribe(nodeId: string, res: ServerResponse): () => void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
  });
  res.write(': connected\n\n');
  // 把正在进行的这一段补发，晚打开页面也能看到已经打了什么
  for (const ev of recent.get(nodeId) ?? []) res.write(sse(ev));
  let set = subs.get(nodeId);
  if (!set) {
    set = new Set();
    subs.set(nodeId, set);
  }
  set.add(res);
  const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 15_000);
  return () => {
    clearInterval(ping);
    const set = subs.get(nodeId);
    if (!set) return;
    set.delete(res);
    // 空了就把这个 key 也删掉：前端传个不存在的节点名会永久留一个空 Set
    if (!set.size) subs.delete(nodeId);
  };
}

export function isBusy(nodeId: string): boolean {
  return live.has(nodeId);
}

/** 正在对话的节点列表：界面据此点亮对应的 agent 格子 */
export function busyNodes(): string[] {
  return [...live.keys()];
}

/**
 * 会话断档的兜底：把最近几条对话摘成一段，塞进新的系统提示。
 * 只取最近 6 条、每条 220 字——目的是「接得上话」，不是复述全部历史。
 */
function buildRecap(hist: Msg[]): string {
  const tail = hist.slice(-6);
  if (!tail.length) return '';
  const lines = tail.map((m) => {
    const who = m.role === 'user' ? '负责人' : '你';
    return `${who}：${String(m.text || '').replace(/\s+/g, ' ').slice(0, 220)}`;
  });
  return '\n\n【这个节点之前聊过（会话已重置，模型本身不记得，下面是最近几条）】\n'
    + lines.join('\n')
    + '\n\n用户要是说「接着刚才」「继续上面那个」，指的就是这些。拿不准就问一句，别猜。';
}

/**
 * 对话的系统提示 = 角色约定 + 项目记忆 + 任务快照。
 *
 * 之前只拼了角色约定和快照，漏掉三份记忆文件——所以对话里问项目，它只能现读磁盘，
 * 相当于每次都是新来的。任务模式一直有这三份（见 kernel/prompt 的注入），对话漏了。
 */
function buildChatSystem(taskSnapshot?: string, project?: { name: string; root: string }): string {
  // 项目名与根目录来自 agents.toml 的 [project]，不是写死的——
  // 这套东西要能换个项目直接用（MultiAgent 是通用编排器）
  const name = project?.name || '本项目';
  const root = project?.root || '';
  const head = CHAT_PROMPT
    .replace(/\{\{PROJECT\}\}/g, name)
    .replace(/\{\{ROOT\}\}/g, root || '项目目录');
  const parts: string[] = [head];
  if (root) parts.push('\n\n【项目根】' + root + '（所有相对路径以此为基准）');
  const ctx = loadContext();
  if (ctx) parts.push('\n\n【项目记忆索引】\n' + ctx);
  const lessons = loadLessons();
  if (lessons) parts.push('\n\n【历史教训（这些坑踩过，别再踩）】\n' + lessons);
  // 对话记忆放在任务流水前面：它更接近「你和我」的关系，优先于「项目干过什么」
  const talk = loadTalk(12);
  if (talk) parts.push('\n\n【我们之前聊过的（你自己的记忆，最近 12 条）】\n' + talk);
  const journal = loadJournal(10);
  if (journal) parts.push('\n\n【最近做过的任务（流水，不是当前状态）】\n' + journal);
  if (taskSnapshot) parts.push('\n\n【当前任务快照（来自 hub，实时）】\n' + taskSnapshot);
  return parts.join('');
}

/** 一条对话记忆：谁、问了什么、答了什么要点 */
function talkLine(nodeId: string, ask: string, answer: string, memos: string[]): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const q = String(ask || '').replace(/\s+/g, ' ').slice(0, 60);
  const a = String(answer || '').replace(/\s+/g, ' ').slice(0, 100);
  const tail = memos.length ? ' ｜ 记：' + memos.join(' / ').slice(0, 120) : '';
  return `${stamp} [${nodeId}] 问：${q} → 答：${a}${tail}`;
}

/**
 * 从回答里抠出 MEMO 行。用户说「记住这个」时，agent 写 `MEMO: xxx`，
 * 我们把它单独存进对话记忆——这是它自己决定「什么值得记」的入口。
 * 正文里保留不动：让人看得见它到底记了什么，别偷偷记。
 */
export function extractMemos(text: string): { memos: string[]; clean: string } {
  const memos: string[] = [];
  const clean = (text || '').replace(/^.*MEMO[:：]\s*(.+)$/gm, (full, m: string) => {
    const v = String(m).trim();
    if (v) memos.push(v.slice(0, 160));
    return full;
  });
  return { memos: memos.slice(0, 5), clean };
}

/**
 * 对话的角色约定。
 *
 * 为什么让它出「方案块」：人用自然语言说「清点资产」，直接开跑风险太大——
 * 范围、交付物、验收口径都没定。先让它把方案摊开给人看，人点确认才派。
 * 追问/修改时重新出完整方案（不是 diff），前端才能整块替换。
 */
const CHAT_PROMPT = [
  '你是「{{PROJECT}}」项目的助手，正在跟项目负责人对话。项目记忆已注入上下文。',
  '',
  '【你怎么知道任务进展】',
  '系统提示末尾会附一份「当前任务快照」，那是 hub 里真实的最近任务（id / 状态 / 轮数 / 耗时 / 失败原因）。',
  '问「现在什么情况」「那个任务怎么样了」，只看这份快照。',
  '不要拿 DELIVERY.md、记忆档案、你自己的待办列表当任务状态——那些是项目档案，不是任务进度。',
  '快照里没有的，就直说「hub 里没有这个任务」。',
  '',
  '【什么时候出任务方案】',
  '当用户在描述一件要动手做的事（清点、审计、修复、生成、重构、迁移等），而不是单纯问问题时，',
  '在回答末尾输出一个方案块，格式严格如下：',
  '',
  '```ma-plan',
  '{',
  '  "goal": "一句话目标，不超过 40 字",',
  '  "detail": "可以直接派给主控执行的详细要求：范围、约束、交付物、验收口径",',
  '  "steps": ["第一步", "第二步"],',
  '  "risks": ["可能踩的坑；没有就写空数组"]',
  '}',
  '```',
  '',
  '规则：',
  '- 一个回答最多一个方案块，放在最后。',
  '- detail 必须能独立执行，不要写「如上所述」「按刚才说的」。',
  '- 用户追问或改需求时，重新输出完整方案块，不要只给差异。',
  '- 纯问答（问进度、问原因、闲聊）不要输出方案块。',
  '- 信息不足时先反问关键点，不要猜着出方案。',
  '- 方案里不要承诺工期，可以说预估轮次。',
  '',
  '【你可以记东西】',
  '用户说「记住」「以后都这样」「别忘」这类话，或者出现一个以后会反复用到的约定时，',
  '在回答末尾单独一行写：MEMO: 要记的一句话（别写长，一句说清）',
  '我会把它写进长期对话记忆，下次开新会话也看得到。一次最多一条，没重要的事就别写。',
  '',
  '【这一段对话不是执行，是定方案】',
  '- 不要创建任务清单/todo（TaskCreate/TaskUpdate），也不要给自己排步骤去过',
  '- **不要自己派子 agent 干活**。要动手就把方案交出来，由人点「派发」交给 hub 的主控——',
  '  只有走 hub 的派活才会产生轮次、落库、被人看见；你自己拉起来的活干完了也没人知道',
  '- 不要实际动手改文件、不要跑长命令、不要遍历整个仓库',
  '- 为了把方案写准，最多读 3–5 个关键文件确认现状；没读到的就写清你假设了什么',
  '- 你的产出是「方案」，不是「结果」。执行是主控和五条线的事',
  '',
  '【你的权限】',
  '你可以读写 {{ROOT}}。但对话阶段以「看清楚、说清楚」为主，除非用户明确要求，不要擅自大改文件。',
  '真要动文件，先说清动哪几个、为什么。',
].join('\n');

export function stopChat(nodeId: string, silent = false): boolean {
  const p = live.get(nodeId);
  if (!p) return false;
  try {
    if (process.platform === 'win32' && p.pid) {
      // 整棵树一起杀：CLI 会拉子进程，只杀父进程会留孤儿
      spawn('taskkill', ['/PID', String(p.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      p.kill('SIGTERM');
    }
  } catch {}
  live.delete(nodeId);
  if (!silent) broadcast(nodeId, { t: 'error', error: '已手动停止' });
  return true;
}

/**
 * 从回答里抠出任务方案块。
 *
 * 刻意宽松：JSON 写坏了就返回 null，当作普通聊天——一个方案块格式不对，
 * 不该让整条回答变成错误。goal/detail 是必需的，缺任何一个都不认。
 */
export function parsePlan(text: string): ChatPlan | null {
  const m = /```ma-plan\s*\n([\s\S]*?)```/.exec(text || '');
  if (!m) return null;
  try {
    const j = JSON.parse(m[1].trim()) as Record<string, unknown>;
    const goal = typeof j.goal === 'string' ? j.goal.trim() : '';
    const detail = typeof j.detail === 'string' ? j.detail.trim() : '';
    if (!goal || !detail) return null;
    const arr = (v: unknown) =>
      Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean).slice(0, 12) : [];
    return {
      goal: goal.slice(0, 200),
      detail: detail.slice(0, 8000),
      steps: arr(j.steps),
      risks: arr(j.risks),
    };
  } catch {
    return null;
  }
}

/** 去掉方案块，只留给人看的话 */
export function stripPlan(text: string): string {
  return (text || '').replace(/```ma-plan[\s\S]*?```/g, '').trim();
}

export type ChatInput = {
  nodeId: string;
  text: string;
  model: string;
  cwd: string;
  plugin?: string;
  /** 当前任务快照（最近若干条），拼进系统提示——对话 agent 看不到 hub 的任务库 */
  taskSnapshot?: string;
  /** 项目名与根目录，来自 agents.toml 的 [project] */
  projectName?: string;
  projectRoot?: string;
};

/**
 * 起一轮对话。函数立即返回，内容通过 SSE 推。
 *
 * 为什么用 `--resume` 而不是每轮带上完整历史：CLI 的会话记录里有工具调用、
 * 文件读取这些上下文，自己拼一份纯文本历史会丢掉它们，回答质量会掉一截。
 */
export function startChat(inp: ChatInput): { ok: boolean; error?: string } {
  if (live.has(inp.nodeId)) return { ok: false, error: '这个节点上一句还没答完' };

  const key = inp.plugin || 'codebuddy';
  // 对话靠 CLI 的 session 续接，目前只有 codebuddy 这条路验证过；
  // 别的 provider 硬上会静默丢上下文，不如直接说清楚
  if (key !== 'codebuddy') {
    return { ok: false, error: `对话模式目前只支持 codebuddy（这个节点用的是 ${key}）` };
  }
  let provider;
  try {
    provider = providerOf(key);
  } catch (e) {
    return { ok: false, error: String((e as Error).message ?? e) };
  }

  const oldSid = readSid(inp.nodeId);
  const sid = oldSid || `ma2-${inp.nodeId}-${Date.now().toString(36)}`;
  writeSid(inp.nodeId, sid);
  // 会话断了、但界面上还挂着历史时，把最近几条带上。
  // 不带的话：页面显示「我们聊过」，模型却是全新会话，两边的认知对不上——
  // 换 session 前缀、手动清 session、CLI 会话过期都会走到这里。
  const recap = oldSid ? '' : buildRecap(chatHistory(inp.nodeId));

  const args = [
    '-p', inp.text,
    '--output-format', 'stream-json',
    '--session-id', sid,
    '--append-system-prompt', buildChatSystem(inp.taskSnapshot, { name: inp.projectName || '', root: inp.projectRoot || '' }) + recap,
    // 只给读、搜、改、跑命令这几类。不给 Task*：给了它就会把「出方案」变成
    // 「给自己排 todo 然后一条条执行」，实测能空转好几分钟还不出方案。
    '--tools', 'Read,Glob,Grep,Bash,AskUserQuestion',
    // 只读计划模式：对话是「定方案」，不是「执行」。
    // 之前没这个限制，问一句「任务进度如何」，它自己拉起子 agent 跑了 512 秒去审计。
    '--permission-mode', 'plan',
  ];
  if (inp.model) args.push('--model', inp.model);

  recent.set(inp.nodeId, []);
  broadcast(inp.nodeId, { t: 'start', sessionId: sid });
  appendHistory(inp.nodeId, { role: 'user', text: inp.text, ts: Date.now() });

  const started = Date.now();
  let child: ChildProcess;
  try {
    // 必须用 node 去执行那个 bin：它在 Windows 上没有扩展名，直接 spawn 会 ENOENT。
    // 任务模式（adapters/spawn.ts）也是这么起的，别改成直接 spawn。
    child = spawn(process.execPath, [provider.bin(), ...args], {
      cwd: inp.cwd,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
  } catch (e) {
    const msg = String((e as Error).message ?? e);
    broadcast(inp.nodeId, { t: 'error', error: msg });
    return { ok: false, error: '起不来进程：' + msg };
  }
  live.set(inp.nodeId, child);

  // 兜底超时：没有它，一个卡在工具循环里的对话会一直占着节点，
  // 界面上那个格子永远亮着，人只能重启 hub
  const guard = setTimeout(() => {
    if (live.get(inp.nodeId) === child){
      broadcast(inp.nodeId, { t: 'error', error: `超过 ${CHAT_TIMEOUT_MS / 60_000} 分钟没答完，已停止` });
      appendHistory(inp.nodeId, { role: 'assistant', text: `⚠ 超过 ${CHAT_TIMEOUT_MS / 60_000} 分钟没答完，已停止`, ts: Date.now() });
      stopChat(inp.nodeId, true);
    }
  }, CHAT_TIMEOUT_MS);
  child.on('close', () => clearTimeout(guard));

  let buf = '';
  let said = '';
  let errText = '';

  const handle = (line: string) => {
    const s = line.trim();
    if (!s) return;
    let j: Record<string, unknown>;
    try { j = JSON.parse(s) as Record<string, unknown>; } catch { return; }
    const type = String(j.type || '');
    if (type === 'assistant') {
      const msg = j.message as { content?: Array<Record<string, unknown>> } | undefined;
      for (const c of msg?.content ?? []) {
        const ctype = String(c.type || '');
        if (ctype === 'text' && typeof c.text === 'string') {
          said += c.text;
          broadcast(inp.nodeId, { t: 'text', text: c.text });
        } else if (ctype === 'thinking' && typeof c.thinking === 'string') {
          broadcast(inp.nodeId, { t: 'thinking', text: c.thinking });
        } else if (ctype === 'tool_use' && typeof c.name === 'string') {
          broadcast(inp.nodeId, { t: 'tool', name: c.name });
        }
      }
      return;
    }
    if (type === 'result') {
      const usage = j.usage as { input_tokens?: number; output_tokens?: number } | undefined;
      const ms = Number(j.duration_ms || Date.now() - started);
      const finalText = typeof j.result === 'string' && j.result ? j.result : said;
      if (j.is_error) {
        broadcast(inp.nodeId, { t: 'error', error: String(finalText || '执行失败') });
      } else {
        if (!said && finalText) {
          said = finalText;
          broadcast(inp.nodeId, { t: 'text', text: finalText });
        }
        // 方案块：给前端一张可确认的卡片，正文里不留那段 JSON
        const plan = parsePlan(finalText);
        const clean = stripPlan(finalText);
        const shown = clean || (plan ? '已生成任务方案，确认后可以派发。' : finalText);
        if (plan) {
          broadcast(inp.nodeId, { t: 'plan', plan, text: shown });
        } else if (clean && clean !== finalText) {
          // 块坏了但被剥掉了：至少把干净文本补齐
          broadcast(inp.nodeId, { t: 'text', text: '\n' + clean });
        }
        broadcast(inp.nodeId, {
          t: 'usage',
          input: Number(usage?.input_tokens || 0),
          output: Number(usage?.output_tokens || 0),
          ms,
        });
        broadcast(inp.nodeId, { t: 'done', text: shown, ms });
        appendHistory(inp.nodeId, {
          role: 'assistant',
          text: shown,
          ts: Date.now(),
          ms,
          plan: plan ?? undefined,
        });
        // 对话记忆：一条摘要 + 它自己标 MEMO 的要点。
        // 纯字符串处理，不额外调模型——每轮都记的成本必须为零，否则没人敢用。
        const { memos } = extractMemos(finalText);
        appendTalk(talkLine(inp.nodeId, inp.text, shown, memos));
      }
    }
  };

  child.stdout?.on('data', (d: Buffer) => {    buf += d.toString('utf8');
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      handle(line);
    }
  });
  child.stderr?.on('data', (d: Buffer) => {
    errText += d.toString('utf8');
    if (errText.length > 4000) errText = errText.slice(-4000);
  });

  child.on('error', (e) => {
    live.delete(inp.nodeId);
    const msg = String(e.message ?? e);
    broadcast(inp.nodeId, { t: 'error', error: msg });
    // 失败也要落进历史：否则刷新页面就看不到「刚才为什么没回」
    appendHistory(inp.nodeId, { role: 'assistant', text: '⚠ ' + msg, ts: Date.now() });
  });

  child.on('close', (code) => {
    live.delete(inp.nodeId);
    // 有 result 时已经发过 done；这里只处理「没说 done 就退出」的异常收场
    const list = recent.get(inp.nodeId) ?? [];
    const closed = list.some((e) => e.t === 'done' || e.t === 'error');
    if (!closed) {
      const tail = errText.trim().split(/\r?\n/).filter(Boolean).slice(-3).join(' / ');
      const msg = `对话进程退出（code=${code}）${tail ? '：' + tail : ''}`;
      broadcast(inp.nodeId, { t: 'error', error: msg });
      appendHistory(inp.nodeId, { role: 'assistant', text: '⚠ ' + msg, ts: Date.now() });
    }
  });

  return { ok: true };
}
