// /api/chat/*：对话的五个入口（发送、流、历史、忙碌、停止）。
//
// 抽出来单独放（决策 P1-23）。这组的共同风险是**节点名会被拼进文件路径**
// （`.data/chat/<id>.jsonl`），所以 nodeId 校验必须在这一个地方统一做，
// 而不是散在五个分支里各写一遍——散着写就容易漏掉一个（审计 M2 就是这么来的）。
//
// 另一个关键顺序：**存在性校验必须在 reset 之前**。reset 会删文件，
// 删之前得先确认这个节点真的在配置里。

import type http from 'node:http';
import path from 'node:path';
import { loadConfig } from '../../kernel/tree.ts';
import { busyNodes, chatHistory, isBusy, resetChat, startChat, stopChat, subscribe } from '../chat.ts';

/** 节点 id 的合法格式：它会被拼进文件路径，必须挡住 ../ 与斜杠 */
export const CHAT_NODE_RE = /^[A-Za-z0-9_-]{1,32}$/;

export type ChatCtx = {
  /** agents.toml 路径 */
  cfgFile: string;
  /** 单条消息上限 */
  maxLen: number;
  /** 任务快照（server 侧查库生成） */
  snapshot: () => string;
  /** 有上限的 body 读取 */
  readJson: (req: http.IncomingMessage) => Promise<Record<string, unknown>>;
  /** 统一 JSON 响应 */
  json: (res: http.ServerResponse, code: number, body: unknown) => void;
  /** 对话站的项目目录兜底（没配 project.root 时用） */
  fallbackCwd: () => string;
};

/**
 * 对话的写授权：人点了「允许修改」才会带上来。
 *
 * 校验从严：必须是绝对路径、最多 12 个、不能是目录。
 * 这一段是唯一能把 plan 模式切成可写的地方，不能靠前端自律。
 */
export function parseGrant(v: unknown): { files: string[]; reason?: string } | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const o = v as Record<string, unknown>;
  const raw = Array.isArray(o.files) ? o.files : [];
  const files = raw
    .filter((x) => typeof x === 'string')
    .map((x) => (x as string).trim())
    .filter((x) => x.length > 2 && /^[A-Za-z]:[\\/]|^\//.test(x))
    .filter((x) => !/[\\/]$/.test(x))
    .slice(0, 12);
  if (!files.length) return undefined;
  return {
    files,
    reason: typeof o.reason === 'string' ? o.reason.slice(0, 200) : undefined,
  };
}

/**
 * 处理 /api/chat/*。
 *
 * @returns true 表示已处理（调用方直接 return）；false 表示不是这组路由
 */
export async function handleChat(
  p: string,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  ctx: ChatCtx,
): Promise<boolean> {
  if (p === '/api/chat/stream') {
    const nodeId = url.searchParams.get('node') || '';
    if (!CHAT_NODE_RE.test(nodeId)) { ctx.json(res, 400, { error: 'node 不合法' }); return true; }
    const off = subscribe(nodeId, res);
    req.on('close', off);
    return true;
  }

  if (p === '/api/chat/busy') {
    // 界面据此点亮正在对话的 agent 格子
    ctx.json(res, 200, { nodes: busyNodes() });
    return true;
  }

  if (p === '/api/chat/history') {
    const nodeId = url.searchParams.get('node') || '';
    // 同样会读 .data/chat/<id>.jsonl，格式不合法直接拒
    if (!CHAT_NODE_RE.test(nodeId)) { ctx.json(res, 400, { error: 'node 不合法' }); return true; }
    ctx.json(res, 200, { messages: chatHistory(nodeId), busy: isBusy(nodeId) });
    return true;
  }

  if (p === '/api/chat' && req.method === 'POST') {
    const body = await ctx.readJson(req);
    const nodeId = String(body.nodeId || '');
    const text = String(body.text || '').trim();
    // nodeId 会被拼进文件路径（.data/chat/<id>.jsonl）。
    // 不先卡格式，`../marker` 就能删/读聊天目录外的文件（审计 M2）。
    if (!CHAT_NODE_RE.test(nodeId)) { ctx.json(res, 400, { error: 'nodeId 不合法' }); return true; }
    let cfg;
    try { cfg = loadConfig(ctx.cfgFile); } catch (e) { ctx.json(res, 500, { error: String(e) }); return true; }
    // 存在性校验必须在 reset 之前：reset 会删文件，删之前得先确认这个节点真的存在
    const node = cfg.nodes.find((n) => n.id === nodeId);
    if (!node) { ctx.json(res, 404, { error: `没有节点 ${nodeId}` }); return true; }
    if (body.reset) {
      if (isBusy(nodeId)) { ctx.json(res, 400, { error: '它还在答，先停一下' }); return true; }
      resetChat(nodeId);
      ctx.json(res, 200, { ok: true, reset: true });
      return true;
    }
    if (!text) { ctx.json(res, 400, { error: '没写内容' }); return true; }
    if (text.length > ctx.maxLen) { ctx.json(res, 400, { error: `一句话最多 ${ctx.maxLen} 字` }); return true; }
    const r = startChat({
      nodeId,
      text,
      model: node.model,
      // 对话是「人在问项目」，默认站在项目根，而不是空的任务工作区
      cwd: process.env.MA_CHAT_CWD || cfg.project?.root || ctx.fallbackCwd(),
      plugin: node.plugin,
      taskSnapshot: ctx.snapshot(),
      projectName: cfg.project?.name || '',
      projectRoot: cfg.project?.root || '',
      // 写授权：只有用户点过「允许修改」才带过来。没带就是只读（plan 模式）
      grant: parseGrant(body.grant),
    });
    if (!r.ok) { ctx.json(res, 409, { error: r.error }); return true; }
    ctx.json(res, 202, { ok: true });
    return true;
  }

  if (p === '/api/chat/stop' && req.method === 'POST') {
    const body = await ctx.readJson(req);
    const nodeId = String(body.nodeId || '');
    ctx.json(res, 200, { ok: stopChat(nodeId) });
    return true;
  }

  return false;
}

/** 对话站在哪个目录：配置里没写 project.root 时的兜底 */
export function chatFallbackCwd(cfgFile: string): string {
  return path.join(path.dirname(cfgFile), '..', 'Game');
}
