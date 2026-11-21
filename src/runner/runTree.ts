// 跑一棵子树：派活 → 执行 → 交付 → 回传 → 收口 → 通过/打回。
// 和界面无关，日志通过回调往外送，命令行和 HTTP 都能用。
import fs from 'node:fs';
import { childrenOf, resolveWorkspace, type Config, type NodeConfig } from '../kernel/tree.ts';
import { buildPrompt } from '../protocol/prompt.ts';
import { parseReceipt } from '../protocol/receipt.ts';
import { checkArtifacts, evidenceProblem, hasTextArtifacts, scanRecent } from '../kernel/settle.ts';
import { guard, looksStuck, MAX_REWORK } from '../kernel/guard.ts';
import { missingDeliverables } from '../kernel/deliverables.ts';
import { planRoutes } from './route.ts';
import { applySpawns } from './spawn.ts';
import { buildReviewBrief, buildVerifyBrief, buildPhaseBrief } from './accept.ts';
import { reportText } from './report.ts';
import { runLanes } from '../kernel/lane.ts';
import { Semaphore } from '../kernel/pool.ts';
import { loadContext, loadJournal, loadLessons } from '../kernel/memory.ts';
import { saveCheckpoint } from '../store/checkpoints.ts';
import { addMessage, takeMessages } from '../store/messages.ts';
import { runAgent } from '../adapters/spawn.ts';
import { runPath, saveRun, type RunRecord } from '../store/runs.ts';
import type { Artifact, Ask } from '../protocol/schema.ts';
import { logPath, saveLog } from '../store/log.ts';
import { allocRunId, finishRun, getPhases, savePhases } from '../store/db.ts';
import type { DatabaseSync } from 'node:sqlite';

export type Logger = (line: string) => void;

const RETRYABLE = /没有找到 agent-autoloop 回执块|超过 \d+ 分钟被杀/;

/**
 * 轮次预算：只防「主控不停派活」跑飞，不是树的规模上限。
 * 收口轮、补验轮不扣（它们是流程必经），所以一次派 8 条也不会把收口挤掉。
 * 真正防浪费的是 guard 的两条：单节点打回 3 次、两次同段话。
 */
const MAX_ROUNDS = 12;

/** 主控一轮最多派几条。超过就截断并告警，防止一次派出二十条把预算和车位都吃光 */
const MAX_FANOUT = 8;

/**
 * 一个节点最多连续跑几次收口轮。
 *
 * 收口轮不扣 budget（它是流程必经），所以光靠 budget 拦不住「打回 → 重派被守门员拦下
 * → 还是同一份 dispatch → 再收口」这种空转：每一圈都是 review，一圈都不扣预算。
 * 这是独立的第二道闸：就算路由那边全放过，收口也不可能无限跑下去。
 */
const MAX_REVIEW_ROUNDS = 6;


/** 没给池时（命令行直跑）用单车道，保持原来的串行行为 */
const FALLBACK_POOL = new Semaphore(1);

function stamp(): string {
  return new Date().toLocaleTimeString('zh-CN', { hour12: false });
}

export type RunCtx = {
  db: DatabaseSync;
  taskId: number;
  /** 项目根，用来拼 .sandbox/t<taskId>/<节点> */
  root: string;
  signal?: AbortSignal;
  /** 全机共用的并发车位。不给就串行（命令行调试走这条） */
  pool?: Semaphore;
  /**
   * 真正调模型的那一步。默认就是起进程的 runAgent；
   * 测试注入一个假的，才能在不起真 CLI 的情况下跑通多层树、打回、派生这些分支。
   */
  runner?: typeof runAgent;
};

export async function runTree(
  cfg0: Config,
  node0: NodeConfig,
  task: string,
  log: Logger,
  ctx: RunCtx,
  dry = false,
): Promise<RunRecord | null> {
  // 整棵树的 workspace 一次解析成按任务隔离的路径，下面的逻辑不用再关心隔离
  const nodes = cfg0.nodes.map((n) => ({ ...n, workspace: resolveWorkspace(n, ctx.taskId, ctx.root) }));
  const cfg: Config = { ...cfg0, nodes, root: nodes.find((n) => n.id === cfg0.root.id)! };
  const node = nodes.find((n) => n.id === node0.id)!;

  let budget = MAX_ROUNDS;
  // 只有本次运行产生的记录才算「这次有没有空转」，历史打回不算
  const thisRun: RunRecord[] = [];

  /**
   * 每个节点本次任务累计交出来的产物（含整棵子树）。
   *
   * 为什么不能只看「下级最后返回的那条记录」：a → b → c 里 c 的产物是 b 的收口轮
   * 消费掉的，b 返回给 a 的是自己的验收记录，通常 artifacts=[]。只取 r.value.artifacts，
   * a 的收口就等于在核一份空清单，没有 evidence 也能判 pass（审计 P0-2 多层树缺口）。
   * 按路径去重：同一个文件被改写过，路径不变，核证据时读的是磁盘上的最新内容。
   */
  const delivered = new Map<string, Artifact[]>();
  /** 每个节点收口了几轮，用来兜住「打回—重判」的空转 */
  const reviewRounds = new Map<string, number>();
  /** 每个节点名下的「下级在等我回答」。收口时据此判断它有没有把问题吞掉 */
  const pendingAsks = new Map<string, Ask[]>();

  function remember(nodeId: string, arts: Artifact[]): void {
    if (!arts.length) return;
    const cur = delivered.get(nodeId) ?? [];
    const seen = new Set(cur.map((a) => a.path));
    for (const a of arts) {
      if (seen.has(a.path)) continue;
      cur.push(a);
      seen.add(a.path);
    }
    delivered.set(nodeId, cur);
  }

  async function runOnce(
    n: NodeConfig,
    t: string,
    parent: number | undefined,
    review: boolean,
    /** 收口轮要核的是「下级交上来的东西」，不是主控自己这一轮写了什么 */
    reviewArtifacts?: Artifact[],
  ): Promise<RunRecord> {
    // dry-run 不建目录也不占号：预览不该在工作区留下痕迹
    const id = dry ? 0 : allocRunId(ctx.db, ctx.taskId, n.id, parent);
    if (!dry) fs.mkdirSync(n.workspace, { recursive: true });
    const startedAt = new Date().toISOString();
    // 上一轮之后别人留的话：读完就标已投递，同一轮失败重试也不会重复塞
    const inboxMsgs = dry ? [] : takeMessages(ctx.db, ctx.taskId, n.id);
    const inbox = inboxMsgs.length
      ? inboxMsgs.map((m) => `- ${m.from}：${m.body}`).join('\n')
      : '';

    // 带队伍的节点才需要项目背景和踩坑记录：执行者只要知道自己这一件事
    const hasKids = childrenOf(cfg, n.id).length > 0;
    const prompt = buildPrompt(
      cfg, n, t,
      hasKids ? loadLessons() : '',
      hasKids ? loadContext() : '',
      hasKids ? loadJournal() : '',
      inbox,
    );
    // 节点标签：并发跑起来后日志会交错，没有 [节点] 前缀根本分不清哪条线在说话
    const pad = (parent ? '    ' : '') + `[${n.id}] `;

    log(`${pad}run #${id}  ${stamp()}  ${n.id}（${n.name}）  ${n.plugin}  ≤${n.timeoutMin}min`);
    if (inboxMsgs.length) log(`${pad}  收到 ${inboxMsgs.length} 条留言`);

    if (dry) {
      log(`${pad}        cwd=${n.workspace}  提示词 ${Buffer.byteLength(prompt, 'utf8')} 字节`);
      log('\n----- 提示词 -----\n' + prompt + '\n------------------');
      return {
        id,
        parent,
        node: n.id,
        plugin: n.plugin,
        task: t,
        state: 'done',
        startedAt,
        ms: 0,
        summary: '（dry-run，没有真跑）',
        artifacts: [],
        dispatch: [],
        warnings: [],
      };
    }

    // 车位在这里申请，不在 runLanes 里：runOnce 是唯一的模型调用点，
    // 主控轮不经过 runLanes，两边都申请会自己把自己锁死。
    // 等车位期间被取消就不用起进程了，否则会白起一个再杀。
    const pool = ctx.pool ?? FALLBACK_POOL;
    const agent = ctx.runner ?? runAgent;
    let result: Awaited<ReturnType<typeof runAgent>>;
    // 车位满了先吭一声：否则界面上这条已经显示「运行中」，人却看不到它其实在排队
    if (pool.busy() >= pool.limit) {
      log(`${pad}  等车位：${pool.busy()}/${pool.limit} 占满，前面 ${pool.waiting()} 条`);
    }
    const CANCELED = { exitCode: -1, stdout: '', stderr: '', ms: 0, killed: false, canceled: true };
    let holding = false;
    try {
      // 等车位也能被取消：否则车位满时取消任务，要等前面全部跑完才轮到它
      await pool.acquire(ctx.signal);
      holding = true;
      result = ctx.signal?.aborted
        ? CANCELED
        : await agent(n.plugin, {
            prompt,
            cwd: n.workspace,
            timeoutMs: n.timeoutMin * 60_000,
            access: n.access,
            model: n.model || undefined,
            signal: ctx.signal,
          });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg === 'canceled') {
        // 排队期间被取消：没起进程，直接按取消收场
        result = CANCELED;
      } else {
        // 起进程这一层自己抛了（provider 名不认识、二进制路径不存在、权限被拒）。
        // 伪造一份空输出让下面的解析走 failed 分支：这样轮次记录照样落盘，
        // 不会在 runs 表里留一条永远 running 的僵尸，也不会把整个任务带崩。
        result = {
          exitCode: -1,
          stdout: '',
          stderr: '起进程失败：' + msg,
          ms: 0,
          killed: false,
          canceled: false,
        };
      }
    } finally {
      // 只有真拿到车位才还：acquire 失败时还一次会把池撑大
      if (holding) pool.release();
    }

    // 私账先落盘：这轮结果好坏都要留一份原文，否则出了事只能看摘要
    if (!dry) {
      try {
        saveLog(id, result.stdout);
      } catch (e) {
        log(`${pad}  警告  原文没存下来：${String(e)}`);
      }
    }

    const parsed = parseReceipt(result.stdout, cfg);
    const warnings: string[] = [];
    if (result.canceled) {
      warnings.push('收到取消信号，进程树已终止');
      // 取消时哪怕回执完整也不采纳：这一轮本来就不该有结论
    } else if (result.killed) {
      warnings.push(parsed.ok ? '进程在超时后被清理，回执已完整收到' : `超过 ${n.timeoutMin} 分钟被杀`);
    }
    if (result.exitCode !== 0 && !parsed.ok) warnings.push(`进程退出码 ${result.exitCode}`);
    if (result.stderr.trim()) {
      const first = result.stderr.trim().split('\n')[0].slice(0, 160);
      if (!/warning: Codex is ignoring/i.test(first)) warnings.push('stderr: ' + first);
    }

    let rec: RunRecord;

    if (result.canceled) {
      rec = {
        id,
        parent,
        node: n.id,
        plugin: n.plugin,
        task: t,
        state: 'canceled',
        startedAt,
        ms: result.ms,
        summary: '已取消',
        artifacts: [],
        dispatch: [],
        warnings,
        error: '收到取消信号，进程树已终止',
      };
      log(`${pad}  CANCELED  ${(result.ms / 1000).toFixed(1)}s — 已取消`);
    } else if (!parsed.ok) {
      // 没有回执不等于没干活：#41 的 d 跑了 30 分钟、落下 145 个文件，
      // 回执在最后没写成，界面上就成了「毫无产出」。扫一遍工作区和白名单目录，
      // 把这一轮新写的文件记成未验收，至少能让人看见东西在哪。
      const scan = scanRecent(n, Date.parse(startedAt), n.extraDirs);
      if (scan.files.length) {
        log(`${pad}  未验收  没拿到回执，但这一轮写了 ${scan.files.length} 个文件${scan.hitLimit ? '（扫描触及上限，可能不全）' : ''}`);
        for (const f of scan.files.slice(0, 5)) log(`${pad}    ${f.path}  ${f.bytes} 字节`);
      }
      rec = {
        id,
        parent,
        node: n.id,
        plugin: n.plugin,
        task: t,
        state: 'failed',
        startedAt,
        ms: result.ms,
        summary: '',
        artifacts: [],
        stray: scan.files.length ? scan.files : undefined,
        dispatch: [],
        warnings: scan.files.length
          ? [...warnings, `没拿到回执，但这一轮写了 ${scan.files.length} 个文件（未验收）`]
          : warnings,
        // 被超时杀掉时 stdout 是空的，parseReceipt 只会说「没有回执块」，
        // 那不是真正的原因。真正的原因是它跑了 N 分钟没跑完。
        error: result.killed
          ? `超过 ${n.timeoutMin} 分钟被杀，没拿到回执`
          : parsed.why,
      };
      log(`${pad}  FAILED  ${(result.ms / 1000).toFixed(1)}s — ${rec.error}`);
      const tail = parsed.raw.replace(/\s+/g, ' ').slice(-220);
      if (tail) log(`${pad}  输出尾部：${tail}`);
    } else {
      // 收口轮会把自己核过的下级产物列进 artifacts：那是引用，不是它的交付。
      // 不把下级工作区当只读引用放行，主控每轮收口都会被判「产物越界」（#42）
      const refDirs = review
        ? nodes.filter((x) => x.parent === n.id).map((x) => x.workspace)
        : [];
      const { ok, bad, stray, backedUp } = checkArtifacts(parsed.receipt, n, {
        extraDirs: n.extraDirs,
        refDirs,
      });
      warnings.push(...bad);
      for (const b of backedUp) log(`${pad}  备份  ${b.from} → ${b.to}`);
      // 没通过的文件也要说出来：只报一句「产物有问题」，人就不知道东西到底写在哪
      for (const s of stray) log(`${pad}  未验收  ${s.path}  ${s.bytes} 字节 — ${s.why}`);
      // 它在提问，而且这一轮没交出产物 = 卡在等人回答。
      // 即使产物校验有问题也按 blocked 收：把「它在问什么」交给人的优先级，
      // 高于「产物越界」这类技术判定，否则问题会被 failed 吞掉，人只看到一个红叉（#40）
      const asks = parsed.receipt.ask.map((a) => ({ ...a, from: n.id }));
      // 阶段计划只在第一次给出时落库：后面每轮再给，会覆盖掉已经完成的进度
      const given = parsed.receipt.plan;
      if (given?.length) {
        const st = getPhases(ctx.db, ctx.taskId);
        if (!st.plan.length) {
          savePhases(ctx.db, ctx.taskId, given, []);
          log(`${pad}  阶段计划 ${given.length} 段：${given.map((p) => p.id + ' ' + p.name).join(' → ')}`);
        }
      }
      const blocked = (!!parsed.receipt.question || asks.length > 0) && ok.length === 0;
      // 判通过前先核证据：主控嘴上说「看了」，得拿出只有读过文件才写得出的片段。
      // 这是纯字符串比对，不花 token；核不上就当它没验，不能给 pass。
      let evMiss: string[] = [];
      if (review && !bad.length && !blocked && !parsed.receipt.dispatch.length) {
        // 核哪些文件里的证据：下级交的 + 自己这一轮写的，两边的文本都算。
        // 只取下级的（P0-2 当时的做法）会让「主控写了汇总报告、引用自己报告里的话」
        // 一条都搜不到，白挨一次打回（#44）；只取自己的则等于不验下级。
        const seenPaths = new Set<string>();
        const targets: Artifact[] = [];
        for (const a of [...(reviewArtifacts ?? []), ...ok]) {
          if (!a?.path || seenPaths.has(a.path)) continue;
          seenPaths.add(a.path);
          targets.push(a);
        }
        evMiss = evidenceProblem(parsed.receipt.evidence, targets);
        // 全二进制 / 全读不到时证据门槛形同虚设，至少要留个痕迹，
        // 不能让人以为「这条验过了」
        if (!evMiss.length && targets.length && !hasTextArtifacts(targets)) {
          warnings.push('产物没有可核对的文本（二进制或读不到），这一轮的 evidence 校验实际被跳过');
        }
      }
      if (evMiss.length) {
        warnings.push(`证据核不上：${evMiss.join(' / ')}`);
      }
      rec = {
        id,
        parent,
        node: n.id,
        plugin: n.plugin,
        task: t,
        state: blocked ? 'blocked' : bad.length ? 'failed' : 'done',
        startedAt,
        ms: result.ms,
        summary: parsed.receipt.summary,
        question: parsed.receipt.question,
        // 引用（下级产物）不算本节点的交付：只留在这一轮的报告里，不写进快照与产物清单
        artifacts: ok.filter((a) => !a.ref),
        stray: stray.length ? stray : undefined,
        dispatch: parsed.receipt.dispatch,
        evidence: parsed.receipt.evidence,
        spawn: parsed.receipt.spawn,
        tell: parsed.receipt.tell,
        ask: asks.length ? asks : undefined,
        phase: parsed.receipt.phase || undefined,
        warnings,
        verdict: review && !bad.length && !blocked
          ? (parsed.receipt.dispatch.length || evMiss.length ? 'rework' : 'pass')
          : undefined,
        error: blocked ? '卡住，等回答'
          : bad.length ? '产物有问题'
          : evMiss.length ? '证据核不上' : undefined,
      };
      // 下级点名在等你回答，你却直接判通过 = 把问题吞了（用户看到的就是「子 agent 跑来问我」）。
      // 两条合法出路：dispatch 派回去回答，或者用自己的 question 升级给人。
      // 这里只拦「什么都不做就判过」这一种，不会误伤正常收口。
      if (review && rec.verdict === 'pass') {
        const pending = pendingAsks.get(n.id) ?? [];
        if (pending.length) {
          rec.verdict = 'rework';
          rec.error = '没处理下级的提问';
          rec.warnings.push(`有 ${pending.length} 个下级在等回答，这一轮既没派回去也没升级给人`);
          log(`${pad}  驳回  有 ${pending.length} 个下级在等回答，不能直接判通过`);
        }
      }
      // 任务原文点了名的交付物（「交付清单」段里的绝对路径），收口时得真的在盘上。
      // 只拦 dispatch 为空的 pass：还在派活说明活没做完，不用这条管。
      // #45 六项交付全缺、收口照样 pass 判 done，就是这里没人问一句「文件在不在」。
      if (review && rec.verdict === 'pass') {
        const miss = missingDeliverables(t);
        if (miss.length) {
          rec.verdict = 'rework';
          rec.error = '交付清单没落地';
          rec.warnings.push(
            `交付清单里 ${miss.length} 项还不在盘上：${miss.slice(0, 3).join(' / ')}`
              + `${miss.length > 3 ? ' …' : ''}；把剩下的段跑完再收口`,
          );
          log(`${pad}  驳回  交付清单里 ${miss.length} 项还没落盘，任务没做完`);
        }
      }
      // 主控自己把交付物写了：有子线却不派活，等于绕开验收门。
      // 不判失败（有时确实只有它能写，比如规划文档），但必须留痕，
      // 否则任务显示 done、内容没人核过，人还以为走了正常流程（#46 就是这样）
      if (!review && rec.artifacts.length && !rec.dispatch.length && childrenOf(cfg, n.id).length) {
        rec.warnings.push(`主控自写产物 ${rec.artifacts.length} 个、没有派给任何下级：这些交付没有经过第二方验收`);
        log(`${pad}  提示  自写产物 ${rec.artifacts.length} 个，本轮未派活`);
      }
      const mark = blocked ? 'BLOCKED' : bad.length ? 'FAILED'
        : review ? (rec.verdict === 'pass' ? 'PASS' : 'REWORK') : 'DONE';
      log(`${pad}  ${mark}  ${(result.ms / 1000).toFixed(1)}s — ${parsed.receipt.summary}`);
      for (const a of ok) log(`${pad}  产物  ${a.path}  ${a.bytes} 字节`);
      if (parsed.receipt.question) log(`${pad}  提问  ${parsed.receipt.question}`);
      if (evMiss.length) {
        log(`${pad}  证据核不上（产物里搜不到）：${evMiss.map((x) => '「' + x + '」').join(' ')}`);
      }
      if (parsed.receipt.dispatch.length) {
        log(`${pad}  派出  ${parsed.receipt.dispatch.map((d) => `${d.to}：${d.task.slice(0, 40)}`).join(' | ')}`);
      }
    }

    // 成本代理指标：真 token 拿不到，先记模型和输入规模，至少能看出哪条线在烧
    rec.model = n.model || '';
    rec.promptBytes = Buffer.byteLength(prompt, 'utf8');
    if (result.usage) rec.usage = result.usage;

    if (rec.usage) {
      log(`${pad}  tokens  ${rec.usage.total.toLocaleString('en-US')}（入 ${rec.usage.input.toLocaleString('en-US')} / 出 ${rec.usage.output.toLocaleString('en-US')}，${rec.usage.steps} 次调用）`);
    }
    for (const w of warnings) log(`${pad}  提示  ${w}`);
    if (!dry) {
      thisRun.push(rec);
      if (looksStuck(result.stdout)) {
        log(`${pad}  提示  这一轮输出里反复出现「再试一次」这类话，可能在原地打转`);
      }
    }
    // 记录写失败不能吞掉这一轮的结果：日志里留下痕迹，返回值照常给出
    let jsonPath = '';
    try {
      saveRun(rec);
      jsonPath = runPath(rec.id);
    } catch (e) {
      log(`${pad}  警告  记录没写成：${String(e)}（这一轮结果只在下面的返回值里）`);
    }
    // json_path 留空说明这轮没落盘，启动对账时能一眼找出来
    if (!dry) {
      try {
        finishRun(ctx.db, rec.id, {
          phase: review ? 'review' : 'work',
          state: rec.state,
          verdict: rec.verdict ?? null,
          jsonPath: jsonPath || undefined,
          logPath: logPath(rec.id),
          endedAt: Date.now(),
          ms: rec.ms,
        });
      } catch (e) {
        log(`${pad}  警告  轮次索引没更新：${String(e)}`);
      }
      // 状态快照：续跑只读这张表，不再回头扫 runs + json 文件
      try {
        saveCheckpoint(ctx.db, ctx.taskId, rec);
      } catch (e) {
        log(`${pad}  警告  状态快照没写成：${String(e)}`);
      }
    }
    return rec;
  }

  /**
   * 不调模型，直接给节点落一个终态。
   *
   * 用在「这一轮的派活全被拦下」的场合：此时再跑一轮收口，模型看到的材料和上一轮
   * 几乎一样，多半原样再写一遍 dispatch，然后又被拦下——每一圈都是 review，
   * 不扣 budget，也没有别的退出条件，可以无限烧（审计 P1-6 的无限收口循环）。
   *
   * 落一条真实记录而不是只改内存，是为了让磁盘上的轮次和任务终态对得上：
   * 任务会以 blocked 收场，人能看懂为什么停，也能带着答案续跑。
   */
  function closeBlocked(
    n: NodeConfig,
    parent: number | undefined,
    t: string,
    why: string,
  ): RunRecord {
    const rec: RunRecord = {
      id: dry ? 0 : allocRunId(ctx.db, ctx.taskId, n.id, parent),
      parent,
      node: n.id,
      plugin: n.plugin,
      task: t,
      state: 'blocked',
      startedAt: new Date().toISOString(),
      ms: 0,
      summary: why,
      question: why,
      artifacts: [],
      dispatch: [],
      warnings: ['这一轮没有调模型：上一轮的派活全部被拦下，再收口只会得到同一份指令'],
      error: '卡住，等回答',
    };
    log(`  ${n.id} BLOCKED — ${why}`);
    if (dry) return rec;

    thisRun.push(rec);
    let jsonPath = '';
    try {
      saveRun(rec);
      jsonPath = runPath(rec.id);
    } catch (e) {
      log(`  警告  记录没写成：${String(e)}`);
    }
    try {
      finishRun(ctx.db, rec.id, {
        phase: 'review',
        state: rec.state,
        verdict: null,
        jsonPath: jsonPath || undefined,
        logPath: logPath(rec.id),
        endedAt: Date.now(),
        ms: 0,
      });
    } catch (e) {
      log(`  警告  轮次索引没更新：${String(e)}`);
    }
    try {
      saveCheckpoint(ctx.db, ctx.taskId, rec);
    } catch (e) {
      log(`  警告  状态快照没写成：${String(e)}`);
    }
    return rec;
  }

  async function runOne(
    n: NodeConfig,
    t: string,
    parent: number | undefined,
    review: boolean,
    reviewArtifacts?: Artifact[],
  ): Promise<RunRecord> {
    const first = await runOnce(n, t, parent, review, reviewArtifacts);
    if (first.state !== 'failed' || !RETRYABLE.test(first.error ?? '')) return first;
    // 认证失败重试一百次也一样，别白等
    if (first.warnings.some((w) => /Authentication required|not logged in/i.test(w))) return first;
    log(`    ${n.id} 这一轮没跑出回执，重试一次`);
    return await runOnce(n, t, parent, review, reviewArtifacts);
  }

  /** 本任务已经批准并派生出来的节点数 */
  let spawnedCount = 0;

  /**
   * 处理派生请求：每一个都要停下等人点头。
   *
   * 三道闸门按顺序拦：只有主控能提、单任务有总量上限、节点总数不能超。
   * 批准后只加进内存里的 cfg，不写 agents.toml——任务结束即消失，不留残留。
   */
  async function step(
    n: NodeConfig,
    t: string,
    parent: number | undefined,
    review: boolean,
    origin: string,
    verifyTry = 0,
    /** 下级这一轮交上来的产物，收口时用来核 evidence */
    reviewArtifacts?: Artifact[],
  ): Promise<RunRecord | null> {
    // 取消只在轮次边界生效：真正杀正在跑的子进程是 adapters 的事
    if (ctx.signal?.aborted) {
      log(`    收到取消，停在轮次边界`);
      return null;
    }
    // 收口轮是流程必经：它既不该占预算，也不该被「预算/打回次数」拦住，
    // 否则最后一步永远拿不到结论。约束只作用在「往下一层派活」上。
    if (review) {
      // 但「不占预算」不等于可以无限跑：每次都是在调模型。这里单独计数，
      // 超过上限就收场，不让「打回—重判」变成死循环（审计 P1-6）
      const nth = (reviewRounds.get(n.id) ?? 0) + 1;
      reviewRounds.set(n.id, nth);
      if (nth > MAX_REVIEW_ROUNDS) {
        log(`    ${n.id} 收口已经跑了 ${nth - 1} 轮，不再继续`);
        return closeBlocked(
          n,
          parent,
          origin || t,
          `同一件事的收口跑了 ${MAX_REVIEW_ROUNDS} 轮还没结论，需要你看一眼`,
        );
      }
    } else {
      // 空转判定只看这个节点自己的历史：并发下 thisRun 的顺序是完成顺序，
      // 拿全树的打回混在一起比，会把两条不同线的正常打回误判成同一段话在重复
      const verdict = guard(thisRun.filter((r) => r.node === n.id), budget);
      if (verdict.stop) {
        log(`    守门员叫停：${verdict.why}`);
        return null;
      }
      budget -= 1;
    }

    const rec = await runOne(n, t, parent, review, reviewArtifacts);
    // 每一轮自己写的东西都记到节点名下：中间层的验收轮通常不写文件，
    // 只在最后统一记的话，它上一轮的产物会丢（多层树里 a 就核不到 b 交过什么）
    remember(n.id, rec.artifacts);

    // 留言独立于派活：执行者这一轮没有 dispatch，但它写下的话照样要送出去。
    // （放错地方过一次：写在「有 dispatch 才继续」的分支后面，执行者的留言全丢了。）
    for (const m of rec.tell ?? []) {
      if (m.to === n.id) {
        log(`  留言给 ${m.to}：不能发给自己，忽略`);
        continue;
      }
      if (!cfg.nodes.some((x) => x.id === m.to)) {
        log(`  留言给 ${m.to}：树上没有这个节点，忽略`);
        continue;
      }
      addMessage(ctx.db, ctx.taskId, rec.id, n.id, m.to, m.msg);
      log(`  留言 → ${m.to}：${m.msg.slice(0, 50)}`);
    }

    if (rec.state !== 'done') return rec;

    const reports: string[] = [];
    /** 下级这一轮交上来的产物，收口时用来核 evidence（主控自己通常不写文件） */
    let childArtifacts: Artifact[] = [];

    // 先处理派生：dispatch 里可能就点着这些新名字，节点必须先加进树，后面才路由得到。
    // 这一句必须在「dispatch 为空就返回」之前：模型完全可以只申请开一条新线、
    // 这一轮不派活（spawn=[...] 且 dispatch=[]），提前返回的话审批单根本不会创建，
    // 请求就这么静默丢了（审计 P0-3）。
    const spawnRes = rec.spawn?.length
      ? await applySpawns(n, rec, reports, {
          db: ctx.db, taskId: ctx.taskId, root: ctx.root, signal: ctx.signal, cfg, log, spawnedCount,
        })
      : { approved: new Map<string, string>(), spawnedCount };
    const approvedTasks = spawnRes.approved;
    spawnedCount = spawnRes.spawnedCount;

    // 派生没落地（被拒绝 / 到上限）时 reports 里已经有说明。
    // 以前这里直接 return rec：任务显示 done，拒绝原因也被丢掉，人根本不知道派生没开成。
    // 只对主控算数——叶节点顺手提了一个非法派生，不该把它已经交付的活拦下来。
    const spawnBlocked = n.id === cfg.root.id && reports.length > 0;

    // 下级点名在问本节点，它却直接判了通过：不能让它就这么收场。
    // 再收口一次，把问题顶到简报最前面，逼它二选一（派回去回答 / 升级给人）。
    // 上限由 MAX_REVIEW_ROUNDS 兜底，不会无限循环。
    const pending = review ? (pendingAsks.get(n.id) ?? []) : [];
    if (!rec.dispatch.length && !approvedTasks.size && !spawnBlocked
        && pending.length && rec.verdict === 'rework') {
      log(`  再收口一次：必须回答 ${pending.length} 个下级的提问`);
      const askBrief = [
        ...(origin ? ['## 原始任务（验收以这个为准）', origin, ''] : []),
        '## 你上一轮判了通过，但下级还在等你回答',
        ...pending.map((a) => `- ${a.from ?? '下级'} 问：${a.question}`),
        '',
        '这一轮必须二选一，不能再直接判通过：',
        '1. 你能量：在 dispatch 里派回提问的那个节点，把答案写在 task 开头，让它带着答案接着干',
        '2. 你定不了：用自己的 question 升级给人，写清需要谁拍板、拍什么',
      ].join('\n');
      return await step(n, askBrief, rec.id, true, origin || t, verifyTry, reviewArtifacts);
    }

    // 阶段推进：收口判 pass 只代表「这一段过了」。
    // 以前一个任务 = 派活 → 收口 → 结束，#45 的四段审计第一段跑完就判 pass，
    // 标记/隔离/冒烟三段压根没开始，而任务显示「完成」。
    // 现在主控用 plan 声明段落，这里负责推着往下走，全部段落完成才真的收尾。
    if (review && rec.verdict === 'pass') {
      const st = getPhases(ctx.db, ctx.taskId);
      if (st.plan.length >= 2) {
        const pending = st.plan.filter((p) => !st.done.includes(p.id));
        // 进度由引擎说了算：当前就是第一个未完成的段。
        // 不能让模型用 phase 字段决定推哪一段——实测里它会把「第 1 段」写到底
        // （收口轮看到的是原始任务，不是阶段简报），结果第 2 段被反复推进。
        const expected = pending[0];
        if (rec.phase && expected && rec.phase !== expected.id) {
          log(`  回执 phase=${rec.phase} 与引擎推进的第 ${expected.id} 段不一致，按引擎为准`);
        }
        const curId = expected?.id;
        if (curId) {
          const done = st.done.includes(curId) ? st.done : [...st.done, curId];
          savePhases(ctx.db, ctx.taskId, st.plan, done);
          const rest = st.plan.filter((p) => !done.includes(p.id));
          if (rest.length) {
            const next = rest[0];
            const nth = st.plan.findIndex((p) => p.id === next.id) + 1;
            // 阶段推进是计划内的活，不是空转：给它补一段预算，否则四段根本跑不完
            budget += 3;
            // 换段就是换一件事，收口计数必须清零。
            // 不清的话：协议允许 8 段，而单节点收口上限是 6 次，
            // 7–8 段的任务即使每段一次通过，也会在第 7 段前被 blocked（审计 M4）
            reviewRounds.set(n.id, 0);
            log(`  第 ${nth}/${st.plan.length} 段：${next.name}（上一段 ${curId} 已过，继续）`);
            return await step(n, buildPhaseBrief(st.plan, done, next), rec.id, false, origin || t, 0, []);
          }
          log(`  阶段全部完成：${st.plan.map((p) => p.name).join(' → ')}`);
        }
      }
    }

    if (!rec.dispatch.length && !approvedTasks.size && !spawnBlocked) {
      // 收口轮判了通过，但给的证据在产物里一段都搜不到：多半没打开文件。
      // 只补验一次，把「你的结论被驳回」拍回去，让它重读产物再判。
      if (review && rec.verdict === 'rework' && verifyTry < 1) {
        const miss = evidenceProblem(rec.evidence, reviewArtifacts ?? rec.artifacts);
        if (miss.length) {
          log(`  证据核不上，要求重读产物再判一次（补验 ${verifyTry + 1}/1）`);
          const again = buildVerifyBrief(origin, miss);
          return await step(n, again, rec.id, true, origin || t, verifyTry + 1, reviewArtifacts);
        }
      }
      return rec;
    }

    const kids = childrenOf(cfg, n.id);
    const plan = planRoutes({
      parentId: n.id,
      dispatch: rec.dispatch,
      kids,
      runs: thisRun,
      currentRunId: rec.id,
      approved: approvedTasks,
      maxFanout: MAX_FANOUT,
      maxRework: MAX_REWORK,
      log,
    });
    reports.push(...plan.reports);
    const list = plan.list;
    const dropped = plan.dropped;

    // routed 为空：这一轮的派活全被拦下（没有这个下级 / 打回到上限 / 指令重复 / 派生被拒）。
    // 此时再跑一轮收口，模型看到的东西和上一轮几乎一样，会原样再写一遍 dispatch，
    // 然后又被拦下——而收口轮不扣 budget，这就是那个可以无限烧的循环。
    if (!list.length) {
      const why = rec.dispatch.length
        ? `这一轮派出去的 ${rec.dispatch.length} 条活全部被拦下（打回次数到上限或指令重复），需要你换个方向`
        : rec.spawn?.length
          ? `申请的 ${rec.spawn.length} 条派生都没落地（被拒绝或达到上限），这一轮也没有别的派活`
          : '这一轮没有产生可执行的派活';
      return closeBlocked(n, rec.id, origin || t, why);
    }

    if (list.length > 1) {
      const lanes = new Set(list.map((d) => d.to)).size;
      log(`  派活：${list.length} 条 / ${lanes} 条车道 / 车位上限 ${(ctx.pool ?? FALLBACK_POOL).limit}`);
    }
    const results = await runLanes(
      list,
      (d) => {
        const kid = kids.find((k) => k.id === d.to)!;
        return step(kid, d.task, rec.id, false, '');
      },
      { laneOf: (d) => d.to },
    );
    // 用子树累计而不是 r.value.artifacts：多层级树里中间层返回的是自己的验收记录，
    // 那一条通常不写文件，只看它会得到空清单，收口就等于没核（P0-2 多层缺口）
    childArtifacts = list.flatMap((d, i) => {
      const r = results[i];
      if (!r?.ok || !r.value) return [];
      return delivered.get(d.to) ?? r.value.artifacts;
    });
    // 子孙交的东西也算在 n 名下：a 的收口轮只看「b 交了什么」，
    // 而 b 常常只是把 c 的东西收上来。不往上合并，a 仍然拿到空清单（P0-2 多层缺口）
    for (const d of list) {
      const sub = delivered.get(d.to);
      if (sub?.length) remember(n.id, sub);
    }

    // 每一路都要有一份交代：抛异常、被守门员跳过，都不能让收口以为这条活派丢了
    /** 下级点名问本节点的那些问题。收口时如果它直接判通过、也不派回去，等于把问题吞了 */
    const asksFromKids: Ask[] = [];
    list.forEach((d, i) => {
      const kid = kids.find((k) => k.id === d.to)!;
      const r = results[i];
      if (!r || !r.ok) {
        const why = r && !r.ok ? r.error : '没有拿到结果';
        log(`  ${d.to} 这一路没跑成：${why}`);
        reports.push(`### ${kid.id}（${kid.name}）· ERROR\n- 这一路执行时抛异常：${why}`);
        return;
      }
      if (!r.value) {
        const why = ctx.signal?.aborted
          ? '收到取消，停在轮次边界'
          : '守门员叫停（轮次预算用完，或同一件事反复打回）';
        log(`  ${d.to} 这一路被跳过：${why}`);
        reports.push(`### ${kid.id}（${kid.name}）· SKIPPED\n- 这条线没跑：${why}`);
        return;
      }
      for (const a of r.value.ask ?? []) {
        if (a.to === n.id) asksFromKids.push(a);
      }
      reports.push(reportText(r.value, kid));
    });
    if (asksFromKids.length) {
      pendingAsks.set(n.id, asksFromKids);
      log(`  待回答：${asksFromKids.map((a) => a.from + ' 问「' + a.question.slice(0, 30) + '」').join(' / ')}`);
    } else {
      pendingAsks.delete(n.id);
    }
    // 被截断的那些也要让收口看见，否则主控以为全派出去了
    for (const d of dropped) {
      const kid = kids.find((k) => k.id === d.to)!;
      reports.push(
        `### ${kid.id}（${kid.name}）· SKIPPED\n- 这一轮派活超过上限 ${MAX_FANOUT} 条，这条没有执行：${d.task.slice(0, 80)}`,
      );
    }
    if (!reports.length) return rec;

    // 简报里的「原始任务」必须和第下一轮 step 拿到的 origin 是同一个：
    // 首轮 origin 是空串，真正的任务在 t 里。这里以前只传 origin，
    // 结果是收口轮看不到原始要求，主控只能凭下级摘要判「都齐了」就收场（#45 四段只做一段）。
    const brief = buildReviewBrief(origin || t, reports, asksFromKids);

    // 收口轮要核的是下级交的东西：主控自己通常不写文件，
    // 拿它的 artifacts 当核对对象等于每次都能空过（P0-2）
    log(`\n${n.id} 收口：拿到 ${reports.length} 份交付（${childArtifacts.length} 个产物），跑第二轮判断`);
    return await step(n, brief, rec.id, true, origin || t, 0, childArtifacts);
  }

  return await step(node, task, undefined, false, '');
}
