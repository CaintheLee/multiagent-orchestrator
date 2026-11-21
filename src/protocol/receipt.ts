// 把模型吐出来的 stdout 变成 Receipt，或者明确说清为什么不行。
// 只做解析和校验，不碰文件、不起进程。
import type { Config } from '../kernel/tree.ts';
/**
 * 把不可信输入变成一段能放进错误信息的文本。
 * 不能直接用 JSON.stringify：模型给的畸形对象可能有上万层嵌套，
 * 序列化时抛 RangeError，异常会越过正常的失败返回，把这一轮卡在 running。
 */
function safeRaw(v: unknown, max = 800): string {
  try {
    const text = typeof v === 'string' ? v : JSON.stringify(v);
    return text.length > max ? text.slice(0, max) + '…' : text;
  } catch {
    return '[无法序列化]';
  }
}

import { ALLOWED_KEYS, ASK_LIMIT, ASK_MAX, PLAN_LIMIT, EVIDENCE_LIMIT, EVIDENCE_MAX, EVIDENCE_MIN, FENCE, NAME_RE, SPAWN_LIMIT, TELL_LIMIT, TELL_MAX, type Artifact, type Ask, type Dispatch, type ParseResult, type Phase, type SpawnRequest, type Tell } from './schema.ts';

export function parseReceipt(stdout: string, cfg: Config): ParseResult {
  const re = new RegExp('```' + FENCE + '\\s*\\r?\\n([\\s\\S]*?)```', 'g');
  const blocks = [...stdout.matchAll(re)];
  if (!blocks.length) {
    return { ok: false, why: '没有找到 ' + FENCE + ' 回执块', raw: stdout.slice(-1500) };
  }
  // 取最后一个：正文里可能引用过格式示例
  const body = blocks[blocks.length - 1][1].trim();

  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch (e) {
    return { ok: false, why: '回执不是合法 JSON：' + (e as Error).message, raw: body.slice(0, 800) };
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, why: '回执必须是对象', raw: body.slice(0, 800) };
  }

  const obj = data as Record<string, unknown>;
  const extra = Object.keys(obj).filter((k) => !ALLOWED_KEYS.has(k));
  if (extra.length) {
    return { ok: false, why: `回执里有不认识的字段：${extra.join(', ')}`, raw: body.slice(0, 800) };
  }

  const summary = typeof obj.summary === 'string' ? obj.summary.trim() : '';
  if (!summary) return { ok: false, why: 'summary 是空的', raw: body.slice(0, 800) };
  if ([...summary].length > cfg.maxSummary) {
    return {
      ok: false,
      why: `summary 有 ${[...summary].length} 字，超过上限 ${cfg.maxSummary}`,
      raw: summary,
    };
  }

  const artifacts: Artifact[] = [];
  for (const item of Array.isArray(obj.artifacts) ? obj.artifacts : []) {
    if (!item || typeof item !== 'object') {
      return { ok: false, why: 'artifacts 里有非对象', raw: body };
    }
    const it = item as Record<string, unknown>;
    const p = typeof it.path === 'string' ? it.path.trim() : '';
    if (!p) return { ok: false, why: 'artifacts 里有一项没有 path', raw: safeRaw(item) };
    artifacts.push({ path: p, kind: typeof it.kind === 'string' ? it.kind : '', bytes: 0 });
  }

  const dispatch: Dispatch[] = [];
  for (const item of Array.isArray(obj.dispatch) ? obj.dispatch : []) {
    if (!item || typeof item !== 'object') {
      return { ok: false, why: 'dispatch 里有非对象', raw: body };
    }
    const it = item as Record<string, unknown>;
    const to = typeof it.to === 'string' ? it.to.trim() : '';
    const task = typeof it.task === 'string' ? it.task.trim() : '';
    if (!to) return { ok: false, why: 'dispatch 里有一项没有 to', raw: safeRaw(item) };
    if (!task) return { ok: false, why: 'dispatch 里有一项没有 task', raw: safeRaw(item) };
    dispatch.push({ to, task });
  }

  // tell：给同任务里其他节点的留言。
  // 宽松处理：模型经常把数组写成单个对象；坏条目直接丢，不判整轮失败——
  // 一句话没写好不该让整份交付作废，留言只是附注。
  const tell: Tell[] = [];
  if (obj.tell !== undefined) {
    const raw = Array.isArray(obj.tell)
      ? obj.tell
      : obj.tell && typeof obj.tell === 'object'
        ? [obj.tell]
        : [];
    for (const item of raw) {
      if (!item || typeof item !== 'object') continue;
      const it = item as Record<string, unknown>;
      const to = typeof it.to === 'string' ? it.to.trim().toLowerCase() : '';
      const msg = typeof it.msg === 'string' ? it.msg.trim() : '';
      if (!NAME_RE.test(to) || !msg || [...msg].length > TELL_MAX) continue;
      tell.push({ to, msg });
    }
    if (tell.length > TELL_LIMIT) tell.length = TELL_LIMIT;
  }

  // ask：明确在问谁。和 tell 一样宽松——问题写坏了不该让整份交付作废，
  // 但至少要保证 to 是个合法的节点名或 'user'，否则父级收到也不知道找谁
  const ask: Ask[] = [];
  if (obj.ask !== undefined) {
    const raw = Array.isArray(obj.ask)
      ? obj.ask
      : obj.ask && typeof obj.ask === 'object'
        ? [obj.ask]
        : [];
    for (const item of raw) {
      if (!item || typeof item !== 'object') continue;
      const it = item as Record<string, unknown>;
      const to = typeof it.to === 'string' ? it.to.trim().toLowerCase() : '';
      const q = typeof it.question === 'string' ? it.question.trim() : '';
      const okTo = to === 'user' || NAME_RE.test(to);
      if (!okTo || !q || [...q].length > ASK_MAX) continue;
      ask.push({ to, question: q });
    }
    if (ask.length > ASK_LIMIT) ask.length = ASK_LIMIT;
  }

  // plan：阶段计划，只认第一轮给的那份。
  // 坏条目丢单条，但整份 plan 少于 2 段就当没给——一段的「计划」没有意义，
  // 让它退回到「一个任务一件事」的老行为，不要凭空制造推进
  let plan: Phase[] | undefined;
  if (obj.plan !== undefined) {
    const raw = Array.isArray(obj.plan) ? obj.plan : [];
    const out: Phase[] = [];
    for (const item of raw) {
      if (!item || typeof item !== 'object') continue;
      const it = item as Record<string, unknown>;
      const id = typeof it.id === 'string' ? it.id.trim().toLowerCase() : '';
      const name = typeof it.name === 'string' ? it.name.trim() : '';
      if (!NAME_RE.test(id) || !name) continue;
      if (out.some((p) => p.id === id)) continue;
      const doneWhen = typeof it.doneWhen === 'string' ? it.doneWhen.trim().slice(0, 300)
        : typeof it.done_when === 'string' ? it.done_when.trim().slice(0, 300) : '';
      out.push({ id, name: name.slice(0, 80), doneWhen: doneWhen || undefined });
    }
    if (out.length >= 2) plan = out.slice(0, PLAN_LIMIT);
  }

  const phase = typeof obj.phase === 'string' ? obj.phase.trim().toLowerCase() : '';

  const question = typeof obj.question === 'string' ? obj.question.trim() : undefined;

  // spawn：模型请求新开一条产线。这里只做形状校验，能不能开由审批那道关说了算
  const spawn: SpawnRequest[] = [];
  if (obj.spawn !== undefined) {
    // 单个对象也认，模型很爱把数组写成对象；形状不对照样拒，它要走审批和真金白银
    const rawSpawn = Array.isArray(obj.spawn)
      ? obj.spawn
      : obj.spawn && typeof obj.spawn === 'object'
        ? [obj.spawn]
        : null;
    if (!rawSpawn) {
      return { ok: false, why: 'spawn 必须是数组或单个请求对象', raw: body.slice(0, 800) };
    }
    for (const item of rawSpawn) {
      if (!item || typeof item !== 'object') {
        return { ok: false, why: 'spawn 里有非对象', raw: body };
      }
      const it = item as Record<string, unknown>;
      const name = typeof it.name === 'string' ? it.name.trim().toLowerCase() : '';
      if (!NAME_RE.test(name)) {
        return {
          ok: false,
          why: `spawn 的 name「${name}」不合法：1–8 位小写字母/数字/下划线/连字符`,
          raw: safeRaw(item),
        };
      }
      // why 必填：审批的人只看这一句判断值不值得开一条线，空着等于逼人去猜
      const why = typeof it.why === 'string' ? it.why.trim() : '';
      if (!why) {
        return { ok: false, why: `spawn「${name}」缺 why：要写清为什么非开这条线不可`, raw: safeRaw(item) };
      }
      const task = typeof it.task === 'string' ? it.task.trim() : '';
      if (!task) {
        return { ok: false, why: `spawn「${name}」缺 task：批准后要立刻派活，不能空着`, raw: safeRaw(item) };
      }
      spawn.push({
        name,
        why,
        task,
        model: typeof it.model === 'string' && it.model.trim() ? it.model.trim() : undefined,
        role: typeof it.role === 'string' && it.role.trim() ? it.role.trim() : undefined,
      });
    }
    if (spawn.length > SPAWN_LIMIT) spawn.length = SPAWN_LIMIT;
  }

  // evidence：判通过时用来核「你到底看没看文件」。这里只做形状校验，
  // 内容能不能在产物里搜到是 settle.ts 的事。
  const evidence: string[] = [];
  if (obj.evidence !== undefined) {
    if (!Array.isArray(obj.evidence)) {
      return { ok: false, why: 'evidence 必须是字符串数组', raw: body.slice(0, 800) };
    }
    for (const item of obj.evidence) {
      if (typeof item !== 'string') {
        return { ok: false, why: 'evidence 里只能放字符串', raw: safeRaw(item) };
      }
      const v = item.trim();
      if (!v) continue;
      const len = [...v].length;
      // 太短 / 太长的条目直接丢掉，不判整轮失败。
      // 执行者本来就不需要 evidence，它随手写一句「ok」不该让整个交付作废；
      // 条数够不够、长度达不达标，留给验收层（settle.evidenceProblem）在判 pass 时管。
      if (len < EVIDENCE_MIN || len > EVIDENCE_MAX) continue;
      evidence.push(v);
    }
    // 超量就截断，不判整轮失败：主控认真核对时很容易多给几条，
    // 因此把整份回执判死是最亏的——内容和产物本来都是好的
    if (evidence.length > EVIDENCE_LIMIT) evidence.length = EVIDENCE_LIMIT;
  }

  return { ok: true, receipt: { summary, artifacts, dispatch, evidence, spawn, tell, ask, plan, phase: phase || undefined, question } };
}
