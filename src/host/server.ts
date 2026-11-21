// 本地服务：一个页面 + 一条 SSE 日志流。双击 start.cmd 就能用。
import http from 'node:http';
import os from 'node:os';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, nodeById, workspaceIsIsolated, MAX_NODES } from '../kernel/tree.ts';
import { loadRuns } from '../store/runs.ts';
import { readLog, hasLog } from '../store/log.ts';
import { openDB, importLegacyRuns, createTask, setTaskState } from '../store/db.ts';
import { decideApproval, expirePending, getApproval, listApprovals } from '../store/approvals.ts';
import { listMessages } from '../store/messages.ts';
import { listCheckpoints } from '../store/checkpoints.ts';
import { readRunJson } from '../store/run-cache.ts';
import { takeSnapshot } from '../kernel/snapshot.ts';
import { buildResumeBrief, RESUME_MAX } from '../protocol/resume.ts';
import { inside } from '../kernel/settle.ts';
import { PROVIDERS, providerNames, registerProvidersFrom, supportsReadOnly } from '../adapters/table.ts';
import { getModels, peekModels, refreshModels } from '../adapters/models.ts';
import { listRoles } from '../kernel/roles.ts';
import { CONFIG_FILE, DATA_DIR, PROMPTS_DIR, PROVIDERS_FILE, SANDBOX_ROOT, UI_FILE } from '../kernel/paths.ts';
import { ConfigError, mutateConfig } from '../kernel/config-lock.ts';
import {
  authRequired,
  isLoopbackAddr,
  loadOrCreateToken,
  tokenCookie,
  tokenFromRequest,
  tokenMatches,
  unauthPage,
} from '../kernel/auth.ts';
import { previewHeaders } from '../kernel/preview.ts';
import { busyNodes, chatHistory, isBusy, resetChat, startChat, stopChat, subscribe } from './chat.ts';
import { loadLessons } from '../kernel/memory.ts';
import { Scheduler } from '../hub/scheduler.ts';
import { LogBus } from '../hub/logbus.ts';
import { Semaphore } from '../kernel/pool.ts';
import type { DatabaseSync } from 'node:sqlite';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const UI = UI_FILE;
const CFG = CONFIG_FILE;
/** 对话单条上限：聊天不用写长文，太长会挤掉会话里的有效上下文 */
const CHAT_MAX = 4000;
/** 对话节点 id 的合法格式。它会被拼进 .data/chat/<id>.jsonl，
 *  必须挡住 `../` 和路径分隔符，否则能删/读聊天目录外的文件（审计 M2） */
const CHAT_NODE_RE = /^[A-Za-z0-9_-]{1,32}$/;

/**
 * 对话用的任务快照。
 *
 * 为什么必须注入：对话 agent 站在 D:/YourProject 里，看不到 hub 的任务库。
 * 实测问「现在任务什么情况」，它答「任务列表是空的」——当时 hub 里躺着 #41–#45。
 * 它说的是自己的待办列表，不是这里的任务。
 *
 * 两个口径细节：
 * - 耗时用 started_at 起算，不是 created_at：排队时间不算它跑了多久。
 * - 任务名优先取最近一条轮次摘要，取不到才退回任务正文开头——
 *   正文开头往往是「【你的身份】你是某个项目的主控…」这种通用提示词，看不出干了什么。
 */
function chatTaskSnapshot(limit = 8): string {
  try {
    const rows = DB.prepare(
      `SELECT t.id, t.state, t.started_at, t.ended_at, t.created_at, t.error_message,
              COALESCE(
                (SELECT substr(c.summary, 1, 50) FROM checkpoints c
                  WHERE c.task_id = t.id AND c.summary <> '' ORDER BY c.updated_at DESC LIMIT 1),
                substr(t.task, 1, 50)
              ) AS head,
              (SELECT COUNT(*) FROM runs r WHERE r.task_id = t.id) AS n
         FROM tasks t ORDER BY t.id DESC LIMIT ?`,
    ).all(limit) as Array<{
      id: number; state: string; started_at: number | null; ended_at: number | null;
      created_at: number; error_message: string | null; head: string; n: number;
    }>;
    if (!rows.length) return '（hub 里还没有任何任务）';
    return rows.map((r) => {
      const when = new Date(r.created_at).toLocaleString('zh-CN', {
        hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
      });
      const dur = r.started_at && r.ended_at
        ? Math.max(1, Math.round((r.ended_at - r.started_at) / 60_000)) + ' 分钟'
        : '未结束';
      const head = String(r.head || '').replace(/\s+/g, ' ').slice(0, 46);
      const err = r.error_message ? ` · 原因：${String(r.error_message).slice(0, 40)}` : '';
      return `- #${r.id} ${r.state} · ${when} · ${r.n} 轮 · ${dur}${err} —— ${head}`;
    }).join('\n');
  } catch (e) {
    // 空快照会让对话答「看不到任务」，但没人知道是查询挂了。
    // 打一行日志，别让 SQL 写错这种事静默成「它不知道」
    console.error('任务快照查询失败：' + String((e as Error).message ?? e));
    return '';
  }
}


const BASE_PORT = Number(process.env.MA_PORT || 3400);

// 自定义 CLI：providers.toml 写清楚「可执行文件 + 参数模板」就能接，不用改代码。
// 配置写坏了直接退：半套 provider 起来比不起来更难查。
try {
  const added = registerProvidersFrom(PROVIDERS_FILE);
  if (added.length) console.log(`自定义 provider：${added.join('、')}`);
} catch (e) {
  console.error('providers.toml 有问题：' + String(e));
  process.exit(1);
}

/**
 * 单例锁：两个 hub 连着同一个库时，后起的那个会在 reconcile 里
 * 把先起的那边的活任务全标成 interrupted（审计 P0-4）。
 *
 * 为什么不用锁文件：文件系统没有 compare-and-delete。
 * 「读 pid → 发现是死的 → 删掉 → 建新的」里，两个进程能同时读到同一个死 pid，
 * A 删完建好新锁，B 接着把 A 的新锁删掉再建自己的——两个 hub 一起活。
 * 在 unlink 前再读一次 pid 也只是把窗口缩小，不是闭合。
 *
 * 所以改成数据库行原子认领：
 * - INSERT 主键 id=1，唯一约束保证只有一个进程插得进去；
 * - 回收僵尸锁用 `DELETE ... WHERE pid = <我看到的那个死 pid>`，
 *   影响 0 行就说明别人先回收了，不删任何东西，回到开头重试插入。
 * 这两步都是 SQLite 层的原子操作，没有 TOCTOU。
 */
const LEGACY_LOCK = path.join(DATA_DIR, 'hub.lock');

function pidAlive(pid: number): boolean {
  if (!pid || pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function acquireSingleton(db: DatabaseSync): Promise<void> {
  // 老版本用锁文件，留着会让人误以为它还有用。
  // 但它也是升级期的唯一线索：旧版 hub 只认文件、不认库里的行，
  // 直接删掉会让新旧两个版本同时活着。所以先看它写的 pid，活着就退出去。
  try {
    const old = Number(fs.readFileSync(LEGACY_LOCK, 'utf8').trim());
    if (pidAlive(old)) {
      console.error(`检测到旧版 hub 还在跑（pid ${old}，锁文件 ${LEGACY_LOCK}）。先停掉它再启动。`);
      process.exit(1);
    }
  } catch {}
  try { fs.unlinkSync(LEGACY_LOCK); } catch {}

  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      db.prepare('INSERT INTO hub_lock (id, pid, at) VALUES (1, ?, ?)').run(process.pid, Date.now());
      process.on('exit', () => {
        // 只删自己那一行：别的进程可能已经接手
        try {
          db.prepare('DELETE FROM hub_lock WHERE id = 1 AND pid = ?').run(process.pid);
        } catch {}
      });
      return;
    } catch (e) {
      const msg = String((e as Error).message ?? e);
      // 几个实例同时启动时，别人正在写，自己会先撞上 SQLITE_BUSY：
      // 这不是「锁被占」，等一会儿再插就是了，不能直接退出
      if (/busy|locked/i.test(msg)) {
        await new Promise((r) => setTimeout(r, 120));
        continue;
      }
      if (!/UNIQUE|constraint/i.test(msg)) {
        console.error('拿不到单例锁：' + msg);
        process.exit(1);
      }
    }

    const row = db.prepare('SELECT pid FROM hub_lock WHERE id = 1').get() as
      | { pid: number }
      | undefined;
    if (!row) continue; // 刚好被释放，重试插入
    if (row.pid === process.pid) return;

    if (pidAlive(row.pid)) {
      console.error(`已经有 hub 在跑（pid ${row.pid}）。本进程退出，不动那边的任务。`);
      process.exit(1);
    }

    // 回收僵尸锁：条件里带着「我看到的那个 pid」。
    // 另一个进程抢先回收并写入自己的 pid 时，这条 DELETE 影响 0 行，下一轮 INSERT 会看到活 pid 并退出。
    const claimed = db
      .prepare('DELETE FROM hub_lock WHERE id = 1 AND pid = ?')
      .run(row.pid);
    if (Number(claimed.changes) === 0) continue;
  }

  console.error('重试多次仍拿不到 hub 单例锁，本进程退出。');
  process.exit(1);
}

// hub：库和调度器都是进程级的，一个 server 进程就是一个 hub
const DB = openDB();
// 认领单例要先把库打开：锁现在是库里的一行，不是文件
await acquireSingleton(DB);
{
  const mig = importLegacyRuns(DB);
  if (mig.imported) console.log(`历史轮次导入 ${mig.imported} 条`);
}
const bus = new LogBus();
// 全机共用一个车位池：任务级并发（MA_CONCURRENCY）和任务内的车道并发共用它，
// 否则两层各 3 路叠起来就是 9 个 codebuddy 进程同时跑
const POOL = new Semaphore(Number(process.env.MA_CONCURRENCY || 3));
const scheduler = new Scheduler({
  db: DB,
  root: SANDBOX_ROOT,
  maxConcurrent: Number(process.env.MA_CONCURRENCY || 3),
  pool: POOL,
  onLog: (id, line) => bus.push(id, line),
  // 任务进终态后延迟释放日志缓冲：刚结束那几分钟界面可能还在看，
  // 但不释放的话缓冲会一直涨（每任务最多 2000 行）
  onState: (id, state) => {
    if (id && TERMINAL.indexOf(state) >= 0) {
      setTimeout(() => bus.release(id), 60_000).unref();
    }
  },
});

const TERMINAL = ['done', 'failed', 'canceled', 'timed_out', 'interrupted', 'blocked'];

/** 请求体上限。本地服务也是浏览器可达的地址，不能让它无限读下去 */
const MAX_BODY = 8 * 1024 * 1024;
/** 单次任务正文上限。前端限 4000 字，但 API 可以直调，这里必须再挡一次 */
const MAX_TASK = 20_000;

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > MAX_BODY) throw new Error(`请求体超过 ${MAX_BODY} 字符`);
  }
  try {
    return JSON.parse(raw || '{}') as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * 可选模型不再写死：问 CLI 要，缓存 10 分钟，界面可以手动刷新。
 * 写死的列表会随服务端下线而失真（hy4free 就是这样没的）。
 */

async function waitDone(
  taskId: number,
  timeoutMs: number,
  stopped?: () => boolean,
): Promise<string | null> {
  const started = Date.now();
  for (;;) {
    const row = DB.prepare('SELECT state FROM tasks WHERE id = ?').get(taskId) as
      | { state: string }
      | undefined;
    if (row && TERMINAL.includes(row.state)) return row.state;
    if (stopped?.()) return null; // 客户端走了，别再挂着
    if (Date.now() - started > timeoutMs) throw new Error('等待任务结束超时');
    await new Promise((r) => setTimeout(r, 300));
  }
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
  '.pdf': 'application/pdf',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

function json(res: http.ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

/**
 * 新节点的默认提示词。界面会自己写一份更详细的，但直接打 API 建节点时
 * 没人写文件，新主控就会落到 ROLE_FALLBACK（「你是一个执行者」）——语义全错。
 * 这里兜底：文件不存在才写，不覆盖已有内容。
 */
function ensurePrompt(role: string, name: string, isMaster: boolean): void {
  if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(role)) return;
  const f = path.join(PROMPTS_DIR, role + '.md');
  if (fs.existsSync(f)) return;
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const body = isMaster
    ? '你是这条产线的调度者。你的活是拆、派、收、报，不是自己把活干完。\n\n'
      + '【拆】\n- 按「能独立验收的产物」切，一片一个文件或一个功能点。\n- 每片写清：一句话目标、验收条件、产物路径。\n\n'
      + '【派】\n- 派给对口的直接下级，不要越级。\n- 派活里写清交付物和验收口径，不替下级设计方案。\n\n'
      + '【收】\n- 只认产物：文件在不在、跑没跑通；下级说完成了不算。\n- 判通过要给 evidence（从产物里原样复制的片段）。\n\n'
      + '【红线】\n- 不自己动手写子代理的活。\n- 不替下级编造它没做的结果。\n'
    : '你是这条产线的一条执行线，只做派给你的那一件事。\n\n'
      + '【接活】\n- 目标、验收条件、产物路径都写在任务里。三样缺一样就提问，不要自己猜范围。\n\n'
      + '【做】\n- 只改这件事需要的文件，沿用现场已有的写法和命名。\n- 做完自己验证一次，没验证过的不写「已完成」。\n\n'
      + '【交】\n- 第一行一句话说做成了什么，带产物路径。\n';
  fs.writeFileSync(f, `# ${name}（${role}）\n\n${body}`, 'utf8');
}

/**
 * 监听地址。
 *
 * 默认只绑回环：这个服务能建任务、能跑命令，暴露到网络上等于把 shell 递给同网段的人。
 * 想在手机/别的电脑上打开时，显式设 MA_HOST=0.0.0.0；此时把本机所有 IPv4 加进
 * 写请求白名单，否则浏览器发来的 Origin 会被 403 挡住（页面能开、按钮全失灵）。
 */
const HOST = process.env.MA_HOST || '127.0.0.1';
const OPEN_TO_LAN = HOST === '0.0.0.0';

/**
 * 对外监听时的访问令牌。
 *
 * 只绑回环不需要——本机就是唯一入口。绑 0.0.0.0 时必须：这个服务能建任务、
 * 能起 CLI，远程一个 POST 就等于借用当前用户的权限读写文件。
 * Origin 只挡浏览器，挡不住不带 Origin 的脚本（外部审计 C-1）。
 */
const AUTH_ON = authRequired(HOST);
const TOKEN_FILE = path.join(DATA_DIR, 'hub.token');
const TOKEN = AUTH_ON ? loadOrCreateToken(TOKEN_FILE) : '';

/** 本机所有非回环 IPv4，只有对外开放时才参与 Origin 校验 */
const LAN_IPS = new Set<string>(
  Object.values(os.networkInterfaces())
    .flat()
    .filter((i): i is os.NetworkInterfaceInfo => !!i && i.family === 'IPv4' && !i.internal)
    .map((i) => i.address),
);

/**
 * 写操作只接受「本机页面」发起的。
 *
 * 只绑 127.0.0.1 挡不住浏览器：恶意页面可以用简单请求（text/plain）打过来，
 * 能否得手取决于浏览器的私有网络策略，不该把安全寄托在那上面。
 * 脚本和 curl 不发 Origin，照常放行——这是本地工具，不是公网服务。
 */
function fromLocalPage(req: http.IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const h = new URL(origin).hostname;
    if (h === '127.0.0.1' || h === 'localhost' || h === '::1' || h === '[::1]') return true;
    // 对外开放时，页面本身就是用局域网地址打开的，得认这个来源
    return OPEN_TO_LAN && LAN_IPS.has(h);
  } catch {
    return false;
  }
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url || '/', `http://127.0.0.1:${BASE_PORT}`);
  const p = url.pathname;

  // 令牌校验放最前面。回环来源跳过：本机的 curl / CLI / 页面不该被自己的锁挡住，
  // 而且 token 文件就在本机，能读它的人本来就有等价权限。
  if (AUTH_ON && !isLoopbackAddr(req.socket.remoteAddress)) {
    const hit = tokenFromRequest(req.headers, url.searchParams);
    if (!tokenMatches(hit.token, TOKEN)) {
      if (p.startsWith('/api/')) {
        json(res, 401, {
          error: '要带访问令牌',
          hint: '在服务端窗口里能看到带 ?token= 的完整地址；令牌也存于 ' + TOKEN_FILE,
        });
      } else {
        res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(unauthPage(TOKEN_FILE));
      }
      return;
    }
    if (hit.fromQuery) {
      // 首次用 ?token= 打开：种 cookie 后把地址栏里的令牌擦掉，免得留在历史和截图里
      res.setHeader('Set-Cookie', tokenCookie(TOKEN));
      if (p === '/' || p === '/index.html') {
        res.writeHead(302, { Location: '/' });
        res.end();
        return;
      }
    }
  }

  if (req.method !== 'GET' && req.method !== 'HEAD' && !fromLocalPage(req)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('只接受本机页面发起的写请求');
    return;
  }

  if (p === '/' || p === '/index.html') {
    let html: string;
    try {
      html = fs.readFileSync(UI, 'utf8');
    } catch {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('ui/index.html 不存在：' + UI);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }

  if (p === '/api/state') {
    const cfg = loadConfig(CFG);
    const runs = loadRuns().slice(-40).reverse().map((r) => ({ ...r, hasLog: hasLog(r.id) }));
    json(res, 200, { nodes: cfg.nodes, root: cfg.root.id, runs });
    return;
  }

  if (p === '/api/artifact') {
    const target = url.searchParams.get('path') || '';
    const abs = path.resolve(target);
    let cfg;
    try { cfg = loadConfig(CFG); } catch { res.writeHead(500); res.end('配置读不了'); return; }
    // 先解析软链再做归属判断：否则工作区里一个指向外部的链接就能读到任意文件
    let real = abs;
    try { real = fs.realpathSync(abs); } catch { /* 文件不存在，后面 stat 会报 */ }

    // 工作区现在按任务隔离（.sandbox/t<id>/<节点>），配置里存的是短名，
    // 所以不能拿 node.workspace 直接 resolve——那样会指到项目根下不存在的目录。
    const roots: string[] = [];
    const sandbox = path.join(SANDBOX_ROOT, '.sandbox');
    try { roots.push(fs.realpathSync(sandbox)); } catch {}
    for (const n of cfg.nodes) {
      if (workspaceIsIsolated(n)) continue;
      try { roots.push(fs.realpathSync(path.resolve(n.workspace))); } catch {}
    }
    const inScope = roots.some((root) => inside(root, real));
    if (!inScope) { res.writeHead(403); res.end('不在任何节点的工作区内'); return; }
    try {
      const st = fs.statSync(real);
      if (!st.isFile()) throw new Error('不是文件');
      const ext = path.extname(real).toLowerCase();
      // 产物里可能有模型写的 HTML：给它 CSP sandbox，跑在不透明源里，
      // 脚本读不到 cookie，也调不动 hub 的写接口（审计 C-2）。
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
    return;
  }

  if (p === '/api/agent-artifacts') {
    // 左侧产物舞台：某个节点在某个任务里产出的文件清单。
    // 路径只在轮次的 json 里有，所以这里按任务回捞最近 20 轮，去重后按修改时间倒序。
    const nodeId = url.searchParams.get('id') || '';
    const taskId = Number(url.searchParams.get('task') || 0);
    if (!nodeId) { json(res, 400, { error: '要带 id' }); return; }
    const rows = (taskId
      ? DB.prepare('SELECT id, json_path FROM runs WHERE node_id = ? AND task_id = ? ORDER BY id DESC LIMIT 20').all(nodeId, taskId)
      : DB.prepare('SELECT id, json_path FROM runs WHERE node_id = ? ORDER BY id DESC LIMIT 20').all(nodeId)
    ) as Array<{ id: number; json_path: string }>;
    const items: Array<Record<string, unknown>> = [];
    const seen = new Set<string>();
    let strayMissing = 0;
    for (const r of rows) {
      // 未验收的文件也要列：它写过，只是没通过校验。藏起来的话，
      // 界面就真的显示「这个代理什么都没产出」（#40）
      let list: Array<{ path?: string; kind?: string; stray?: boolean; why?: string }> = [];
      try {
        const j = JSON.parse(fs.readFileSync(String(r.json_path), 'utf8')) as {
          artifacts?: Array<{ path?: string; kind?: string }>;
          stray?: Array<{ path?: string; why?: string }>;
        };
        list = [
          ...(j.artifacts ?? []).map((a) => ({ ...a, stray: false })),
          ...(j.stray ?? []).map((s) => ({ path: s.path, kind: '', stray: true, why: s.why })),
        ];
      } catch { continue; }
      for (const a of list) {
        const raw = String(a.path ?? '');
        if (!raw) continue;
        const abs = path.resolve(raw);
        if (seen.has(abs)) continue;
        seen.add(abs);
        let st: fs.Stats;
        try { st = fs.statSync(abs); } catch { if (a.stray) strayMissing += 1; continue; }
        if (!st.isFile()) { if (a.stray) strayMissing += 1; continue; }
        items.push({
          name: path.basename(abs),
          path: abs,
          ext: path.extname(abs).slice(1).toLowerCase(),
          size: st.size,
          mtime: st.mtimeMs,
          run: r.id,
          kind: a.kind ?? '',
          stray: !!a.stray,
          why: a.why ?? '',
        });
      }
    }
    items.sort((x, y) => Number(y.mtime) - Number(x.mtime));
    json(res, 200, {
      items,
      // 登记过、但磁盘上已不存在的未验收文件数：至少能说清「写了，文件没了」
      strayMissing,
      error: items.length ? '' : (strayMissing
        ? `它写过 ${strayMissing} 个文件，但磁盘上已经找不到（路径见轮次详情）`
        : (taskId ? '这个任务里它还没产出文件' : '从它最近 20 轮里找不到产物')),
    });
    return;
  }

  if (p === '/api/run' && req.method === 'POST') {
    let body: { node?: string; task?: string; debug?: boolean };
    try {
      // 用有界的 readJson：原来这里自己写了个 for-await 循环，没有上限，
      // 一个大 body 就能在检查「任务正文 2 万字」之前把内存吃光（审计 P1-9）
      body = (await readJson(req)) as { node?: string; task?: string; debug?: boolean };
    } catch (e) {
      json(res, 400, { error: e instanceof Error ? e.message : 'body 读取失败' });
      return;
    }
    const task = (body.task || '').trim();
    if (!task) { json(res, 400, { error: '任务不能为空' }); return; }
    if (task.length > MAX_TASK) {
      json(res, 400, { error: `任务正文 ${task.length} 字，超过上限 ${MAX_TASK}` });
      return;
    }

    let cfg;
    try { cfg = loadConfig(CFG); } catch (e) { json(res, 500, { error: String(e) }); return; }
    const master = body.node || cfg.root.id;
    // 派活只有一个入口：主控。直接点名某个子节点等于人绕过主控去指挥执行者，
    // 那一轮没人验收（review=false 直接 DONE），产物会跳过检查入库。
    // 单独跑某个节点只在调试时需要，CLI 用 --node 会带 debug=true。
    if (master !== cfg.root.id && !body.debug) {
      json(res, 400, {
        error: `派活只能从主控「${cfg.root.id}」开始；要单跑某个节点请用命令行 --node（调试用途）`,
      });
      return;
    }
    try { nodeById(cfg, master); } catch (e) { json(res, 400, { error: String(e) }); return; }

    // 先把任务建出来再写响应头：这样能带上 X-Task-Id，
    // 页面不用等第一条 SSE 就知道该切到哪个任务（否则要等流开始，看起来像没启动）
    let taskId = 0;
    try {
      taskId = createTask(DB, {
        master,
        task,
        configSnapshot: takeSnapshot(cfg, loadLessons()),
      });
    } catch (e) {
      json(res, 500, { error: String(e) });
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      'X-Task-Id': String(taskId),
    });
    const send = (line: string) => {
      try { res.write(`data: ${JSON.stringify(line)}\n\n`); } catch {}
    };
    const done = (payload: unknown) => {
      try { res.write(`event: done\ndata: ${JSON.stringify(payload)}\n\n`); res.end(); } catch {}
    };

    try {
      send(`task #${taskId}  已入队，等调度器认领`);

      // 先补历史再订阅：中间这段时间的行也不会漏
      for (const line of bus.history(taskId)) send(line);
      const unsub = bus.subscribe(taskId, send);

      let gone = false;
      req.on('close', () => { gone = true; });
      try {
        const state = await waitDone(taskId, 30 * 60_000, () => gone);
        if (state === null) return; // 人走了，任务继续在 hub 上跑
        const row = DB.prepare('SELECT error_message FROM tasks WHERE id = ?').get(taskId) as
          | { error_message: string | null }
          | undefined;
        done({ ok: state === 'done', state, taskId, error: row?.error_message ?? undefined });
      } finally {
        unsub();
      }
    } catch (e) {
      send('出错：' + String(e));
      done({ ok: false, error: String(e), taskId });
    }
    return;
  }

  {
    // 单个任务：它的轮次 + 日志历史，点开就看
    const m = /^\/api\/tasks\/(\d+)$/.exec(p);
    if (m && req.method === 'GET') {
      const id = Number(m[1]);
      const task = DB.prepare(
        `SELECT id, master, task, state, created_at, started_at, ended_at,
                error_code, error_message, parent_task_id, plan, phases_done
           FROM tasks WHERE id = ?`,
      ).get(id);
      if (!task) {
        json(res, 404, { error: `没有任务 ${id}` });
        return;
      }
      const rows = DB.prepare(
        `SELECT id, parent_run_id, node_id, phase, state, verdict, json_path,
                log_path, ms, ended_at
           FROM runs WHERE task_id = ? ORDER BY id`,
      ).all(id) as Array<Record<string, unknown>>;
      // summary / 产物 / 这一轮收到的命令都在 json 里，表里没有；中断的轮次没有文件就跳过
      const runs = rows.map((r) => {
        let summary = '';
        let artifacts: string[] = [];
        let task = '';
        let dispatch: Array<{ to?: string; task?: string }> = [];
        let startedAt = '';
        let model = '';
        let promptBytes = 0;
        let question = '';
        let usage: unknown = null;
        // 写了但没通过的文件：界面要能列出来，否则失败的一轮看起来毫无产出
        let stray: Array<{ path?: string; bytes?: number; why?: string }> = [];
        // 点名提问：界面要能看出它在等谁回答
        let ask: Array<{ from?: string; to?: string; question?: string }> = [];
        // 走缓存：界面每 4 秒拉一次，千轮任务不该每次都读+解析一千个文件（审计 m1）
        const j = readRunJson<{
          summary?: string;
          artifacts?: Array<{ path?: string }>;
          task?: string;
          dispatch?: Array<{ to?: string; task?: string }>;
          startedAt?: string;
          model?: string;
          promptBytes?: number;
          usage?: unknown;
          stray?: Array<{ path?: string; bytes?: number; why?: string }>;
          ask?: Array<{ from?: string; to?: string; question?: string }>;
        }>(String(r.json_path));
        if (j) {
          summary = j.summary ?? '';
          artifacts = (j.artifacts ?? []).map((a) => String(a.path ?? '')).filter(Boolean);
          task = j.task ?? '';
          dispatch = Array.isArray(j.dispatch) ? j.dispatch : [];
          startedAt = j.startedAt ?? '';
          model = j.model ?? '';
          promptBytes = j.promptBytes ?? 0;
          usage = j.usage ?? null;
          question = j.question ?? '';
          stray = Array.isArray(j.stray) ? j.stray : [];
          ask = Array.isArray(j.ask) ? j.ask : [];
        }
        return { ...r, summary, artifacts, task, dispatch, startedAt, question, model, promptBytes, usage, stray, ask };
      });
      // 已经续跑过的任务要标出来，否则人会反复点「续跑」建出一串同样的任务
      const kid = DB.prepare('SELECT id FROM tasks WHERE parent_task_id = ? ORDER BY id DESC LIMIT 1')
        .get(id) as { id: number } | undefined;
      // 有挂着的派生审批 = 这一轮卡在等人。不显示的话任务看着在跑，
      // 实际上车位全空、一条活都没派出去（#47 就是这样干等了十分钟）
      const pendingApr = DB.prepare(
        "SELECT id, payload FROM approvals WHERE task_id = ? AND state = 'pending' ORDER BY id DESC LIMIT 1",
      ).get(id) as { id: number; payload: string } | undefined;
      let waitingApproval: { id: number; name: string; why: string } | null = null;
      if (pendingApr){
        try {
          const p = JSON.parse(pendingApr.payload) as { name?: string; why?: string };
          waitingApproval = {
            id: pendingApr.id,
            name: String(p.name || '新产线'),
            why: String(p.why || ''),
          };
        } catch {
          waitingApproval = { id: pendingApr.id, name: '新产线', why: '' };
        }
      }
      json(res, 200, {
        task,
        runs,
        messages: listMessages(DB, id),
        log: bus.history(id),
        resumedBy: kid ? kid.id : 0,
        waitingApproval,
      });
      return;
    }
  }

  {
    // 任务状态快照：每个节点一行「现在什么状态、手上有哪些产物」。
    // 人可以直接看，续跑和外部 agent 也读这一份（改进1）
    const m = /^\/api\/tasks\/(\d+)\/checkpoint$/.exec(p);
    if (m && req.method === 'GET') {
      const id = Number(m[1]);
      const task = DB.prepare(
        `SELECT id, master, state, parent_task_id, error_code, error_message, created_at, updated_at
           FROM tasks WHERE id = ?`,
      ).get(id) as Record<string, unknown> | undefined;
      if (!task) {
        json(res, 404, { error: `没有任务 ${id}` });
        return;
      }
      json(res, 200, { task, nodes: listCheckpoints(DB, id) });
      return;
    }
  }

  {
    // 按任务订阅日志：先回放历史再推新的，所以中途接上也看得全
    const m = /^\/api\/tasks\/(\d+)\/stream$/.exec(p);
    if (m && req.method === 'GET') {
      const id = Number(m[1]);
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      const send = (line: string) => {
        try { res.write(`data: ${JSON.stringify(line)}\n\n`); } catch {}
      };
      for (const line of bus.history(id)) send(line);
      const unsub = bus.subscribe(id, send);
      const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 15000);
      req.on('close', () => {
        clearInterval(ping);
        unsub();
      });
      return;
    }
  }

  if (p === '/api/models' && req.method === 'GET') {
    // refresh=1：界面上的「刷新模型列表」，强制重新问一次 CLI
    const force = url.searchParams.get('refresh') === '1';
    try {
      const ml = force ? await refreshModels() : await getModels();
      json(res, 200, {
        models: ml.models,
        meta: { source: ml.source, at: ml.at, from: ml.from, error: ml.error ?? '' },
      });
    } catch (e) {
      json(res, 500, { error: String(e) });
    }
    return;
  }

  if (p === '/api/agents' && req.method === 'GET') {
    try {
      const cfg = loadConfig(CFG);
      // 页面加载不能等 CLI：有快照就先用，过期了在后台续；
      // 只有第一次启动（连缓存都没有）才同步等一次探测
      const ml = peekModels() ?? (await getModels());
      void getModels();
      json(res, 200, {
        nodes: cfg.nodes,
        root: cfg.root.id,
        models: ml.models,
        // 列表从哪来、什么时候取的、上次探测失败的原因：界面据此提示「可能不是最新」
        modelsMeta: { source: ml.source, at: ml.at, from: ml.from, error: ml.error ?? '' },
        // provider 列表由表驱动：加一个 CLI 只改 adapters/table.ts，界面自动出现
        plugins: providerNames().map((id) => ({ id, label: PROVIDERS[id].label })),
        concurrency: { active: scheduler.inflight().length, max: scheduler.limit() },
        // 车位是任务和车道共用的：active 是正在跑的轮次，waiting 是排队等车位的
        lanes: { active: POOL.busy(), waiting: POOL.waiting(), max: POOL.limit },
        limits: { maxSummary: cfg.maxSummary, maxDetail: cfg.maxDetail, maxNodes: MAX_NODES },
      });
    } catch (e) {
      json(res, 500, { error: String(e) });
    }
    return;
  }

  if (p === '/api/agents' && req.method === 'POST') {
    const body = await readJson(req);
    const id = String(body.id || '');
    const patch = (body.patch || {}) as Record<string, unknown>;
    if (!id) { json(res, 400, { error: '要带 id' }); return; }
    try {
      // 读最新 → 改 → 写回，全程在配置锁内：和派生、设置保存并发也不会互相覆盖
      const node = await mutateConfig(CFG, (cfg) => {
        const n = cfg.nodes.find((x) => x.id === id);
        if (!n) throw new ConfigError(404, `没有节点 ${id}`);
        // 只允许改这几项：id/parent 动了会打乱树，workspace 动了会让旧产物找不到
        if (typeof patch.name === 'string' && patch.name.trim()) n.name = patch.name.trim();
        if (typeof patch.model === 'string') n.model = patch.model.trim();
        if (typeof patch.plugin === 'string' && patch.plugin.trim()) n.plugin = patch.plugin.trim();
        if (typeof patch.access === 'string' && patch.access.trim()) {
          const acc = patch.access.trim();
          if (acc !== 'read' && acc !== 'write') throw new ConfigError(400, 'access 只能是 read 或 write');
          // 只读不是装饰：provider 做不到就直接拒，别让人以为审批时看到的是约束
          if (acc === 'read' && !supportsReadOnly(n.plugin)) {
            throw new ConfigError(400, `${n.plugin} 没有真正的只读模式，不能配 access="read"；请用 write，或换 codex 节点`);
          }
          n.access = acc;
        }
        // 换 role 等于换整套提示词：文件按 role 命名，多个节点可以共用一个 role
        if (typeof patch.role === 'string' && patch.role.trim()) {
          const role = patch.role.trim();
          if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(role)) {
            throw new ConfigError(400, 'role 只能用 1–32 位小写字母/数字/下划线/连字符');
          }
          n.role = role;
        }
        if (patch.timeoutMin !== undefined) {
          const t = Number(patch.timeoutMin);
          if (!Number.isFinite(t) || t < 1 || t > 240) throw new ConfigError(400, '超时要在 1–240 分钟');
          n.timeoutMin = Math.round(t);
        }
        return n;
      });
      json(res, 200, { ok: true, node });
    } catch (e) {
      if (e instanceof ConfigError) { json(res, e.status, { error: e.message }); return; }
      json(res, 500, { error: String(e) });
    }
    return;
  }

  if (p === '/api/agents/promote' && req.method === 'POST') {
    // 在主控之上再插一层：新节点成为根，原来的根挂到它下面。
    // 配置里 [root] 段跟着换人，原根落成 [agent.<原id>]，读回来就是一棵更深的树。
    const body = await readJson(req);
    const id = String(body.id || '').trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9_-]{0,7}$/.test(id)) {
      json(res, 400, { error: '编号只能用 1–8 位小写字母/数字/下划线/连字符' });
      return;
    }
    try {
      const added = await mutateConfig(CFG, (cfg) => {
        if (cfg.nodes.some((n) => n.id === id)) throw new ConfigError(409, `编号 ${id} 已经有了`);
        if (cfg.nodes.length >= MAX_NODES) throw new ConfigError(400, `节点上限 ${MAX_NODES} 个`);
        const access = String(body.access || 'write').trim();
        if (access === 'read' && !supportsReadOnly(String(body.plugin || cfg.root.plugin || 'codebuddy').trim())) {
          throw new ConfigError(400, '这个 provider 没有真正的只读模式，不能配 access="read"');
        }
        const newRoot = {
          id,
          parent: '',
          name: String(body.name || '总控').trim() || '总控',
          plugin: String(body.plugin || cfg.root.plugin || 'codebuddy').trim(),
          workspace: String(body.workspace || id).trim(),
          timeoutMin: Math.min(240, Math.max(1, Math.round(Number(body.timeoutMin) || cfg.root.timeoutMin || 10))),
          access,
          role: String(body.role || id).trim(),
          model: String(body.model || cfg.root.model || '').trim(),
        };
        const oldRoot = cfg.root;
        oldRoot.parent = newRoot.id;
        cfg.root = newRoot;
        cfg.nodes.unshift(newRoot);
        return { newRoot, oldRootId: oldRoot.id };
      });
      ensurePrompt(added.newRoot.role, added.newRoot.name, true);
      json(res, 200, { ok: true, node: added.newRoot, below: added.oldRootId });
    } catch (e) {
      if (e instanceof ConfigError) { json(res, e.status, { error: e.message }); return; }
      json(res, 500, { error: String(e) });
    }
    return;
  }

  if (p === '/api/agents/create' && req.method === 'POST') {
    const body = await readJson(req);
    const id = String(body.id || '').trim().toLowerCase();
    const parent = String(body.parent || '').trim();
    if (!/^[a-z0-9][a-z0-9_-]{0,7}$/.test(id)) {
      json(res, 400, { error: '编号只能用 1–8 位小写字母/数字/下划线/连字符' });
      return;
    }
    try {
      const node = await mutateConfig(CFG, (cfg) => {
        if (cfg.nodes.some((n) => n.id === id)) throw new ConfigError(409, `编号 ${id} 已经有了`);
        if (!cfg.nodes.some((n) => n.id === parent)) throw new ConfigError(400, `父代理 ${parent} 不存在`);
        if (cfg.nodes.length >= MAX_NODES) throw new ConfigError(400, `节点上限 ${MAX_NODES} 个`);
        const access = String(body.access || 'write').trim();
        const plugin = String(body.plugin || 'codebuddy').trim();
        if (access === 'read' && !supportsReadOnly(plugin)) {
          throw new ConfigError(400, `${plugin} 没有真正的只读模式，不能配 access="read"`);
        }
        const n = {
          id,
          parent,
          name: String(body.name || id).trim() || id,
          plugin,
          workspace: String(body.workspace || id).trim(),
          timeoutMin: Math.min(240, Math.max(1, Math.round(Number(body.timeoutMin) || 8))),
          access,
          // 新建代理默认给它自己一份提示词：role 用编号，文件是 prompts/<编号>.md
          role: String(body.role || id).trim(),
          model: String(body.model || '').trim(),
        };
        cfg.nodes.push(n);
        return n;
      });
      ensurePrompt(node.role, node.name, false);
      json(res, 200, { ok: true, node });
    } catch (e) {
      if (e instanceof ConfigError) { json(res, e.status, { error: e.message }); return; }
      json(res, 500, { error: String(e) });
    }
    return;
  }

  if (p === '/api/agents/delete' && req.method === 'POST') {
    const body = await readJson(req);
    const id = String(body.id || '');
    if (!id) { json(res, 400, { error: '要带 id' }); return; }
    try {
      const removed = await mutateConfig(CFG, (cfg) => {
        if (id === cfg.root.id) throw new ConfigError(400, '主控不能删，它是这棵树的根');
        if (!cfg.nodes.some((n) => n.id === id)) throw new ConfigError(404, `没有节点 ${id}`);
        // 子树一起带走：留着孤儿节点的 parent 会指向不存在的 id，配置直接读不回来
        const victims = new Set([id]);
        for (let grew = true; grew; ) {
          grew = false;
          for (const n of cfg.nodes) {
            if (n.parent && victims.has(n.parent) && !victims.has(n.id)) { victims.add(n.id); grew = true; }
          }
        }
        cfg.nodes = cfg.nodes.filter((n) => !victims.has(n.id));
        return [...victims];
      });
      json(res, 200, { ok: true, removed });
    } catch (e) {
      if (e instanceof ConfigError) { json(res, e.status, { error: e.message }); return; }
      json(res, 500, { error: String(e) });
    }
    return;
  }

  if (p === '/api/prompts' && req.method === 'GET' && url.searchParams.get('list')) {
    // 提示词库：prompts/ 下每个 .md 就是一个可选角色，界面用它做下拉
    const dir = PROMPTS_DIR;
    let files: string[] = [];
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.md')); } catch {}
    let used: Record<string, number> = {};
    try {
      for (const n of loadConfig(CFG).nodes) used[n.role] = (used[n.role] || 0) + 1;
    } catch {}
    const items = files.map((f) => {
      const role = f.slice(0, -3);
      let text = '';
      try { text = fs.readFileSync(path.join(dir, f), 'utf8'); } catch {}
      // 跳过标题、引用块和代码围栏，取正文第一句当摘要
      const line = text.split(/\r?\n/).map((l) => l.trim())
        .find((l) => l && !l.startsWith('#') && !l.startsWith('>') && l.indexOf('```') !== 0) || '';
      return { role, size: text.length, preview: line.slice(0, 70), inUse: used[role] || 0 };
    });
    json(res, 200, { items });
    return;
  }

  if (p === '/api/prompts' && req.method === 'GET') {
    const role = url.searchParams.get('role') || '';
    if (!/^[a-z0-9_-]+$/i.test(role)) { json(res, 400, { error: 'role 不合法' }); return; }
    const f = path.join(PROMPTS_DIR, role + '.md');
    // 先读再写响应头：文件不存在时 readFileSync 会抛，头已经发出去就再也没法改状态码了
    let text = '';
    try { text = fs.readFileSync(f, 'utf8'); } catch {}
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(text);
    return;
  }

  if (p === '/api/prompts' && req.method === 'POST') {
    const body = await readJson(req);
    const role = String(body.role || '');
    const text = String(body.text ?? '');
    if (!/^[a-z0-9_-]+$/i.test(role)) { json(res, 400, { error: 'role 不合法' }); return; }
    if (text.length > 20000) { json(res, 400, { error: '提示词太长（上限 20000 字）' }); return; }
    try {
      const dir = PROMPTS_DIR;
      fs.mkdirSync(dir, { recursive: true });
      const f = path.join(dir, role + '.md');
      const tmp = f + '.tmp';
      fs.writeFileSync(tmp, text, 'utf8');
      fs.renameSync(tmp, f);
      json(res, 200, { ok: true, bytes: Buffer.byteLength(text, 'utf8') });
    } catch (e) {
      json(res, 500, { error: String(e) });
    }
    return;
  }

  if (p === '/api/tasks' && req.method === 'GET') {
    const rows = DB.prepare(
      `SELECT id, master, state, created_at, started_at, ended_at, error_code, error_message,
              substr(task, 1, 120) AS task
         FROM tasks
        ORDER BY id DESC
        LIMIT 50`,
    ).all();
    json(res, 200, { tasks: rows });
    return;
  }

  {
    const m = /^\/api\/tasks\/(\d+)\/cancel$/.exec(p);
    if (m && req.method === 'POST') {
      const id = Number(m[1]);
      const ok = scheduler.cancel(id);
      if (!ok) {
        // 还在排队就直接改状态，不用等调度器
        const row = DB.prepare('SELECT state FROM tasks WHERE id = ?').get(id) as
          | { state: string }
          | undefined;
        if (row?.state === 'queued') {
          expirePending(DB, id, '任务还没开跑就被取消');
          setTaskState(DB, id, 'canceled', { errorCode: 'canceled_before_start' });
          json(res, 200, { ok: true, state: 'canceled' });
        } else {
          json(res, 404, { error: row ? `任务 ${id} 不在运行（${row.state}）` : `没有任务 ${id}` });
        }
        return;
      }
      json(res, 202, { ok: true, state: 'cancelling' });
      return;
    }
  }

  // 续跑：任务被打断/失败后，把「已经交付了什么」写进新任务的正文，
  // 让主控只补缺的部分。不是恢复会话（codebuddy 是一次性调用，没有可 resume 的会话），
  // 而是把已完成的事实交给下一轮，避免整棵树重跑一遍、重复计费。
  {
    const m = /^\/api\/tasks\/(\d+)\/resume$/.exec(p);
    if (m && req.method === 'POST') {
      const id = Number(m[1]);
      const t = DB.prepare('SELECT id, master, task, state FROM tasks WHERE id = ?').get(id) as
        | { id: number; master: string; task: string; state: string }
        | undefined;
      if (!t) { json(res, 404, { error: `没有任务 ${id}` }); return; }
      if (['interrupted', 'failed', 'canceled', 'blocked'].indexOf(t.state) < 0) {
        json(res, 400, { error: `只有没跑完的任务能续跑（现在是 ${t.state}）` });
        return;
      }
      // 它在等你回答时（blocked），续跑就是「把答案给它，接着干」。
      // 没有这个入口的话，blocked 任务只能新建一个重述需求（审计 P1-11）
      const body = await readJson(req);
      // 回答单独限长，不能和原任务抢同一份 MAX_TASK：拼完再统一 slice，
      // 长的原任务会把回答整段截掉，等于用户白填（审计 P1-11）
      const answer = String(body.answer || '').trim().slice(0, 8_000);

      // 直接读状态快照：每个节点一行，产物是累计合并过的。
      // 以前是扫 runs 取 MAX(id) 再回读 json 文件——最后一轮常是收口轮（archive 为空），
      // 文件丢了还会少一条（改进1：checkpoint）
      const cps = listCheckpoints(DB, id);
      const lines: string[] = [];
      /** 没通过验收的轮次也要留痕，否则续跑看起来像「从没跑过」（#40） */
      const trail: string[] = [];
      const flat = (s: string, n: number) => String(s || '（没说）').replace(/\s+/g, ' ').slice(0, n);
      for (const c of cps) {
        if (c.state === 'done' && c.verdict !== 'rework') {
          // 单条也限长：产物列前 8 个，摘要压成一行 160 字。
          // 有备份就一并给出来——外部目录里的原件随时可能被改掉
          const files = c.artifacts.slice(0, 8)
            .map((x) => `${path.basename(String(x.path ?? ''))}（${x.bytes ?? 0} 字节${x.backup ? '，副本 ' + x.backup : ''}）`)
            .join('、') + (c.artifacts.length > 8 ? ` 等 ${c.artifacts.length} 个` : '');
          lines.push(`- ${c.nodeId}：${flat(c.summary, 160)}${files ? ' · 产物：' + files : ''}`);
          continue;
        }
        const why = c.state === 'blocked' ? '在等你回答'
          : c.state === 'failed' ? '失败'
          : c.state === 'canceled' ? '被取消'
          : c.verdict === 'rework' ? '被打回' : c.state;
        // 把「它写过什么、写在哪」写进去：只写「没产出」的话，下一轮会重写一遍，
        // 而文件其实一直在磁盘上（#40 的 23KB 分析就是这么丢的）
        const wrote = [
          ...c.artifacts.map((a) => ({ path: String(a.path ?? ''), bytes: a.bytes ?? 0, why: '未通过验收' })),
          ...c.stray.map((s) => ({ path: String(s.path ?? ''), bytes: s.bytes ?? 0, why: s.why })),
        ].filter((x) => x.path).slice(0, 3);
        const had = wrote.length
          ? ' · 写过：' + wrote.map((x) => `${x.path}（${x.why}${x.bytes ? `，${x.bytes} 字节` : ''}）`).join('；')
          : ' · 没交出产物';
        trail.push(`- ${c.nodeId}（${why}）：${flat(c.summary, 160)}${had}${c.question ? ' · 提问：' + flat(c.question, 200) : ''}`);
      }
      if (!lines.length && !trail.length && !answer) {
        json(res, 400, {
          error: '这个任务没有任何轮次记录，也没有可复用的产物，只能新建任务重投',
        });
        return;
      }

      let cfg;
      try { cfg = loadConfig(CFG); } catch (e) { json(res, 500, { error: String(e) }); return; }

      const built = buildResumeBrief({ id, state: t.state, task: t.task, answer, lines, trail });

      // 装不下就明确拒绝，不做整体 slice：切掉的可能正好是回答或尾部指令，
      // 表面续跑成功、实际要求丢了（审计 P1 续跑盲切）
      if (built.overflow) {
        json(res, 413, {
          error: `续跑上下文 ${built.brief.length} 字，超过上限 ${RESUME_MAX}：请缩短回答，或新建一个任务`,
          chars: built.brief.length,
          limit: RESUME_MAX,
        });
        return;
      }

      const newId = createTask(DB, {
        master: cfg.root.id,
        task: built.brief,
        configSnapshot: takeSnapshot(cfg, loadLessons()),
        parentTaskId: id,
      });
      json(res, 200, { ok: true, id: newId, reused: lines.length, trail: trail.length });
      return;
    }
  }

  // ---- 对话模式：问状况、叫停后转向、追问细节 ----
  // 不走 runTree：这是人和单个节点的一对一聊天，没有派活、没有回执、不验产物。
  if (p === '/api/chat/stream') {
    const nodeId = url.searchParams.get('node') || '';
    if (!CHAT_NODE_RE.test(nodeId)) { json(res, 400, { error: 'node 不合法' }); return; }
    const off = subscribe(nodeId, res);
    req.on('close', off);
    return;
  }

  if (p === '/api/chat/busy') {
    // 界面据此点亮正在对话的 agent 格子
    json(res, 200, { nodes: busyNodes() });
    return;
  }

  if (p === '/api/chat/history') {
    const nodeId = url.searchParams.get('node') || '';
    // 同样会读 .data/chat/<id>.jsonl，格式不合法直接拒
    if (!CHAT_NODE_RE.test(nodeId)) { json(res, 400, { error: 'node 不合法' }); return; }
    json(res, 200, { messages: chatHistory(nodeId), busy: isBusy(nodeId) });
    return;
  }

  if (p === '/api/chat' && req.method === 'POST') {
    const body = await readJson(req);
    const nodeId = String(body.nodeId || '');
    const text = String(body.text || '').trim();
    // nodeId 会被拼进文件路径（.data/chat/<id>.jsonl）。
    // 不先卡格式，`../marker` 就能删/读聊天目录外的文件（审计 M2）。
    if (!CHAT_NODE_RE.test(nodeId)) { json(res, 400, { error: 'nodeId 不合法' }); return; }
    let cfg;
    try { cfg = loadConfig(CFG); } catch (e) { json(res, 500, { error: String(e) }); return; }
    // 存在性校验必须在 reset 之前：reset 会删文件，删之前得先确认这个节点真的存在
    const node = cfg.nodes.find((n) => n.id === nodeId);
    if (!node) { json(res, 404, { error: `没有节点 ${nodeId}` }); return; }
    if (body.reset) {
      if (isBusy(nodeId)) { json(res, 400, { error: '它还在答，先停一下' }); return; }
      resetChat(nodeId);
      json(res, 200, { ok: true, reset: true });
      return;
    }
    if (!text) { json(res, 400, { error: '没写内容' }); return; }
    if (text.length > CHAT_MAX) { json(res, 400, { error: `一句话最多 ${CHAT_MAX} 字` }); return; }
    const r = startChat({
      nodeId,
      text,
      model: node.model,
      // 对话是「人在问项目」，所以默认站在项目根，而不是空的任务工作区
      // 对话站的项目目录：优先环境变量，其次配置里的 project.root，最后才猜
      cwd: process.env.MA_CHAT_CWD || cfg.project.root || path.join(path.dirname(CFG), '..', 'Game'),
      plugin: node.plugin,
      taskSnapshot: chatTaskSnapshot(),
      projectName: cfg.project.name,
      projectRoot: cfg.project.root,
    });
    if (!r.ok) { json(res, 409, { error: r.error }); return; }
    json(res, 202, { ok: true });
    return;
  }

  if (p === '/api/chat/stop' && req.method === 'POST') {
    const body = await readJson(req);
    const nodeId = String(body.nodeId || '');
    json(res, 200, { ok: stopChat(nodeId) });
    return;
  }

  if (p === '/api/log') {
    const id = Number(url.searchParams.get('id') || 0);
    if (!id) { json(res, 400, { error: '要带 id' }); return; }
    const text = readLog(id);
    if (text === null) { json(res, 404, { error: `第 ${id} 轮没有原文` }); return; }
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(text);
    return;
  }

  // 派生审批：模型请求新开一条产线，人在这里点头或摇头
  // 开线策略：两个开关 + 一套默认参数。存 agents.toml 的 [spawn] 段，
  // 和节点配置同源——界面改、手改、备份，都是同一个文件
  if (p === '/api/spawn-settings') {
    let cfg;
    try { cfg = loadConfig(CFG); } catch (e) { json(res, 500, { error: String(e) }); return; }
    if (req.method === 'GET') {
      json(res, 200, { settings: cfg.spawn });
      return;
    }
    if (req.method === 'POST') {
      const body = await readJson(req);
      const s = (body.settings || body) as Record<string, unknown>;
      // 校验跟既有设置保持一致：role 走和派生同一套字符集，timeout 夹在 1–120
      const role = String(s.role || '');
      if (!/^[A-Za-z0-9_-]{1,32}$/.test(role)) {
        json(res, 400, { error: 'role 只能是 1–32 位字母、数字、下划线、连字符' });
        return;
      }
      const timeoutMin = Math.round(Number(s.timeoutMin));
      if (!Number.isFinite(timeoutMin) || timeoutMin < 1 || timeoutMin > 120) {
        json(res, 400, { error: 'timeout_min 要在 1–120 之间' });
        return;
      }
      const access = s.access === 'read' ? 'read' : 'write';
      // 标准设置里的 access 会套到派生线上。派生线继承提出者的 plugin，
      // 而这个实例上的 provider 普遍没有只读模式——存进去只会产出「假只读」。
      if (access === 'read') {
        const anyReadable = cfg.nodes.some((n) => supportsReadOnly(n.plugin));
        if (!anyReadable) {
          json(res, 400, { error: '当前节点用的 provider 都没有真正的只读模式，access 只能选 write' });
          return;
        }
      }
      const saved = await mutateConfig(CFG, (disk) => {
        disk.spawn = {
          autoApprove: s.autoApprove === true,
          defaultsEnabled: s.defaultsEnabled === true,
          role,
          model: String(s.model || '').slice(0, 80),
          timeoutMin,
          access,
          taskPrefix: String(s.taskPrefix || '').slice(0, 600),
        };
        return disk.spawn;
      });
      json(res, 200, { ok: true, settings: saved });
      return;
    }
  }

  if (p === '/api/roles') {
    // 职责模板清单：开线时从这里选，别让人手打一个不存在的名字
    json(res, 200, { roles: listRoles(url.searchParams.get('refresh') === '1') });
    return;
  }

  if (p === '/api/approvals' && req.method === 'GET') {
    const state = url.searchParams.get('state') || 'pending';
    if (['pending', 'approved', 'rejected', 'expired', 'all'].indexOf(state) < 0) {
      json(res, 400, { error: 'state 只能是 pending / approved / rejected / expired / all' });
      return;
    }
    json(res, 200, { items: listApprovals(DB, state as 'pending') });
    return;
  }

  if (p.startsWith('/api/approvals/') && req.method === 'POST') {
    const id = Number(p.slice('/api/approvals/'.length));
    if (!Number.isInteger(id) || id <= 0) { json(res, 400, { error: 'id 不合法' }); return; }
    const body = await readJson(req);
    const decision = String(body.decision || '');
    if (decision !== 'approve' && decision !== 'reject') {
      json(res, 400, { error: 'decision 只能是 approve 或 reject' });
      return;
    }
    const row = getApproval(DB, id);
    if (!row) { json(res, 404, { error: `没有编号 ${id} 的审批` }); return; }
    if (row.state !== 'pending') {
      json(res, 409, { error: `这条已经处理过了（${row.state}）` });
      return;
    }
    // 确认窗口里人可能改过参数：批准前先把 patch 并进 payload。
    // 之后 applySpawns 读审批单拿的是最终值——不改这条路径，弹窗改了也白改。
    const patch = body.patch as Record<string, unknown> | undefined;
    if (decision === 'approve' && patch && typeof patch === 'object'){
      let cur: Record<string, unknown> = {};
      try { cur = JSON.parse(row.payload || '{}') as Record<string, unknown>; } catch {}
      const next: Record<string, unknown> = { ...cur };
      if (typeof patch.role === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(patch.role)) next.role = patch.role;
      if (typeof patch.model === 'string') next.model = patch.model.slice(0, 80);
      if (typeof patch.timeout_min === 'number' && Number.isFinite(patch.timeout_min)){
        next.timeout_min = Math.min(120, Math.max(1, Math.round(patch.timeout_min)));
      }
      if (patch.access === 'read' || patch.access === 'write') {
        if (patch.access === 'read') {
          // 派生线继承提出者的 plugin：做不到只读就别让人在弹窗里选，
          // 否则要等到开线时才被拦，白填一遍表单
          let parentId = '';
          try { parentId = String((JSON.parse(row.payload || '{}') as Record<string, unknown>).parent || ''); } catch {}
          let plugin = '';
          try { plugin = loadConfig(CFG).nodes.find((n) => n.id === parentId)?.plugin || ''; } catch {}
          if (!plugin || !supportsReadOnly(plugin)) {
            json(res, 400, { error: `${plugin || '这个 provider'} 没有真正的只读模式，不能批准为 read` });
            return;
          }
        }
        next.access = patch.access;
      }
      if (typeof patch.task === 'string' && patch.task.trim()) next.task = patch.task.slice(0, 8000);
      DB.prepare('UPDATE approvals SET payload = ? WHERE id = ? AND state = ?')
        .run(JSON.stringify(next), id, 'pending');
    }
    // 只有 pending 能被改：两个窗口同时点，第二票会落空，这里如实告知
    const won = decideApproval(
      DB,
      id,
      decision === 'approve' ? 'approved' : 'rejected',
      String(body.note || '').slice(0, 200),
    );
    if (!won) { json(res, 409, { error: '已经被别处处理了' }); return; }
    json(res, 200, { ok: true, id, state: decision === 'approve' ? 'approved' : 'rejected' });
    return;
  }

  if (p === '/api/health') {
    const inflight = scheduler.inflight();
    json(res, 200, {
      ok: true,
      running: inflight.length > 0,
      inflight,
      // 车位实时占用：界面每 4 秒拉一次，不用重绘整个面板
      lanes: { active: POOL.busy(), waiting: POOL.waiting(), max: POOL.limit },
    });
    return;
  }

  res.writeHead(404);
  res.end('not found');
}

const server = http.createServer((req, res) => {
  // 路由里任何一处漏掉的 catch 都会变成 unhandled rejection，默认行为是直接把进程带走
  // （之前 /api/prompts 二次 writeHead 就这么崩过一次）。统一在这里兜住，转成 500。
  handle(req, res).catch((e) => {
    try {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      }
      res.end('服务内部错误：' + (e instanceof Error ? e.message : String(e)));
    } catch {}
  });
});

function listen(port: number): void {
  server.once('error', (e: NodeJS.ErrnoException) => {
    // 不再自动换端口：换一个端口继续跑，等于默许两个 hub 同时活着，
    // 两个调度器、两套信号量、一份库，比直接失败糟得多
    console.error(e.code === 'EADDRINUSE'
      ? `端口 ${port} 被占用，可能已经有一个 hub 在跑。本进程退出。`
      : e);
    process.exit(1);
  });
  server.listen(port, HOST);
}

// listening 只注册一次：listen 失败时旧的回调不会被清掉，
// 换端口成功后会连着触发，打印出两个不同的地址。
server.on('listening', () => {
  const addr = server.address();
  const actual = typeof addr === 'object' && addr ? addr.port : BASE_PORT;
  const url = `http://127.0.0.1:${actual}`;
  console.log(`MultiAgent 界面：${url}`);
  if (OPEN_TO_LAN) {
    // 把能用浏览器打开的地址都列出来：IP 会随 DHCP 变，主机名一般不变。
    // 对外监听时这些地址必须带令牌，否则打不开（只绑回环不需要）。
    const q = AUTH_ON ? `/?token=${encodeURIComponent(TOKEN)}` : '/';
    const host = os.hostname();
    for (const ip of LAN_IPS) console.log(`  局域网（IP）：http://${ip}:${actual}${q}`);
    if (host) console.log(`  局域网（主机名）：http://${host}:${actual}${q}`);
    if (AUTH_ON) {
      console.log(`  访问令牌：${TOKEN}`);
      console.log(`  令牌也存于 ${TOKEN_FILE}（可用 MA_TOKEN 覆盖）；本机回环地址免令牌`);
    }
    console.log('  注意：同网段拿到令牌的人都能投任务、起 CLI，只在可信网络里这么开');
  }
  console.log('按 Ctrl+C 停止');
  // 启动自检：配置里写了 access="read" 但 provider 做不到，等于「界面上写着只读、
  // 实际全权限」。不阻止启动（可能只是历史配置），但必须说出来，不能静默。
  try {
    const bad = loadConfig(CFG).nodes.filter((n) => n.access === 'read' && !supportsReadOnly(n.plugin));
    for (const n of bad) {
      console.warn(`  ⚠ 节点 ${n.id} 配了 access="read"，但 ${n.plugin} 没有只读模式——实际按 write 跑`);
    }
  } catch {
    // 配置读不了会在别处报，这里不重复
  }
  // 一定要等端口拿到手再启动调度器：reconcile 会把库里 running 的任务标成 interrupted，
  // 监听失败（说明已经有 hub）时做这件事，就是替别人收尸
  scheduler.start();
  // 起来就先探一次模型列表（失败也不影响服务），之后每 10 分钟刷一次。
  // 服务端下线模型时，界面最多过 10 分钟就会自己消失，不用重启 hub。
  void refreshModels().then((m) => {
    if (m.source === 'live') console.log(`模型列表：${m.models.length} 个（来自 ${m.from.join('、')}）`);
    else console.log(`模型列表不可用（${m.source}）：${m.error ?? '未知原因'}`);
  });
  setInterval(() => { void refreshModels(); }, 10 * 60_000).unref();
  if (!process.argv.includes('--no-open')) execFile('explorer.exe', [url], () => {});
});

listen(BASE_PORT);

// Ctrl+C 不要当场把正在跑的任务砍死：先停止领新活，等这批跑完再退。
// 再按一次才是强退（任务会被对账成 interrupted）。
let draining = false;
function onSignal(): void {
  const n = scheduler.inflight().length;
  if (!n){
    console.log('\n没有在跑的任务，退出。');
    process.exit(0);
  }
  if (draining){
    console.log(`\n强退：${n} 个任务会被记为 interrupted。`);
    process.exit(130);
  }
  draining = true;
  scheduler.drain();
  console.log(`\n还有 ${n} 个任务在跑。等它们结束会自动退出；再按一次 Ctrl+C 强退。`);
  const t = setInterval(() => {
    if (scheduler.inflight().length === 0){
      clearInterval(t);
      console.log('\n任务都结束了，退出。');
      process.exit(0);
    }
  }, 1000);
}
process.on('SIGINT', onSignal);
process.on('SIGTERM', onSignal);
