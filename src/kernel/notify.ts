// 任务通知：任务进终态时喊一声。
//
// 为什么需要（2026-11-21 决策 P1-8）：
// 一个任务要跑十几分钟到几十分钟，人不可能一直盯着界面。
// 真正需要「立刻知道」的只有三种：卡住等你回答、失败、跑完了。
//
// 两条通道：
// 1. **站内**：界面轮询发现状态变化就弹提示，零配置、永远可用。
// 2. **微信**：一个 webhook，按 URL 形态自动适配企业微信 / Server酱 / PushPlus / 通用 JSON。
//    没配就只走站内——不能因为没配通道把功能卡住。
//
// 硬约束：发通知失败**只记日志**。通知是为了方便，不能反过来把任务搞挂。

import type { NotifySettings, NotifyTarget } from './tree.ts';

/** 默认只报这三类：其他状态不值得打扰 */
export const DEFAULT_NOTIFY_ON = ['blocked', 'failed', 'done'];

const TIMEOUT_MS = 5000;

const LABEL: Record<string, string> = {
  done: '已完成',
  failed: '失败',
  blocked: '卡住等你回答',
  canceled: '被取消',
  paused: '已暂停',
  interrupted: '被打断',
};

/** 状态中文名，通知标题和界面共用一套说法 */
export function stateText(state: string): string {
  return LABEL[state] || state;
}

/**
 * 一条通知的正文。
 *
 * 刻意短：微信通知在锁屏上只显示前两行，写长了等于没写。
 * 要细节就点进界面看，通知只负责「哪件事、什么结果」。
 */
export function notifyText(taskId: number, state: string, task: string, why?: string): string {
  const head = `任务 #${taskId} ${stateText(state)}`;
  const body = String(task || '').replace(/\s+/g, ' ').slice(0, 80);
  const tail = why ? `\n原因：${String(why).replace(/\s+/g, ' ').slice(0, 120)}` : '';
  return `${head}\n${body}${tail}`;
}

/**
 * 按 webhook 的地址判断该发什么格式。
 *
 * 不要求用户选「这是哪家」：地址本身已经说明了。认不出来就发通用 JSON，
 * 对方能不能收是它的事——总比因为格式判断失败一条都不发强。
 */
export function payloadFor(target: NotifyTarget, text: string): { body: unknown; hint: string } {
  const url = String(target.webhook || '');
  if (/qyapi\.weixin\.qq\.com/.test(url)) {
    // 企业微信群机器人
    return { body: { msgtype: 'text', text: { content: text } }, hint: '企业微信' };
  }
  if (/sctapi\.ftqq\.com|sct\.ftqq\.com/.test(url)) {
    // Server酱：title + desp
    const [first, ...rest] = text.split('\n');
    return { body: { title: first.slice(0, 32), desp: rest.join('\n') || first }, hint: 'Server酱' };
  }
  if (/pushplus\.plus/.test(url)) {
    const [first, ...rest] = text.split('\n');
    return { body: { title: first.slice(0, 32), content: rest.join('\n') || first }, hint: 'PushPlus' };
  }
  return { body: { text, content: text }, hint: '通用 JSON' };
}

/** 这条状态该不该发 */
export function shouldNotify(settings: NotifySettings | undefined, state: string): boolean {
  if (!settings) return false;
  const on = settings.on?.length ? settings.on : DEFAULT_NOTIFY_ON;
  return on.indexOf(state) >= 0;
}

export type NotifyResult = { ok: boolean; hint?: string; status?: number; error?: string };

/**
 * 真正发出去。调用方 fire-and-forget，不要 await 在任务路径上。
 */
export async function sendWebhook(target: NotifyTarget, text: string): Promise<NotifyResult> {
  const { body, hint } = payloadFor(target, text);
  try {
    const r = await fetch(target.webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return { ok: r.ok, hint, status: r.status, error: r.ok ? undefined : `HTTP ${r.status}` };
  } catch (e) {
    return { ok: false, hint, error: String((e as Error).message ?? e).slice(0, 160) };
  }
}
