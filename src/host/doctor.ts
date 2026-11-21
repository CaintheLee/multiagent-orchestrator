import { SANDBOX_ROOT } from '../kernel/paths.ts';
// 环境自检：在花钱跑任务之前，把「一定会失败」的事先挑出来。
//
// 起因很实际：provider 路径不对、role 文件拼错、.data 不可写，
// 这些都要跑到一半才报，报出来还藏在某轮日志里。doctor 一次全查完，零成本。
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { loadConfig, resolveWorkspace, workspaceIsIsolated, MAX_NODES } from '../kernel/tree.ts';
import { providerOf, supportsReadOnly } from '../adapters/table.ts';
import { getModels, modelKnown } from '../adapters/models.ts';
import { openDB } from '../store/db.ts';

export type Level = 'ok' | 'warn' | 'fail';
export type Item = { level: Level; title: string; detail?: string };

/** 端口有没有人占：只连一下，不发数据 */
function portBusy(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port });
    const done = (v: boolean) => { s.destroy(); resolve(v); };
    s.setTimeout(400, () => done(false));
    s.on('connect', () => done(true));
    s.on('error', () => done(false));
  });
}

function firstLine(e: unknown): string {
  const s = e instanceof Error ? e.message : String(e);
  return s.split('\n')[0].slice(0, 160);
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export async function runDoctor(root = SANDBOX_ROOT, port = 3400): Promise<{ items: Item[]; ok: boolean }> {
  const items: Item[] = [];
  const add = (level: Level, title: string, detail?: string) => items.push({ level, title, detail });

  // 1. Node 版本（engines 写的是 >=22.6，低于这个 type stripping 跑不起来）
  const [maj, min] = process.versions.node.split('.').map(Number);
  if (maj > 22 || (maj === 22 && min >= 6)) add('ok', `Node ${process.versions.node}`);
  else add('fail', `Node ${process.versions.node} 太旧`, '需要 >= 22.6（原生跑 .ts）');

  // 2. agents.toml
  const cfgFile = path.join(root, 'agents.toml');
  let cfg;
  if (!fs.existsSync(cfgFile)) {
    add('fail', 'agents.toml 不存在', cfgFile);
  } else {
    try {
      cfg = loadConfig(cfgFile);
      add('ok', `agents.toml 可解析：${cfg.nodes.length} 个节点，根是 ${cfg.root.id}`);
      if (cfg.nodes.length >= MAX_NODES) {
        add('warn', `节点数 ${cfg.nodes.length} 已到上限 ${MAX_NODES}`);
      }
      if (cfg.nodes.length > 8) {
        add('warn', `节点有 ${cfg.nodes.length} 个`, '主控每轮提示词会很长，确认这是必要的');
      }
    } catch (e) {
      add('fail', 'agents.toml 解析失败', firstLine(e));
    }
  }

  // 3. 每个节点的 provider / role / 工作区
  if (cfg) {
    const plugins = [...new Set(cfg.nodes.map((n) => n.plugin))];
    for (const p of plugins) {
      try {
        const prov = providerOf(String(p));
        const bin = prov.bin();
        // 把「实测过没有、能不能真只读」摊开：这两项决定了换机器时会不会踩坑
        const tags: string[] = [];
        tags.push(prov.verified ? '参数已实测' : '参数未在本机验证');
        tags.push(prov.supportsReadOnly ? '支持真只读' : '无只读模式');
        add('ok', `provider ${p} → ${bin}`, tags.join(' · '));
      } catch (e) {
        add(
          'fail',
          `provider ${p} 不可用`,
          firstLine(e) + '｜装好后用 MA_' + String(p).toUpperCase() + ' 指定路径，或换掉这个节点的 plugin',
        );
      }
    }

    // access="read" 必须真的能只读。不能只读的 provider 生成的参数和 write 一样，
    // 界面上写着「只读」会让人误以为有约束（外部审计 M3）。
    for (const n of cfg.nodes) {
      if (n.access === 'read' && !supportsReadOnly(n.plugin)) {
        add('warn', `节点 ${n.id} 的 access="read" 无效`, `${n.plugin} 没有只读模式，实际按 write 跑；改成 write 或换 codex`);
      }
    }

    const roles = [...new Set(cfg.nodes.map((n) => n.role))];    for (const r of roles) {
      if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(String(r))) {
        add('fail', `role「${r}」不合法`, '只能是字母数字下划线连字符；不修会退化成默认角色');
        continue;
      }
      const f = path.join(root, 'prompts', r + '.md');
      if (fs.existsSync(f)) add('ok', `role ${r} → prompts/${r}.md`);
      else add('warn', `role ${r} 没有提示词文件`, `会退化成内置兜底；要定制就建 prompts/${r}.md`);
    }

    const seen = new Map<string, string[]>();
    for (const n of cfg.nodes) {
      const key = workspaceIsIsolated(n) ? `short:${n.workspace}` : `abs:${n.workspace}`;
      seen.set(key, [...(seen.get(key) ?? []), n.id]);
      if (!workspaceIsIsolated(n)) {
        add('warn', `节点 ${n.id} 的工作区是绝对路径`, '与其他节点不隔离，两条线同时写同一目录会撞车');
      }
    }
    for (const [key, ids] of seen) {
      if (ids.length > 1) add('warn', `工作区重复：${key.slice(key.indexOf(':') + 1)}`, `被这些节点共用：${ids.join('、')}`);
    }
    // 解析一遍，确认路径合法（非法会在跑任务时才炸）
    try {
      for (const n of cfg.nodes) resolveWorkspace(n, 0, root);
      add('ok', '所有工作区路径合法');
    } catch (e) {
      add('fail', '工作区路径有问题', firstLine(e));
    }

    // 外部可写目录：配了就逐个确认存在且可写。
    // 目录不存在时产物会判「文件不存在」，一轮跑完才发现，白烧
    const extras = cfg.root.extraDirs;
    if (!extras.length) {
      add('ok', '未配置 extra_dirs（产物只能写工作区）');
    }
    for (const d of extras) {
      if (!fs.existsSync(d)) {
        add('fail', `extra_dirs 目录不存在：${d}`, '建出来，或从 agents.toml 的 [root] 里删掉');
        continue;
      }
      try {
        const probe = path.join(d, `.ma-probe-${process.pid}`);
        fs.writeFileSync(probe, 'ok');
        fs.unlinkSync(probe);
        add('ok', `extra_dirs 可写：${d}`, '产物会另存一份到工作区 _external/');
      } catch (e) {
        add('fail', `extra_dirs 不可写：${d}`, firstLine(e));
      }
    }

    // 模型：配置里写死的名字必须还在 CLI 的可用列表里，否则那一轮直接失败。
    // 只在真的配了模型时才探测，免得空配置也去起一次 CLI。
    const used = [...new Set(cfg.nodes.map((n) => n.model).filter(Boolean))];
    if (used.length) {
      try {
        // doctor 是环境体检，宁可多花一次 CLI 调用也要拿实时列表：
        // 缓存里可能还留着上周的模型名，正是要查出来的东西
        const ml = await getModels({ refresh: true });
        if (ml.source === 'live') add('ok', `模型列表 ${ml.models.length} 个（实时）`);
        else add('warn', `模型列表来自${ml.source === 'cache' ? '缓存' : '内置兜底'}，未实时核实`, ml.error);
        const bad = used.filter((m) => !modelKnown(ml, String(m)));
        if (bad.length) {
          add(
            'fail',
            `这些模型已不在可用列表：${bad.join('、')}`,
            '在 agents.toml 或界面里换一个；不改这几条线每轮都会失败',
          );
        } else {
          add('ok', `节点使用的模型都可用：${used.join('、')}`);
        }
      } catch (e) {
        add('warn', '拿不到模型列表', firstLine(e));
      }
    }
  }

  // 4. 数据目录与库
  const dataDir = path.join(root, '.data');
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    const probe = path.join(dataDir, '.doctor-probe');
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    add('ok', '.data 可写');
  } catch (e) {
    add('fail', '.data 不可写', firstLine(e));
  }

  let db = null as ReturnType<typeof openDB> | null;
  try {
    db = openDB(path.join(dataDir, 'hub.db'));
    const tables = new Set(
      (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>)
        .map((r) => r.name),
    );
    const need = ['tasks', 'runs', 'checkpoints', 'hub_lock', 'approvals', 'messages'];
    const missing = need.filter((t) => !tables.has(t));
    if (missing.length) add('fail', '库缺表', missing.join('、'));
    else add('ok', '数据库可打开，表齐全');
  } catch (e) {
    add('fail', '数据库打不开', firstLine(e));
  }

  // 5. 运行态：有没有别的 hub 在跑，端口被谁占着
  let hubPid = 0;
  try {
    const row = db?.prepare('SELECT pid FROM hub_lock WHERE id = 1').get() as { pid: number } | undefined;
    if (row?.pid && pidAlive(row.pid)) {
      hubPid = row.pid;
      add('ok', `hub 正在运行（pid ${row.pid}）`);
    } else {
      add('warn', 'hub 没有在运行', '要用界面就 npm run serve');
    }
  } catch {
    // 库都打不开的话上面已经报过了
  }

  const busy = await portBusy(port);
  if (busy && !hubPid) add('warn', `端口 ${port} 被别的进程占着`, 'serve 会起不来；换个 MA_PORT 或先停掉占用者');
  else if (!busy) add('ok', `端口 ${port} 空闲`);

  return { items, ok: !items.some((i) => i.level === 'fail') };
}
