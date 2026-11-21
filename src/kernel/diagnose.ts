// 失败诊断：任务 failed 之后，再问主控一次「为什么失败、下一步怎么办」。
//
// 为什么值得多花一次调用（2026-11-21 决策 P1-7）：
// 失败时人看到的是「failed + 一句错误」，真正的原因散在几轮日志和产物里。
// 让主控自己读一遍再给结论，比人翻日志快得多，而且它的结论能直接当下一轮的输入。
//
// 三条约束：
// 1. **只诊断，不动手**：提示词明确禁止它改文件、派活、开线。
// 2. **失败不影响任何东西**：诊断本身出错就记一条日志，任务状态早就定了。
// 3. **结果落文件**：`DATA_DIR/diagnosis/<taskId>.md`，界面按需读，不塞进数据库。

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './paths.ts';

/** 诊断结论最多留这么多字，再长也没人看 */
const MAX_DIAG = 8000;

export type DiagnosisInput = {
  taskId: number;
  task: string;
  state: string;
  /** 出错原因（任务表里的 error_message） */
  error: string;
  /** 各轮摘要，按发生顺序 */
  runs: Array<{
    id: number;
    node: string;
    state: string;
    verdict?: string | null;
    ms: number;
    summary?: string;
    error?: string;
    artifacts?: Array<{ path?: string }>;
    warnings?: string[];
  }>;
};

/**
 * 诊断提示词。
 *
 * 刻意要求「引用具体轮次」：不引用的话，模型很容易写一段放之四海而皆准的建议，
 * 那种东西人看一眼就知道没用，等于白花钱。
 */
export function buildDiagnosisBrief(inp: DiagnosisInput): string {
  const lines: string[] = [];
  lines.push('## 角色');
  lines.push('你是这次任务的主控。任务已经失败了，现在只做复盘，不要动手。');
  lines.push('');
  lines.push('## 原始任务（节选）');
  lines.push(inp.task.slice(0, 3000));
  lines.push('');
  lines.push('## 失败现场');
  lines.push(`- 终态：${inp.state}`);
  lines.push(`- 系统记录的原因：${inp.error || '（没写）'}`);
  const total = inp.runs.length;
  lines.push(`- 一共跑了 ${total} 轮：`);
  for (const r of inp.runs.slice(-12)) {
    const bits = [`#${r.id} ${r.node} ${r.state}`, `${Math.round(r.ms / 1000)}s`];
    if (r.verdict) bits.push(`判 ${r.verdict}`);
    const head = String(r.summary || '').replace(/\s+/g, ' ').slice(0, 160);
    lines.push(`  - ${bits.join(' · ')}${head ? ' — ' + head : ''}`);
    if (r.error) lines.push(`      错误：${String(r.error).slice(0, 160)}`);
    for (const w of (r.warnings ?? []).slice(0, 2)) {
      lines.push(`      提示：${String(w).slice(0, 160)}`);
    }
    const arts = (r.artifacts ?? []).map((a) => String(a.path ?? '')).filter(Boolean);
    if (arts.length) {
      lines.push(`      产物 ${arts.length} 个：${arts.slice(0, 3).join('、')}${arts.length > 3 ? ' …' : ''}`);
    }
  }
  lines.push('');
  lines.push('## 你要回答的（按这个结构，不要写别的）');
  lines.push('### 1. 直接原因');
  lines.push('一句话说清「哪一轮、哪个节点、因为什么」停下的。必须引用轮次编号或报错原文。');
  lines.push('');
  lines.push('### 2. 根因');
  lines.push('往上一层看：是需求没说清、验收口径不对、产物越界、超时、还是模型理解错？');
  lines.push('如果证据不足以下结论，就写「证据不足」并说明还缺什么。');
  lines.push('');
  lines.push('### 3. 现在能做什么（选一个）');
  lines.push('- **直接续跑**：已完成的段落能复用，补跑哪一段就行（写明哪一段）');
  lines.push('- **改需求再跑**：任务本身要改（写明改哪句）');
  lines.push('- **先修环境/配置**：问题不在任务（写明改什么）');
  lines.push('- **放弃**：这件事当前条件下做不成（写明为什么）');
  lines.push('');
  lines.push('### 4. 下一轮的具体指令');
  lines.push('如果建议续跑，给出可以直接粘贴的任务描述（不超过 300 字）。');
  lines.push('');
  lines.push('## 硬约束');
  lines.push('- 只输出上面四节，不要写开场白和总结');
  lines.push('- 每一条结论都要能指向具体的轮次或文件；指不出来就写「推测」');
  lines.push('- 不要派活、不要开线、不要改任何文件');
  return lines.join('\n');
}

/**
 * 从模型输出里取出诊断正文。
 *
 * 不解析结构化字段：诊断是给人读的，硬套 JSON 只会让模型为了格式牺牲内容。
 * 只剥掉可能存在的回执块（它习惯性会写）。
 */
export function cleanDiagnosis(stdout: string): string {
  let s = String(stdout || '');
  // 万一它写了回执块，整块丢掉
  s = s.replace(/```agent-autoloop[\s\S]*?```/g, '');
  s = s.trim();
  return s.slice(0, MAX_DIAG);
}

function diagPath(taskId: number): string {
  return path.join(DATA_DIR, 'diagnosis', String(taskId) + '.md');
}

export function saveDiagnosis(taskId: number, text: string): string | null {
  try {
    const f = diagPath(taskId);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, text, 'utf8');
    return f;
  } catch {
    return null;
  }
}

export function loadDiagnosis(taskId: number): string {
  try {
    return fs.readFileSync(diagPath(taskId), 'utf8');
  } catch {
    return '';
  }
}
