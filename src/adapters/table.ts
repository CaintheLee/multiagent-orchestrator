// 每个 CLI 一条记录：可执行文件在哪、参数怎么拼、提示词走 stdin 还是 argv。
// 加一个新 CLI 只改这张表，不动调用代码。
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { parseToml } from '../kernel/tree.ts';

export type RunOpts = {
  prompt: string;
  cwd: string;
  timeoutMs: number;
  access: string;
  model?: string;
  /** 外部取消：触发后按进程树杀掉，并标记 canceled */
  signal?: AbortSignal;
};

export type Provider = {
  label: string;
  /** 被 node 执行的那个脚本 */
  bin: () => string;
  args: (o: RunOpts) => string[];
  /** true：提示词走 stdin；false：拼进 argv */
  stdin: boolean;
  /**
   * 这个 provider 的参数是否在本机实测过。
   *
   * 为什么要这个字段：四家里只有 codebuddy / codex 装在这台机器上，
   * 另外两家的参数是照各自的命令行约定写的，没跑过。不标出来，
   * 换台机器接 claude 失败时会以为是编排器的问题，其实是参数没对。
   * doctor 会把它显示出来。
   */
  verified?: boolean;
  /**
   * 运行时问这个 CLI「现在支持哪些模型」。没有这个方法就说明拿不到，
   * 调用方退回缓存或内置兜底，绝不用写死的列表冒充实时结果。
   */
  models?: () => Promise<string[]>;
  /**
   * 这个 CLI 有没有**真正**的只读模式。
   * 有（codex 的 --sandbox read-only）才允许节点配 access="read"；
   * 没有的（codebuddy 的 -y 参数与 write 完全一致）必须拒绝，不能静默等同 write。
   */
  supportsReadOnly?: boolean;
};

/** 跑一次 CLI 的 --help，拿 stdout。超时就杀，不能让它拖住 hub 启动 */
function helpText(bin: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [bin, '--help'],
      { timeout: 15_000, windowsHide: true, maxBuffer: 2 * 1024 * 1024 },
      (err, stdout) => {
        // --help 有时会先报一条配置拉取失败的 stderr，但 stdout 仍是完整帮助；
        // 只要有输出就按成功处理，免得把可用列表一起判死
        if (stdout && stdout.trim()) resolve(stdout);
        else reject(err ?? new Error('--help 没有输出'));
      },
    );
  });
}

/** 从 --help 里抠出 `Currently supported: (a, b, c)` */
export function parseSupportedModels(help: string): string[] {
  const m = /Currently supported:\s*\(([^)]+)\)/i.exec(help);
  if (!m) return [];
  return m[1]
    .split(',')
    .map((s) => s.trim())
    .filter((s) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(s));
}

/**
 * 当前 node 所在目录。CLI 通常装在同一套 node 的 node_modules 里，
 * 所以先从这里找；找不到再沿 PATH 找。
 * 以前这里写死了某个人的安装路径——既不可移植，也把用户名带进了仓库。
 */
const NODE_DIR = path.dirname(process.execPath);

/**
 * 沿 PATH 的每个目录找 `node_modules/<rel>`。
 * 为什么不直接找 `codebuddy.cmd`：起进程用的是 `node <脚本>`，
 * 拿到 .cmd 壳子没法用 node 执行，必须定位到真正的 JS 入口。
 */
function inPathNodeModules(rel: string): string[] {
  const out: string[] = [];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    out.push(path.join(dir, 'node_modules', rel));
  }
  return out;
}

/** 环境变量优先，其次在常见安装位置里找，都不在就给一条能照着改的错误 */
function locate(envVar: string, candidates: string[], label: string): string {
  const fromEnv = process.env[envVar];
  if (fromEnv) {
    if (!fs.existsSync(fromEnv)) throw new Error(`${envVar} 指向的文件不存在：${fromEnv}`);
    return fromEnv;
  }
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  throw new Error(
    `找不到 ${label} 的可执行文件。试过这些位置：\n` +
      candidates.map((c) => '  · ' + c).join('\n') +
      `\n用环境变量 ${envVar} 指定实际路径即可。`,
  );
}

const codexBin = () =>
  locate('MA_CODEX', [
    ...inPathNodeModules('@openai/codex/bin/codex.js'),
    `${NODE_DIR}/node_modules/@openai/codex/bin/codex.js`,
    `${process.env.APPDATA || ''}/npm/node_modules/@openai/codex/bin/codex.js`,
  ], 'Codex');

const codebuddyBin = () =>
  locate('MA_CODEBUDDY', [
    ...inPathNodeModules('@tencent-ai/codebuddy-code/bin/codebuddy'),
    `${NODE_DIR}/node_modules/@tencent-ai/codebuddy-code/bin/codebuddy`,
    `${process.env.APPDATA || ''}/npm/node_modules/@tencent-ai/codebuddy-code/bin/codebuddy`,
  ], 'CodeBuddy');

const claudeBin = () =>
  locate('MA_CLAUDE', [
    ...inPathNodeModules('@anthropic-ai/claude-code/cli.js'),
    `${process.env.APPDATA || ''}/npm/node_modules/@anthropic-ai/claude-code/cli.js`,
    `${process.env.LOCALAPPDATA || ''}/Programs/claude/claude.exe`,
  ], 'Claude Code');

const geminiBin = () =>
  locate('MA_GEMINI', [
    ...inPathNodeModules('@google/gemini-cli/dist/index.js'),
    `${process.env.APPDATA || ''}/npm/node_modules/@google/gemini-cli/dist/index.js`,
    `${NODE_DIR}/node_modules/@google/gemini-cli/dist/index.js`,
  ], 'Gemini CLI');

export const PROVIDERS: Record<string, Provider> = {
  codex: {
    label: 'Codex',
    bin: codexBin,
    // 提示词作为 argv 传（含换行和反引号）会让 codex 静默卡死，必须走 stdin
    args: (o) => ['exec', '--skip-git-repo-check', '--sandbox', o.access === 'read' ? 'read-only' : 'workspace-write'],
    stdin: true,
    supportsReadOnly: true,
    verified: true,
  },
  codebuddy: {
    label: 'CodeBuddy',
    bin: codebuddyBin,
    args: (o) => ['-p', '-y', ...(o.model ? ['--model', o.model] : []), o.prompt],
    stdin: false,
    verified: true,
    // 模型清单只认 CLI 自己报的：写死的列表会随服务端下线而失真（hy4free 就是这么没的）
    models: async () => {
      const list = parseSupportedModels(await helpText(codebuddyBin()));
      if (!list.length) throw new Error('codebuddy --help 里没有 Currently supported');
      return list;
    },
  },
  // 下面两个是「装了就能用」的条目，本机没装也不会影响别的 provider：
  // 找不到可执行文件时 runOnce 会把它当作起进程失败，记一轮 failed 并说明原因。
  claude: {
    label: 'Claude Code',
    bin: claudeBin,
    // -p 是非交互打印模式，--model 是模型选择：两条都是它的长期约定。
    // **未在本机实测**（这台机器没装），所以 verified 留空、supportsReadOnly 不给。
    // 如果确认它支持 `--permission-mode plan`，把 supportsReadOnly 改成 true 并加进 args——
    // plan 模式真的会拒绝写盘，和 codebuddy 的 plan 一样，不是装饰。
    args: (o) => ['-p', ...(o.model ? ['--model', o.model] : []), o.prompt],
    stdin: false,
  },
  gemini: {
    label: 'Gemini CLI',
    bin: geminiBin,
    // 同上：-p / --model 是它的约定，未在本机实测。
    // 它的沙箱是 --sandbox（docker/podman），不是只读开关，所以不给 supportsReadOnly。
    args: (o) => ['-p', ...(o.model ? ['--model', o.model] : []), o.prompt],
    stdin: false,
  },
};

export function providerOf(name: string): Provider {
  const p = PROVIDERS[name];
  if (!p) {
    throw new Error(`不认识的 plugin：${name}。可选：${Object.keys(PROVIDERS).join('、')}`);
  }
  return p;
}

/**
 * 这个 provider 能不能强制只读。
 *
 * 不能的话，界面上那个 access="read" 只是装饰：CLI 照样拿 -y 跑，照样写盘。
 * 与其让审批时看到「只读」以为是约束，不如明确拒绝（外部审计 M3）。
 */
export function supportsReadOnly(name: string): boolean {
  return PROVIDERS[name]?.supportsReadOnly === true;
}

export function providerNames(): string[] {
  return Object.keys(PROVIDERS);
}

/**
 * 从 providers.toml 注册自定义 CLI，不改代码接新 agent。
 *
 * 为什么用配置文件而不是继续往表里写死：每加一个 CLI 就要改一次源码、跑一次测试，
 * 而这件事实质上只是「可执行文件 + 参数模板」。配置能覆盖的部分不该占代码。
 *
 * 格式（最小 TOML，只认标量）：
 *   [provider.mytool]
 *   label = "My Tool"
 *   bin   = "C:/tools/mytool.exe"
 *   args  = "-p --model {model} {prompt}"   # 空格分隔；{prompt} 整体替换，不会被再拆
 *   stdin = false                            # true：提示词走 stdin，args 里不用写 {prompt}
 */
const CUSTOM_NAME = /^[a-z0-9][a-z0-9_-]{0,19}$/i;

export function registerProvidersFrom(file: string): string[] {
  if (!fs.existsSync(file)) return [];
  const raw = parseToml(fs.readFileSync(file, 'utf8'));
  const added: string[] = [];
  for (const [section, cell] of Object.entries(raw)) {
    if (!section.startsWith('provider.')) continue;
    const name = section.slice('provider.'.length);
    if (!CUSTOM_NAME.test(name)) {
      throw new Error(`providers.toml 里的 provider 名「${name}」不合法：1–20 位字母数字下划线连字符`);
    }
    const bin = typeof cell.bin === 'string' ? cell.bin.trim() : '';
    if (!bin) throw new Error(`providers.toml 的 [provider.${name}] 缺 bin`);
    const tpl = typeof cell.args === 'string' ? cell.args.trim() : '';
    const stdin = cell.stdin === true;
    PROVIDERS[name] = {
      label: typeof cell.label === 'string' ? cell.label : name,
      bin: () => {
        if (!fs.existsSync(bin)) {
          throw new Error(`providers.toml 里 [provider.${name}] 的 bin 不存在：${bin}`);
        }
        return bin;
      },
      // stdin 模式只是「提示词不走 argv」，参数模板照旧生效（里面一般不写 {prompt}）
      args: (o) => (!tpl ? [] : tpl.split(/\s+/).filter(Boolean).map((t) => t
        .split('{prompt}').join(o.prompt)
        .split('{model}').join(o.model ?? ''))),
      stdin,
      // 配置里声明的 provider 一律算「未实测」：它可能只是个包装脚本
    };
    added.push(name);
  }
  return added;
}
