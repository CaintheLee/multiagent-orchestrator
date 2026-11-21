// 最小 TOML 读取：只认 `[section]`、`key = 值`、`#` 注释。
// 够用就行，不引依赖；遇到不认识的写法直接报错，不猜。
import fs from 'node:fs';
import path from 'node:path';

type Cell = string | number | boolean;
type Raw = Record<string, Record<string, Cell>>;

export type NodeConfig = {
  id: string;
  parent: string;
  name: string;
  plugin: string;
  workspace: string;
  timeoutMin: number;
  access: string;
  role: string;
  model: string;
  /**
   * 允许写的工作区之外目录（绝对路径）。
   *
   * 为什么要有：主控经常需要把成果落到 D:/YourProject\docs 这类共享位置，
   * 一刀切「只能写工作区」会让它整轮白跑（#40 就是这么废的）。
   * 代价是隔离被削弱，所以落在这些目录里的产物必须复制一份备份回工作区，
   * 备份不成直接判失败——宁可报错，也不要交出一个续跑时找不到的产物。
   */
  extraDirs: string[];
  /** 运行时派生出来的临时节点：只活在本次任务里，不写回 agents.toml */
  spawned?: boolean;
};

/** 逗号或分号分隔的目录列表 */
function splitDirs(v: string): string[] {
  return v.split(/[,;]/).map((s) => s.trim()).filter(Boolean);
}

/** 树的规模上限：节点太多，主控一轮的提示词就装不下了 */
export const MAX_NODES = 48;

/**
 * 项目元信息。
 *
 * 为什么抽出来：MultiAgent 是通用编排器，某个具体项目只是第一个拿它做实验的对象。
 * 名字和根目录不该写死在代码里，否则换一个项目就得改源码。
 * root 是「干活的目录」（比如游戏工程），和 sandbox 根（MultiAgent 自己的 .sandbox）不是一回事。
 */
export type ProjectInfo = {
  name: string;
  /** 项目根目录的绝对路径；留空表示"没有绑定具体项目"，对话会退回进程目录 */
  root: string;
};

/**
 * 通知配置。
 *
 * 只认一个或多个 webhook，按地址形态自动适配格式（见 kernel/notify.ts）。
 * on 决定哪些终态值得打扰，默认 blocked / failed / done。
 */
export type NotifyTarget = {
  /** webhook 地址；企业微信群机器人 / Server酱 / PushPlus / 自建服务都行 */
  webhook: string;
  /** 给这个通道起个名字，日志里好认 */
  name?: string;
};

export type NotifySettings = {
  targets: NotifyTarget[];
  /** 要通知的终态；空 = 默认三样 */
  on: string[];
};

export const DEFAULT_NOTIFY_ON = ['blocked', 'failed', 'done'];

/**
 * 运行上限：不是「能不能做」，而是「最多花多少」。
 *
 * 之前只有轮次预算（每段 +3），它能防「原地打转」，防不了「一轮烧掉几十万 token」。
 * 这里给三个可配的闸门，0 表示不限。
 */
export type Limits = {
  /** 全机车位：同时跑几个 CLI 进程。和任务内车道共用同一个池 */
  concurrency: number;
  /** 单任务 token 上限；超了就停在轮次边界，任务转 blocked 等人决定 */
  maxTokens: number;
  /** 单任务时长上限（分钟），从任务开始算；0 = 不限 */
  maxMinutes: number;
  /**
   * 任务失败后要不要再跑一轮「诊断」。
   * 关掉能省一次调用；开着失败时不用自己翻日志找原因。
   */
  diagnose: boolean;
};

export const DEFAULT_LIMITS: Limits = { concurrency: 3, maxTokens: 0, maxMinutes: 0, diagnose: true };

export type Config = {
  schema: number;
  nodes: NodeConfig[];
  root: NodeConfig;
  maxSummary: number;
  maxDetail: number;
  /**
   * 开线（派生）的审批策略与默认参数。
   * 可选：老配置文件没有 [spawn] 段，读出来就是 undefined，用 DEFAULT_SPAWN 兜底。
   */
  spawn?: SpawnSettings;
  /** 这个实例服务的是哪个项目。可选，理由同 spawn */
  project?: ProjectInfo;
  /** 运行上限。可选：老配置没有 [limits] 段，用 DEFAULT_LIMITS */
  limits?: Limits;
  /** 通知通道。可选：没有 [notify] 段就只走站内 */
  notify?: NotifySettings;
};

/**
 * 开线策略。两个开关互相独立：
 * - autoApprove：跳过人工审批，主控自己批（省一步，但没人把关）
 * - defaultsEnabled：审批时用这套默认值预填，人只需改要改的字段
 *
 * 两个都关 = 老行为（每条开线都停下来等人，参数由模型给）。
 * 两个都开 = 全自动开线，参数按这套标准。
 */
export type SpawnSettings = {
  autoApprove: boolean;
  defaultsEnabled: boolean;
  role: string;
  /** 空字符串表示继承主控的模型 */
  model: string;
  timeoutMin: number;
  access: 'read' | 'write';
  /** 批准时拼在任务前面的固定要求，比如「只读梳理，不改任何源文件」 */
  taskPrefix: string;
};

export const DEFAULT_SPAWN: SpawnSettings = {
  autoApprove: false,
  defaultsEnabled: false,
  role: 'executor',
  model: '',
  timeoutMin: 30,
  access: 'write',
  taskPrefix: '',
};

function parseValue(raw: string): Cell {
  const v = raw.trim();
  if (v.startsWith('"') && v.endsWith('"')) {
    // 还原 \" 和 \\：界面保存走 JSON.stringify，Windows 路径会写成 D:/YourProject\\docs，
    // 不还原的话读回来是两个反斜杠。能跑，但显示和排错时看着像错的
    return v.slice(1, -1).replace(/\\(["\\])/g, '$1');
  }
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  throw new Error(`看不懂这个值：${raw}`);
}

export function parseToml(text: string): Raw {
  const out: Raw = {};
  let section = '';
  text.split(/\r?\n/).forEach((line, i) => {
    const s = line.trim();
    if (!s || s.startsWith('#')) return;
    const head = /^\[([^\]]+)\]$/.exec(s);
    if (head) {
      section = head[1].trim();
      // 重复的 section 不能静默覆盖：手改配置时多写一段 [agent.b]，
      // 后面那段会把前面整段顶掉，看起来"改完了没生效"最难查
      if (out[section]) throw new Error(`第 ${i + 1} 行：[${section}] 出现了两次`);
      out[section] = {};
      return;
    }
    const kv = /^([A-Za-z0-9_]+)\s*=\s*(.+)$/.exec(s);
    if (!kv) throw new Error(`第 ${i + 1} 行不是 key = value：${line}`);
    out[section] ||= {};
    out[section][kv[1]] = parseValue(kv[2]);
  });
  return out;
}

function str(cell: Record<string, Cell> | undefined, key: string, dflt = ''): string {
  const v = cell?.[key];
  return typeof v === 'string' ? v : dflt;
}

function num(cell: Record<string, Cell> | undefined, key: string, dflt: number): number {
  const v = cell?.[key];
  return typeof v === 'number' ? v : dflt;
}

/** 超时写 0 或负数会让 setTimeout 立刻触发，轮次秒挂；写 9999 则等于永不超时。两头都夹住 */
function clampMin(v: number): number {
  if (!Number.isFinite(v)) return 10;
  return Math.min(120, Math.max(1, Math.round(v)));
}

export function loadConfig(file: string): Config {
  const raw = parseToml(fs.readFileSync(file, 'utf8'));
  const top = raw[''];
  const rootRaw = raw.root;
  if (!rootRaw) throw new Error('agents.toml 里没有 [root]');

  const mk = (c: Record<string, Cell>, isRoot: boolean): NodeConfig => {
    const id = str(c, 'id');
    if (!id) throw new Error(isRoot ? '[root] 缺少 id' : '有个 [agent.*] 缺少 id');
    const parent = str(c, 'parent');
    if (!isRoot && !parent) throw new Error(`节点 ${id} 缺少 parent`);
    if (isRoot && parent) throw new Error('根节点不能有 parent');
    if (!isRoot && str(c, 'extra_dirs')) {
      // 只支持写在 [root] 里当全局设置。允许逐节点写的话，界面保存时会被覆盖掉，
      // 变成「改了一个节点，重启后悄悄失效」，比直接报错难查得多
      throw new Error(`节点 ${id} 不支持 extra_dirs，请写在 [root] 里（全局生效）`);
    }
    return {
      id,
      parent,
      name: str(c, 'name', id),
      plugin: str(c, 'plugin', 'codex'),
      workspace: str(c, 'workspace'),
      timeoutMin: clampMin(num(c, 'timeout_min', 10)),
      access: str(c, 'access', 'write'),
      role: str(c, 'role', 'executor'),
      model: str(c, 'model', ''),
      extraDirs: splitDirs(str(c, 'extra_dirs')),
    };
  };

  const root = mk(rootRaw, true);
  if (!root.workspace) throw new Error('[root] 缺少 workspace');

  const nodes = [root];
  for (const key of Object.keys(raw)) {
    if (!key.startsWith('agent.')) continue;
    // 段名就是节点 id，省得两处写重了不一致
    const segId = key.slice('agent.'.length);
    const cell = { ...raw[key] };
    if (!cell.id) cell.id = segId;
    const n = mk(cell, false);
    if (!n.workspace) throw new Error(`节点 ${n.id} 缺少 workspace`);
    if (nodes.some((x) => x.id === n.id)) throw new Error(`节点 id 重复：${n.id}`);
    nodes.push(n);
  }
  for (const n of nodes) {
    // 没单独写的节点继承 [root] 的，省得六个节点各写一遍、改的时候漏一个
    if (n.id !== root.id && !n.extraDirs.length) n.extraDirs = [...root.extraDirs];
    // 只认绝对路径：相对路径在不同 cwd 下指向不同地方，等于没约束
    n.extraDirs = n.extraDirs.map((d) => {
      if (!path.isAbsolute(d)) {
        throw new Error(`节点 ${n.id} 的 extra_dirs 必须是绝对路径：${d}`);
      }
      return path.resolve(d);
    });
    if (n.parent && !nodes.some((x) => x.id === n.parent)) {
      throw new Error(`节点 ${n.id} 的 parent「${n.parent}」不存在`);
    }
    // 自己当自己的上级：派活时会派给自己，白烧一整轮预算才被守门员叫停
    if (n.parent && n.parent === n.id) {
      throw new Error(`节点 ${n.id} 的 parent 指向自己`);
    }
  }

  // 从根走一遍，确认每个节点都够得着。够不着的（成环或断链）永远不会被执行，
  // 但在界面上看着像活着，比报错更难查
  const reachable = new Set<string>([root.id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const n of nodes) {
      if (reachable.has(n.id)) continue;
      if (n.parent && reachable.has(n.parent)) {
        reachable.add(n.id);
        grew = true;
      }
    }
  }
  const orphans = nodes.filter((n) => !reachable.has(n.id)).map((n) => n.id);
  if (orphans.length) {
    throw new Error(`这些节点从根 ${root.id} 走不到（parent 成环或指错）：${orphans.join('、')}`);
  }

  /**
   * [notify] 段：webhook 可以写多个（webhook、webhook2、webhook3），
   * 也可以写成 targets = "url1, url2"。两种都认，省得人为了加第二条改结构。
   */
  const parseNotify = (sec: Record<string, Cell> | undefined): NotifySettings | undefined => {
    if (!sec) return undefined;
    const urls: string[] = [];
    for (const [k, v] of Object.entries(sec)) {
      if (!/^webhook\d*$/.test(k)) continue;
      const s = String(v || '').trim();
      if (!s) continue;
      if (k === 'webhook' && /[,;\s]/.test(s)) {
        urls.push(...s.split(/[,;\s]+/).filter(Boolean));
      } else {
        urls.push(s);
      }
    }
    if (!urls.length) return undefined;
    const onRaw = String(sec.on || '').trim();
    return {
      targets: urls.map((u, i) => ({ webhook: u, name: 'ch' + (i + 1) })),
      on: onRaw ? onRaw.split(/[,;\s]+/).filter(Boolean) : [...DEFAULT_NOTIFY_ON],
    };
  };

  const lim = raw.limits;
  const limitInt = (key: string, def: number, lo: number, hi: number): number => {
    const v = Number(lim?.[key]);
    if (!Number.isFinite(v)) return def;
    return Math.min(hi, Math.max(lo, Math.round(v)));
  };

  /** 通用的 true/1/'true' 判定，[spawn] 与 [limits] 共用 */
  const flagOf = (sec: Record<string, Cell> | undefined, key: string): boolean => {
    const v = sec?.[key];
    return v === true || v === 1 || String(v) === 'true';
  };
  const sp = raw.spawn;
  const flag = (key: string): boolean => {
    const v = sp?.[key];
    return v === true || v === 1 || String(v) === 'true';
  };
  return {
    schema: num(top, 'schema', 1),
    nodes,
    root,
    project: {
      name: str(raw.project, 'name', '未命名项目') || '未命名项目',
      root: str(raw.project, 'root', ''),
    },
    maxSummary: num(raw.protocol, 'max_summary', 200),
    maxDetail: num(raw.protocol, 'max_detail', 4000),
    notify: parseNotify(raw.notify),
    limits: {
      // 车位上限压到 16：再多就是本机 CPU 和模型限流先撑不住
      concurrency: limitInt('concurrency', DEFAULT_LIMITS.concurrency, 1, 16),
      maxTokens: limitInt('max_tokens', 0, 0, 100_000_000),
      maxMinutes: limitInt('max_minutes', 0, 0, 24 * 60),
      // 默认开：失败时人最需要的就是「为什么」；写 false 可关
      diagnose: lim?.diagnose === undefined ? true : flagOf(lim, 'diagnose'),
    },
    spawn: {
      autoApprove: flag('auto_approve'),
      defaultsEnabled: flag('defaults_enabled'),
      role: str(sp, 'role', DEFAULT_SPAWN.role) || DEFAULT_SPAWN.role,
      model: str(sp, 'model', ''),
      timeoutMin: clampMin(num(sp, 'timeout_min', DEFAULT_SPAWN.timeoutMin)),
      access: str(sp, 'access', DEFAULT_SPAWN.access) === 'read' ? 'read' : 'write',
      taskPrefix: str(sp, 'task_prefix', ''),
    },
  };
}

/** 把配置写回 agents.toml。先写 .tmp 再 rename，中途崩不会留下半个文件 */
export function saveConfig(cfg: Config, file: string): void {
  const q = (v: string | number) => (typeof v === 'number' ? String(v) : JSON.stringify(String(v)));
  const line = (k: string, v: string | number | undefined) => (v === undefined || v === '' ? '' : `${k} = ${q(v)}\n`);
  const out: string[] = ['# 这个文件由界面改写。手改也可以，格式只认 key = value 和 [section]\n'];
  out.push(`schema = ${cfg.schema}\n\n`);
  out.push('[protocol]\n');
  out.push(`max_summary = ${cfg.maxSummary}\n`);
  out.push(`max_detail = ${cfg.maxDetail}\n\n`);
  // 这个实例服务哪个项目。写在节点段之前，人打开配置第一眼就看到
  out.push('[project]\n');
  out.push(line('name', cfg.project?.name));
  out.push(line('root', cfg.project?.root));
  out.push('\n');
  // 通知：一个通道一行，人改起来最直观
  const nt = cfg.notify;
  if (nt?.targets?.length) {
    out.push('[notify]\n');
    nt.targets.forEach((t, i) => {
      out.push(`webhook${i === 0 ? '' : i + 1} = ${JSON.stringify(t.webhook)}\n`);
    });
    out.push(`on = ${JSON.stringify((nt.on?.length ? nt.on : DEFAULT_NOTIFY_ON).join(','))}\n`);
    out.push('\n');
  }
  // 运行上限
  const lim = cfg.limits ?? DEFAULT_LIMITS;
  out.push('[limits]\n');
  out.push(`concurrency = ${lim.concurrency}\n`);
  out.push(`max_tokens = ${lim.maxTokens}\n`);
  out.push(`max_minutes = ${lim.maxMinutes}\n`);
  out.push(`diagnose = ${lim.diagnose ? 'true' : 'false'}\n`);
  out.push('\n');
  // 开线策略：两个开关写死成 true/false（不用 1/0），手改配置时一眼能看懂
  const sp = cfg.spawn ?? DEFAULT_SPAWN;
  out.push('[spawn]\n');
  out.push(`auto_approve = ${sp.autoApprove ? 'true' : 'false'}\n`);
  out.push(`defaults_enabled = ${sp.defaultsEnabled ? 'true' : 'false'}\n`);
  out.push(line('role', sp.role));
  out.push(line('model', sp.model));
  out.push(`timeout_min = ${sp.timeoutMin}\n`);
  out.push(line('access', sp.access));
  out.push(line('task_prefix', sp.taskPrefix));
  out.push('\n');
  const block = (n: NodeConfig, section: string) => {
    out.push(`[${section}]\n`);
    out.push(line('id', n.id));
    out.push(line('parent', n.parent));
    out.push(line('name', n.name));
    out.push(line('plugin', n.plugin));
    out.push(line('workspace', n.workspace));
    out.push(line('timeout_min', n.timeoutMin));
    out.push(line('access', n.access));
    out.push(line('role', n.role));
    out.push(line('model', n.model));
    // 继承来的不写回去：写回去之后 root 再改，子节点就永久钉在旧值上了
    if (n.extraDirs.length && n.id === cfg.root.id) {
      out.push(line('extra_dirs', n.extraDirs.join(', ')));
    }
    out.push('\n');
  };
  block(cfg.root, 'root');
  for (const n of cfg.nodes) {
    if (n.id === cfg.root.id) continue;
    block(n, 'agent.' + n.id);
  }
  const body = out.join('');
  // 临时名带 pid + 随机后缀：固定 .tmp 在并发写时会互相踩（一个 rename 掉另一个的文件）
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  try {
    fs.writeFileSync(tmp, body, 'utf8');
    // 写完先自己读一遍，确认还能解析——写坏的配置比不写更糟
    parseToml(body);
    fs.renameSync(tmp, file);
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // 没写成功就没有临时文件，忽略
    }
    throw e;
  }
}

export function childrenOf(cfg: Config, id: string): NodeConfig[] {
  return cfg.nodes.filter((n) => n.parent === id);
}

/**
 * 一个任务一个根：同一个节点被两个任务同时用，产物不能落在同一个目录。
 * 配置里写短名（如 "b"）就按任务隔离；写绝对路径当老配置，原样用。
 */
/** 短名：只能由字母数字下划线连字符组成。它会被直接拼进路径，所以不能放任何分隔符 */
const SAFE_NAME = /^[a-z0-9][a-z0-9_-]{0,15}$/i;

export function resolveWorkspace(node: NodeConfig, taskId: number, root: string): string {
  const raw = node.workspace.trim();
  if (!raw) throw new Error(`节点 ${node.id} 的 workspace 是空的`);

  // 绝对路径：配置里写死的位置，允许（兼容老配置）
  if (path.isAbsolute(raw)) return raw;

  // 相对路径和带分隔符的一律拒绝。
  // 旧实现是「含斜杠就原样返回」，于是 workspace = "../x" 能跑出 .sandbox，
  // 两个节点也能指向同一个目录——lane 按节点串行，却会并发写同一份文件。
  if (!SAFE_NAME.test(raw)) {
    throw new Error(
      `节点 ${node.id} 的 workspace「${raw}」不安全：短名只能用字母、数字、下划线、连字符（1–16 位）。` +
        ` 要指定固定目录，请写成绝对路径。`,
    );
  }
  return path.join(root, '.sandbox', `t${taskId}`, raw);
}

/** 配置用短名还是绝对路径，决定能不能并发 */
export function workspaceIsIsolated(node: NodeConfig): boolean {
  const raw = node.workspace.trim();
  if (!raw || path.isAbsolute(raw)) return false;
  return SAFE_NAME.test(raw);
}

export function nodeById(cfg: Config, id: string): NodeConfig {
  const n = cfg.nodes.find((x) => x.id === id);
  if (!n) throw new Error(`没有这个节点：${id}（现有 ${cfg.nodes.map((x) => x.id).join(', ')}）`);
  return n;
}
