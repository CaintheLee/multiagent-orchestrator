/**
 * 访问令牌。
 *
 * 绑 127.0.0.1 时不需要——本机就是唯一入口。
 * 绑 0.0.0.0 时必须：这个服务能建任务、能起 CLI，远程请求等于借用当前用户的
 * 权限读写文件。只靠 Origin 拦不住不带 Origin 的脚本（外部审计 C-1）。
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** 只有绑回环才免令牌；绑任何具体网卡地址都算对外 */
export function authRequired(host: string): boolean {
  const h = String(host || '').trim();
  return !(h === '127.0.0.1' || h === 'localhost' || h === '::1' || h === '[::1]');
}

/** 回环来源一律免令牌：本机的 curl / CLI / 页面不该被自己的锁挡住 */
export function isLoopbackAddr(addr: string | undefined): boolean {
  if (!addr) return false;
  if (addr === '::1' || addr === '::ffff:127.0.0.1') return true;
  return addr.startsWith('127.');
}

export function newToken(): string {
  return randomBytes(24).toString('hex');
}

/** 定长比较：别用 === 泄漏前缀匹配长度 */
export function tokenMatches(given: string, expected: string): boolean {
  if (!given || !expected) return false;
  const a = Buffer.from(given, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * 令牌来源：环境变量 MA_TOKEN 优先，其次数据目录里的 hub.token，都没有就生成一个。
 * 写文件是为了重启后不变——令牌每次都变的话，手机上存的书签就失效了。
 */
export function loadOrCreateToken(file: string): string {
  const env = String(process.env.MA_TOKEN || '').trim();
  if (env.length >= 8) return env;
  try {
    const t = fs.readFileSync(file, 'utf8').trim();
    if (t.length >= 16) return t;
  } catch {
    // 还没生成过
  }
  const t = newToken();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, t + '\n', { mode: 0o600 });
  } catch {
    // 写不了就只在本次进程里有效，不因为落盘失败而拒绝启动
  }
  return t;
}

export type TokenHit = { token: string; fromQuery: boolean };

/**
 * 从请求里取令牌。三种都认：自定义头（脚本）、?token=（首次打开页面）、
 * cookie（页面内后续请求，包括 SSE 和 iframe）。
 */
export function tokenFromRequest(
  headers: Record<string, string | string[] | undefined>,
  search: URLSearchParams,
): TokenHit {
  const raw = headers['x-ma-token'];
  const hv = Array.isArray(raw) ? raw[0] : raw;
  if (hv) return { token: hv.trim(), fromQuery: false };

  const q = search.get('token');
  if (q) return { token: q.trim(), fromQuery: true };

  const c = headers.cookie;
  const cookie = Array.isArray(c) ? c[0] : c || '';
  const m = /(?:^|;\s*)ma_token=([^;]+)/.exec(cookie);
  if (!m) return { token: '', fromQuery: false };
  try {
    return { token: decodeURIComponent(m[1]), fromQuery: false };
  } catch {
    return { token: m[1], fromQuery: false };
  }
}

/** 给浏览器发的 Set-Cookie 值。HttpOnly：脚本读不到，XSS 也偷不走 */
export function tokenCookie(token: string): string {
  return `ma_token=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`;
}

/**
 * 未授权页面：给一个输入框，填对令牌后跳回原地址。
 * 不做成纯 401 白屏——人会以为服务坏了。
 */
export function unauthPage(hint: string): string {
  const safe = hint.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>要访问令牌</title>
<style>
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
    background:#0b0e13;color:#dfe4ec;font:14px/1.7 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif}
  .box{width:min(92vw,420px);background:#12161e;border:1px solid #232a36;border-radius:14px;padding:22px 24px}
  h1{margin:0 0 6px;font-size:16px;font-weight:600}
  p{margin:0 0 14px;color:#8b94a3;font-size:12.5px}
  input{width:100%;box-sizing:border-box;height:38px;padding:0 12px;border-radius:9px;
    border:1px solid #2c3442;background:#0d1117;color:#dfe4ec;font-size:13px;font-family:ui-monospace,monospace}
  button{margin-top:10px;width:100%;height:38px;border:0;border-radius:9px;background:#2f6feb;color:#fff;
    font-size:13px;cursor:pointer}
  code{color:#9fb3d1;word-break:break-all}
</style></head><body><div class="box">
<h1>这台机器只认带令牌的访问</h1>
<p>令牌在启动它的那台电脑上：<code>${safe}</code></p>
<form method="GET" action="/">
  <input name="token" placeholder="粘贴令牌" autocomplete="off" autofocus>
  <button type="submit">进入</button>
</form>
<p style="margin:14px 0 0">在服务端窗口里能看到带令牌的完整地址；也可以设 <code>MA_TOKEN</code> 自己指定。</p>
</div></body></html>`;
}
