import { CONFIG_FILE, DATA_DIR, PROMPTS_DIR, PROVIDERS_FILE, SANDBOX_ROOT } from '../kernel/paths.ts';
// 命令行入口：run / status / check。跑任务的逻辑在 runner.ts，界面在 server.ts。
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, nodeById, childrenOf, workspaceIsIsolated } from '../kernel/tree.ts';
import { runTree } from '../runner/runTree.ts';
import { loadRuns } from '../store/runs.ts';
import { loadLessons, saveLessons, lessonsFile } from '../kernel/memory.ts';
import { takeSnapshot } from '../kernel/snapshot.ts';
import { openDB, importLegacyRuns, createTask, setTaskState } from '../store/db.ts';
import { runAgent } from '../adapters/spawn.ts';
import { registerProvidersFrom } from '../adapters/table.ts';

const CFG = CONFIG_FILE;

// 和 server 用同一份 providers.toml：CLI 直跑时也要认识自定义 provider
try {
  const added = registerProvidersFrom(PROVIDERS_FILE);
  if (added.length) console.log(`自定义 provider：${added.join('、')}`);
} catch (e) {
  console.error('providers.toml 有问题（先用内置 provider 跑）：' + String(e));
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const HUB = process.env.MA_HUB || 'http://127.0.0.1:3400';

/** hub 在不在？在就投递，不在就本地跑——本地跑没有排队和恢复，但能立刻用 */
async function hubAlive(): Promise<boolean> {
  try {
    const r = await fetch(HUB + '/api/health', { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch {
    return false;
  }
}

async function runViaHub(task: string, nodeId: string): Promise<number> {
  const res = await fetch(HUB + '/api/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // CLI 的 --node 是调试入口（跳过主控直跑某个节点），要显式标出来
    body: JSON.stringify({ node: nodeId, task, debug: true }),
  });
  if (!res.ok || !res.body) {
    console.error(`hub 拒绝了这次投递：HTTP ${res.status} ${await res.text().catch(() => '')}`);
    return 2;
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  // 用别名而不是内联类型：`as typeof final` 取的是当前流类型（这里是 null），
  // 断言完 final 会变成 never，后面的字段访问全报错
  type FinalEvent = { ok?: boolean; state?: string; taskId?: number };
  let final: FinalEvent | null = null;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const frames = buf.split('\n\n');
    buf = frames.pop() ?? '';
    for (const f of frames) {
      const isDone = /^event: done/m.test(f);
      const data = f.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('\n');
      if (!data) continue;
      let parsed: unknown;
      try { parsed = JSON.parse(data); } catch { continue; }
      if (isDone) final = parsed as FinalEvent;
      else console.log(String(parsed));
    }
  }

  if (final && final.state) {
    console.log(`\ntask #${final.taskId}  ${final.state}`);
    return final.ok ? 0 : 1;
  }
  console.log('\n连接断了，任务可能还在 hub 上跑（用 /api/tasks 看）');
  return 1;
}

async function cmdRun(): Promise<void> {
  const cfg = loadConfig(CFG);
  const nodeId = arg('node') || cfg.root.id;
  const task = arg('task');
  if (!task) {
    console.error('用法：node src/cli.ts run --node <id> --task "要它做什么" [--dry-run]');
    process.exitCode = 2;
    return;
  }
  const node = nodeById(cfg, nodeId);
  const dry = process.argv.includes('--dry-run');

  // --local 强制本地跑；否则 hub 在就走 hub（有排队、并发、恢复）
  if (!dry && !process.argv.includes('--local') && (await hubAlive())) {
    process.exitCode = await runViaHub(task, nodeId);
    return;
  }

  // 库总是开：号段以库为准，预览不该把它拖偏
  const db = openDB();
  const mig = importLegacyRuns(db);
  if (mig.problems.length) {
    console.log('历史记录有问题：' + mig.problems.slice(0, 3).join('；'));
  }

  const taskId = dry
    ? 0
    : createTask(db, {
        master: cfg.root.id,
        task,
        configSnapshot: takeSnapshot(cfg, loadLessons()),
        // 直接建 running：建出来到改状态之间如果被调度器认领，同一个任务会跑两遍
        initialState: 'running',
      });

  if (!dry) {
    console.log(`task #${taskId}  本地执行（hub 没开，或指定了 --local）`);
  }

  // 第一次 Ctrl+C 干净取消（杀进程树），第二次直接退
  const ac = new AbortController();
  const onSigint = () => {
    if (ac.signal.aborted) {
      console.log('\n再按一次，强制退出');
      process.exit(130);
    }
    console.log('\n收到 Ctrl+C，正在终止进程树…（再按一次强退）');
    ac.abort();
  };
  process.on('SIGINT', onSigint);

  let rec: Awaited<ReturnType<typeof runTree>> = null;
  try {
    rec = await runTree(cfg, node, task, (line) => console.log(line), {
      db,
      taskId,
      root: SANDBOX_ROOT,
      signal: ac.signal,
    }, dry);
  } catch (e) {
    if (!dry) setTaskState(db, taskId, 'failed', { errorCode: 'exception', errorMessage: String(e).slice(0, 500) });
    throw e;
  } finally {
    process.off('SIGINT', onSigint);
    // 不管成功失败都要落一个终态，否则任务永远挂在 running 上占位
    if (!dry && rec === null) {
      setTaskState(db, taskId, ac.signal.aborted ? 'canceled' : 'failed', {
        errorCode: ac.signal.aborted ? 'canceled' : 'no_result',
      });
    }
  }

  if (dry) return;
  if (!rec) {
    console.log('\n没有跑出结果（预算用完）');
    process.exitCode = 1;
    return;
  }
  // 验收判 rework 不算完成：只看 state 会把「补验两次都没核上」记成 done
  const passed = rec.state === 'done' && rec.verdict !== 'rework';
  const finalState = passed ? 'done' : rec.state === 'canceled' ? 'canceled' : 'failed';
  setTaskState(db, taskId, finalState, {
    errorCode: passed ? undefined : (rec.verdict === 'rework' ? 'rework' : rec.state),
    errorMessage: rec.error,
  });
  console.log('\n' + (passed
    ? '完成'
    : `未完成：${rec.state}${rec.verdict === 'rework' ? '（验收未通过）' : ''}${rec.error ? ' — ' + rec.error : ''}`));
  console.log(`task #${taskId}  ${finalState}`);
  process.exitCode = passed ? 0 : 1;
}

function cmdStatus(): void {
  const runs = loadRuns();
  if (!runs.length) {
    console.log('还没有跑过任何一轮。');
    return;
  }
  for (const r of runs.slice(-12)) {
    const mark = r.state === 'done' ? 'DONE  ' : r.state === 'blocked' ? 'BLOCK ' : 'FAILED';
    const verdict = r.verdict ? ` · ${r.verdict.toUpperCase()}` : '';
    const who = r.parent ? `  (父 #${r.parent})` : '';
    console.log(`#${String(r.id).padStart(2)}  ${mark}  ${(r.ms / 1000).toFixed(1)}s  ${r.node}${who}${verdict}  ${r.summary || r.error || ''}`);
    for (const a of r.artifacts) console.log(`      产物  ${a.path}  ${a.bytes} 字节`);
    for (const w of r.warnings) console.log(`      提示  ${w}`);
  }
}

async function cmdLearn(): Promise<void> {
  const reworks = loadRuns().filter((r) => r.verdict === 'rework');
  if (!reworks.length) {
    console.log('还没有打回记录，没什么可学的。');
    return;
  }
  console.log(`扫到 ${reworks.length} 条打回记录，让主控自己看一遍…`);

  const material = reworks
    .map((r) => `### 第 ${r.id} 轮\n${(r.dispatch[0]?.task ?? '').slice(0, 1200)}`)
    .join('\n\n');

  const prompt = [
    '下面是你（主控）过去打回下级时说的原话。请从中提炼 3-5 条可复用的教训，',
    '写成给「未来的自己」看的提醒：下次派活和验收时该注意什么。',
    '',
    '要求：',
    '- 每条一个 `## 一句话标题`，下面一两句话说明做法',
    '- 只写反复出现的问题，一次性的不复述',
    '- 不写具体文件名、轮次号',
    '- 直接输出 markdown 正文，**不要**输出 ' + '```agent-autoloop' + ' 回执块',
    '',
    material.slice(0, 6000),
  ].join('\n');

  const cfg = loadConfig(CFG);
  // 用当前的根，不要写死 'a'：在主控之上加了一层之后，根已经不是 a 了
  const node = nodeById(cfg, cfg.root.id);
  const r = await runAgent('codebuddy', {
    prompt,
    cwd: node.workspace,
    timeoutMs: 240_000,
    access: 'read',
    model: node.model,
  });

  // 模型可能还是习惯性附回执块，剥掉
  const clean = r.stdout.replace(/```agent-autoloop[\s\S]*?```/g, '').trim();
  if (!clean) {
    console.log('模型没返回可用内容。stderr:', r.stderr.slice(0, 200));
    process.exitCode = 1;
    return;
  }
  saveLessons(clean);
  console.log(`\n已写入 ${lessonsFile()}\n`);
  console.log(clean);
}

function cmdCheck(): void {
  const cfg = loadConfig(CFG);
  const problems: string[] = [];
  if (cfg.schema !== 1) problems.push(`schema=${cfg.schema}，本版只认 1`);
  for (const n of cfg.nodes) {
    // 短名是模板，运行时按任务建；只有绝对路径才需要事先存在
    if (!workspaceIsIsolated(n) && !fs.existsSync(n.workspace)) {
      problems.push(`工作区不存在：${n.id} → ${n.workspace}`);
    }
    if (!fs.existsSync(path.join(PROMPTS_DIR, n.role + '.md'))) {
      problems.push(`提示词缺失：prompts/${n.role}.md（节点 ${n.id}）`);
    }
  }
  if (problems.length) {
    console.log('配置有问题：');
    for (const p of problems) console.log('  · ' + p);
    process.exitCode = 1;
    return;
  }
  console.log(`配置 OK · ${cfg.nodes.length} 个节点`);
  for (const n of cfg.nodes) {
    const kids = childrenOf(cfg, n.id);
    const depth = n.parent ? 1 : 0;
    console.log(`  ${'  '.repeat(depth)}${n.id}（${n.name}）· ${n.plugin}${n.model ? ':' + n.model : ''} · role=${n.role}${kids.length ? ` · 下级 ${kids.map((k) => k.id).join(',')}` : ''}`);
  }
  console.log(`  协议上限：summary ${cfg.maxSummary} 字 / detail ${cfg.maxDetail} 字`);
}

/**
 * 换项目：把记忆与对话搬走留档，其余保持原样。
 *
 * 为什么「搬走」而不是「删掉」（决策 P1-12）：换项目后旧记忆会污染新任务
 * （主控会以为自己还在做上一个项目）。但直接删等于把踩过的坑一起丢了，
 * 所以移到 .data/archive/<项目>-<日期>/ 下，需要时还能翻。
 *
 * 刻意不动 prompts/：那些是通用职责模板，换项目还要用。
 * context.md 清空但留一份空模板：它是手写文件，得人来填新项目的底图。
 */
function cmdSwitchProject(): void {
  const cfg = loadConfig(CFG);
  const name = (cfg.project?.name || '未命名').replace(/[\\/:*?"<>|]/g, '_');
  const stamp = new Date().toISOString().slice(0, 10);
  const dest = path.join(DATA_DIR, 'archive', `${name}-${stamp}`);
  const memoryDir = path.join(DATA_DIR, 'memory');
  const chatDir = path.join(DATA_DIR, 'chat');

  const moved: string[] = [];
  const keep = new Set(['context.md']);   // 这个单独处理
  try {
    fs.mkdirSync(path.join(dest, 'memory'), { recursive: true });
    for (const f of fs.existsSync(memoryDir) ? fs.readdirSync(memoryDir) : []) {
      if (!/\.md$/.test(f) || keep.has(f)) continue;
      const from = path.join(memoryDir, f);
      fs.renameSync(from, path.join(dest, 'memory', f));
      moved.push('memory/' + f);
    }
  } catch (e) {
    console.error('搬记忆失败：' + String(e));
  }
  try {
    if (fs.existsSync(chatDir)) {
      fs.mkdirSync(path.join(dest, 'chat'), { recursive: true });
      for (const f of fs.readdirSync(chatDir)) {
        fs.renameSync(path.join(chatDir, f), path.join(dest, 'chat', f));
        moved.push('chat/' + f);
      }
    }
  } catch (e) {
    console.error('搬对话失败：' + String(e));
  }

  // context.md 换成空模板：手写文件需要人重填，留旧的等于让主控读错项目
  try {
    fs.writeFileSync(
      path.join(memoryDir, 'context.md'),
      [
        '# 项目索引（换项目后需手写重填）',
        '',
        '> 这份文件每轮都会注入主控提示词。空着比写错的强。',
        '',
        '## 现在在哪',
        '- （项目根、当前版本、当前阶段）',
        '',
        '## 先读哪几份',
        '- （按路由列 3–5 个入口文件，不要整包读）',
        '',
        '## 硬规格',
        '- （尺寸、帧率、命名约定这类不能猜的）',
        '',
        '## 禁忌',
        '- （不许动的东西）',
        '',
      ].join('\n'),
      'utf8',
    );
    moved.push('memory/context.md（已重置为空模板）');
  } catch (e) {
    console.error('重置 context.md 失败：' + String(e));
  }

  console.log(`换项目留档：${dest}`);
  for (const m of moved) console.log('  · ' + m);
  console.log('');
  console.log('接下来手动做两件事：');
  console.log('  1. 写 .data/memory/context.md（新项目的底图）');
  console.log('  2. 改 agents.toml 的 [project] 段（name / root）');
  console.log('prompts/ 里的职责模板没有动，可以直接用。');
}

const cmd = process.argv[2];
if (cmd === 'run') await cmdRun();
else if (cmd === 'status') cmdStatus();
else if (cmd === 'check') cmdCheck();
else if (cmd === 'doctor') {
  const { runDoctor } = await import('./doctor.ts');
  const { items, ok } = await runDoctor(SANDBOX_ROOT, Number(process.env.MA_PORT || 3400));
  const mark = { ok: '\u2713', warn: '!', fail: '\u2717' } as const;
  for (const it of items) {
    console.log(`${mark[it.level]} ${it.title}${it.detail ? '\n    ' + it.detail : ''}`);
  }
  const fails = items.filter((i) => i.level === 'fail').length;
  const warns = items.filter((i) => i.level === 'warn').length;
  console.log(`\n${items.length} 项检查：${fails} 个失败，${warns} 个提醒`);
  if (!ok) process.exitCode = 1;
}
else if (cmd === 'switch-project') cmdSwitchProject();
else if (cmd === 'learn') await cmdLearn();
else if (cmd === 'lessons') {
  const t = loadLessons();
  console.log(t || '（还没有教训，跑一次 learn）');
}
else {
  console.log('用法：node src/cli.ts <run|status|check|doctor>');
  console.log('  run    --node a --task "..."  [--dry-run]');
  console.log('  status 看最近 12 轮');
  console.log('  check  校验 agents.toml 与提示词');
  console.log('  doctor 环境自检：provider 路径、role 文件、数据目录、端口');
  console.log('  learn  从历史打回里提炼教训，写进主控提示词');
  console.log('  lessons 看当前教训');
  console.log('  switch-project 换项目：记忆与对话搬到 .data/archive 留档，context.md 重置');
  console.log('                 （装之前先备份：搬走不可逆，虽然只是 rename）');
  console.log('  （要界面的话：node src/server.ts 然后开 http://127.0.0.1:3400）');
}
