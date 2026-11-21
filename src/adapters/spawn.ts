// 起进程、收输出、超时杀、按需取消。不认识具体是哪家 CLI，只按表里的策略办事。
import { spawn, spawnSync } from 'node:child_process';
import { providerOf, type RunOpts } from './table.ts';
import { readUsage, type Usage } from './usage.ts';

export type RunResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  ms: number;
  killed: boolean;
  /** 用户主动取消。和超时被杀区分开，前者不该重试 */
  canceled: boolean;
  /** 这一轮的真实 token 用量；拿不到就是 undefined，不估算 */
  usage?: Usage | null;
};

const MAX_STDOUT = 4 * 1024 * 1024;
const MAX_STDERR = 64 * 1024;

export function runAgent(name: string, opts: RunOpts): Promise<RunResult> {
  const p = providerOf(name);
  const argv = p.args(opts);
  return spawnAgent(p.bin(), argv, p.stdin ? opts.prompt : null, opts);
}

/**
 * Windows 上 child.kill('SIGKILL') 只杀直接子进程。
 * codebuddy 是 node，它自己会再起 shell，孙进程会活下来继续写工作区。
 * taskkill /T 按进程树杀，比 P/Invoke 简单，也够用。
 */
export function killTree(pid: number | undefined): void {
  if (!pid) return;
  if (process.platform === 'win32') {
    try {
      spawnSync('taskkill', ['/T', '/F', '/PID', String(pid)], { windowsHide: true, stdio: 'ignore' });
    } catch {}
    return;
  }
  // 非 Windows：先试进程组（需要 detached），再退回单进程
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {}
  }
}

function spawnAgent(
  bin: string,
  argv: string[],
  stdinText: string | null,
  opts: RunOpts,
): Promise<RunResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    let killed = false;
    let canceled = false;
    let settled = false;

    const child = spawn(process.execPath, [bin, ...argv], {
      cwd: opts.cwd,
      stdio: [stdinText === null ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let out = '';
    let err = '';
    child.stdout?.on('data', (d: Buffer) => {
      // 保留「末尾」而不是「开头」：回执在输出的最后，截掉尾巴等于把结论丢了。
      // 滚动窗口让内存最多约两倍上限，收尾时再裁到一倍。
      out += d.toString('utf8');
      if (out.length > MAX_STDOUT * 2) out = out.slice(-MAX_STDOUT);
    });
    child.stderr?.on('data', (d: Buffer) => {
      err += d.toString('utf8');
      if (err.length > MAX_STDERR * 2) err = err.slice(-MAX_STDERR);
    });
    if (stdinText !== null) {
      child.stdin?.on('error', () => {});
      child.stdin?.end(stdinText, 'utf8');
    }

    // 取消要先于超时判断，否则外部点了停止却记成「超时被杀」
    const onAbort = () => {
      if (settled) return;
      canceled = true;
      killTree(child.pid);
    };
    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener('abort', onAbort, { once: true });
    }

    const timer = setTimeout(() => {
      killed = true;
      killTree(child.pid);
    }, opts.timeoutMs);

    const done = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      resolve({
        exitCode: code ?? -1,
        stdout: out.length > MAX_STDOUT ? out.slice(-MAX_STDOUT) : out,
        stderr: err.length > MAX_STDERR ? err.slice(-MAX_STDERR) : err,
        ms: Date.now() - started,
        killed,
        canceled,
        // 进程结束了才能从会话日志里读到这一轮的用量；读不到就是 null
        usage: readUsage(opts.cwd, started),
      });
    };
    child.on('close', done);
    child.on('error', (e) => {
      err += String(e);
      done(-1);
    });
  });
}
