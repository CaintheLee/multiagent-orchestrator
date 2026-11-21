import { CONFIG_FILE } from '../kernel/paths.ts';
// 派生：模型申请新开一条产线，人点头才生效。
//
// 从 runTree 里抽出来的原因：这里是「开一条新产线」的全部规则（谁有资格提、
// 单任务上限、总节点上限、role/model 合法性、审批阻塞），和主循环纠缠在一起时
// 很难单独审查。抽出来后 runTree 只负责「调它、拿结果、继续派活」。
import type { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { DEFAULT_SPAWN, resolveWorkspace, MAX_NODES, type Config, type NodeConfig } from '../kernel/tree.ts';
import { mutateConfig } from '../kernel/config-lock.ts';
import { MAX_SPAWN_PER_TASK, waitApproval } from '../kernel/approval.ts';
import { roleExists } from '../kernel/roles.ts';
import { supportsReadOnly } from '../adapters/table.ts';
import { addApproval, getApproval } from '../store/approvals.ts';
import type { RunRecord } from '../store/runs.ts';

export type Logger = (line: string) => void;

/** 派生申请的任务描述下限：范围/交付物/验收/硬约束四件事写全，基本不会少于这个字数 */
export const MIN_SPAWN_TASK = 60;
/** 申请理由下限：只写「需要新线」不算理由 */
export const MIN_SPAWN_WHY = 12;

/** 派生节点的 role 会被拼成 prompts/<role>.md：只认安全短名，堵住 ../ 穿越 */
const SAFE_ROLE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
/** model 会原样进 argv（--model <值>）：以 - 开头的值会被 CLI 当成另一个 flag */
const SAFE_MODEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export type SpawnEnv = {
  db: DatabaseSync;
  taskId: number;
  root: string;
  signal?: AbortSignal;
  cfg: Config;
  log: Logger;
  /** 本任务已经派生出来的数量（调用方持有，函数返回最新值） */
  spawnedCount: number;
};

export type SpawnResult = {
  /** name → 批准时人看到的那个 task。执行文本以它为准 */
  approved: Map<string, string>;
  spawnedCount: number;
};

export async function applySpawns(
  n: NodeConfig,
  rec: RunRecord,
  reports: string[],
  env: SpawnEnv,
): Promise<SpawnResult> {
  const { cfg, log } = env;
  const approved = new Map<string, string>();
  const reqs = rec.spawn ?? [];
  /** 开线策略：autoApprove 决定要不要等人，defaultsEnabled 决定参数从哪来 */
  const settings = cfg.spawn ?? DEFAULT_SPAWN;
  let spawned = env.spawnedCount;
  if (!reqs.length) return { approved, spawnedCount: spawned };

  // 只有根节点能开新线。中间层也繁殖，树就变成一张谁也说不清的网
  if (n.id !== cfg.root.id) {
    log(`  ${n.id} 不是主控，${reqs.length} 个派生请求一律拒绝`);
    for (const s of reqs) {
      reports.push(`### ${s.name} · SKIPPED\n- 只有主控能申请派生，${n.id} 不是主控`);
    }
    return { approved, spawnedCount: spawned };
  }

  for (const s of reqs) {
    // 已有同名节点：直接派给它就行，不用新建，也不用麻烦人去批
    if (cfg.nodes.some((x) => x.id === s.name)) {
      log(`  派生 ${s.name}：树上已经有这个节点，直接复用`);
      continue;
    }
    if (spawned >= MAX_SPAWN_PER_TASK) {
      log(`  派生 ${s.name}：本次任务已经派生 ${spawned} 个，到上限了`);
      reports.push(`### ${s.name} · SKIPPED\n- 本次任务已派生 ${spawned} 个，达到上限 ${MAX_SPAWN_PER_TASK}`);
      continue;
    }
    if (cfg.nodes.length >= MAX_NODES) {
      log(`  派生 ${s.name}：节点总数已经到 ${MAX_NODES}`);
      reports.push(`### ${s.name} · SKIPPED\n- 节点总数已达上限 ${MAX_NODES}`);
      continue;
    }

    if (s.model && !SAFE_MODEL.test(s.model)) {
      // 退回上级模型而不是拒绝整条派生：模型名写坏不该让一条本来要开的线作废，
      // 但也不能把 "--xxx" 这样的值原样塞进 argv
      log(`  派生 ${s.name}：model「${s.model}」不像模型名，退回 ${n.model || '默认模型'}`);
    }
    /**
     * 参数优先级：模型给的（合法）> 标准设置（启用时）> 继承主控。
     * 标准设置只在 defaultsEnabled 时参与，关掉就完全退回老行为——
     * 两个开关必须互不影响，否则「关掉标准设置」还会残留影响。
     */
    const st = settings.defaultsEnabled ? settings : null;
    let model = s.model && SAFE_MODEL.test(s.model) ? s.model : (st?.model || n.model);
    let role = s.role || st?.role || 'executor';
    let timeoutMin = st ? st.timeoutMin : n.timeoutMin;
    // access 只在 provider 支持只读时才有意义；配置里写错大小写或别的词时，
    // 一律按 write 处理并留痕——静默降级成只读反而更危险（以为拦住了其实没拦）
    const pickAccess = (v: unknown): 'read' | 'write' => (v === 'read' ? 'read' : 'write');
    let access: 'read' | 'write' = pickAccess(st ? st.access : n.access);
    if ((st ? st.access : n.access) !== access) {
      log(`  派生 ${s.name}：access「${String(st ? st.access : n.access)}」不认识，按 write 处理`);
    }
    let taskText = st?.taskPrefix ? st.taskPrefix + '\n\n' + s.task : s.task;
    // role 会被拼成 prompts/<role>.md 的路径：必须在这里挡住 "../x" 这类穿越，
    // 否则一条派生就能把 prompts 之外的 Markdown 读进后续所有提示词。
    // 安全校验排最前：不合法的请求不该占用一次人的注意力，也不该先被别的检查兜走。
    if (!SAFE_ROLE.test(role)) {
      log(`  派生 ${s.name}：role「${role}」不合法，拒绝`);
      reports.push(
        `### ${s.name} · SKIPPED\n- role「${role}」不合法：只能是 1–32 位字母、数字、下划线、连字符`,
      );
      continue;
    }
    // role 必须对应 prompts/ 里的模板：写个不存在的名字会静默退化成通用兜底，
    // 跑出来的活没有角色约束，而且没人知道（这是「职责没有预设模板」的根因）
    if (!roleExists(role)) {
      log(`  派生 ${s.name}：role「${role}」没有对应模板，退回 executor`);
      role = 'executor';
    }
    // 申请里没写清楚要它做什么，就别开：一条新线开出来要跑一整轮、还要落盘占节点，
    // 任务含糊的派生线只会产出一堆没人能验收的东西。按长度兜底，四件事（范围/交付物/
    // 验收/硬约束）写全基本不会少于 60 字。放在审批之前：不值得占人一次注意力。
    // why 短只记提示不拒——它不是产出质量的关口，拒了只会多一次往返。
    const bodyLen = String(s.task || '').replace(/\s+/g, '').length;
    if (bodyLen < MIN_SPAWN_TASK) {
      const why = `task 只有 ${bodyLen} 字，至少要 ${MIN_SPAWN_TASK} 字：写清做什么、交付物放哪、怎么算通过、不许动什么`;
      log(`  派生 ${s.name} 被拒：${why}`);
      reports.push(`### ${s.name} · SKIPPED\n- ${why}\n- 你写的是：${String(s.task || '（空）').slice(0, 100)}`);
      continue;
    }
    if (String(s.why || '').replace(/\s+/g, '').length < MIN_SPAWN_WHY) {
      log(`  提示  派生 ${s.name} 的 why 偏短：「${String(s.why || '').slice(0, 40)}」`);
    }

    /**
     * 两条路：
     * - 已授权给主控：不建审批单、不等待，直接按当前参数开线
     * - 未授权：建审批单等人；人可以在弹窗里改参数，批准后以审批单里的值为准
     * 两个开关互不影响：autoApprove 关掉就回到等人，标准设置照样预填。
     */
    if (settings.autoApprove) {
      log(`  派生 ${s.name}：开线已授权给主控，自动批准${st ? '（套用标准设置）' : ''}`);
    } else {
      const approvalId = addApproval(env.db, env.taskId, rec.id, 'spawn', {
        name: s.name,
        why: s.why,
        parent: n.id,
        model,
        role,
        task: taskText,
        timeout_min: timeoutMin,
        access,
      });
      log(`  派生 ${s.name}：等你批准（审批 #${approvalId}）—— ${s.why}`);

      const decision = await waitApproval(env.db, approvalId, env.signal);
      if (decision !== 'approved') {
        const why = decision === 'canceled'
          ? '任务被取消'
          : decision === 'expired'
            ? '没人处理，按拒绝算'
            : '你拒绝了';
        log(`  派生 ${s.name} 没通过：${why}`);
        reports.push(`### ${s.name} · SKIPPED\n- 派生请求未获批准（${why}）\n- 原计划派给它的活：${taskText.slice(0, 120)}`);
        continue;
      }
      // 人可能在确认窗口里改过参数：以审批单里的最终值为准，不用模型最初给的那份
      const fin = getApproval(env.db, approvalId);
      if (fin?.payload){
        try {
          const p = JSON.parse(String(fin.payload)) as Record<string, unknown>;
          const nextRole = typeof p.role === 'string' ? p.role : '';
          const nextModel = typeof p.model === 'string' ? p.model : '';
          if (SAFE_ROLE.test(nextRole) && nextRole !== role) role = nextRole;
          if (nextModel && nextModel !== model) model = nextModel;
          if (typeof p.timeout_min === 'number' && Number.isFinite(p.timeout_min)){
            timeoutMin = Math.min(120, Math.max(1, Math.round(p.timeout_min)));
          }
          if (p.access === 'read' || p.access === 'write') access = p.access;
          if (typeof p.task === 'string' && p.task.trim()) taskText = p.task.trim();
          log(`  派生 ${s.name}：按审批参数开线（${role} / ${model || '继承'} / ${timeoutMin}min / ${access}）`);
        } catch {}
      }
    }

    // 只读不是装饰：provider 做不到就拒，不能静默按 write 跑。
    // 否则审批弹窗上写着「只读」，实际拿的是 -y 全权限（审计 M3）。
    if (access === 'read' && !supportsReadOnly(n.plugin)) {
      const why = `${n.plugin} 没有真正的只读模式（生成的参数与 write 完全相同），不能按「只读」开线`;
      log(`  派生 ${s.name} 没通过：${why}`);
      reports.push(`### ${s.name} · SKIPPED\n- ${why}\n- 想只读梳理就换成 codex 节点，或接受 write 权限`);
      continue;
    }

    const raw: NodeConfig = {
      id: s.name,
      parent: n.id,
      name: s.name,
      plugin: n.plugin,
      workspace: 'spawn-' + s.name,
      timeoutMin,
      access,
      role,
      model,
      // 派生节点继承 root 的外部可写目录：不继承的话，它写共享目录会被判越界，
      // 而派它的主控根本不会想到这一层。老配置/测试里可能没这个字段，兜一下
      extraDirs: [...(env.cfg.root.extraDirs ?? [])],
      spawned: true,
    };
    cfg.nodes.push({ ...raw, workspace: resolveWorkspace(raw, env.taskId, env.root) });
    spawned += 1;
    approved.set(s.name, taskText);
    // 落盘。以前这里写的是「临时节点，不写配置」——结果是：任务里跑得通，
    // 但主页面（/api/agents 读 agents.toml）看不到这条线，下个任务也不存在它。
    // 人批准开了一条线却找不到它，比不开更糟（#47 setmap）。
    // workspace 用 raw 里的相对名，别把 resolve 后的 .sandbox 路径写进配置。
    try {
      // 走公共配置锁：派生、界面保存、改设置、增删节点共用一条队列，
      // 谁也不会有「我拿的是旧快照」这种窗口（审计 M5）。
      const wrote = await mutateConfig(CONFIG_FILE, (disk) => {
        if (disk.nodes.some((x) => x.id === s.name)) return false;
        disk.nodes.push({ ...raw });
        return true;
      });
      log(
        wrote
          ? `  派生 ${s.name} 已批准，已写入配置——刷新页面就能在树上看到`
          : `  派生 ${s.name} 已批准（配置里已有同名节点，不重复写）`,
      );
    } catch (e) {
      log(`  派生 ${s.name} 已批准，但写配置失败：${String(e)}（本次任务内仍可用）`);
    }
  }
  return { approved, spawnedCount: spawned };
}
