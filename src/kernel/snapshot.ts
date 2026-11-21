// 入队时把配置定下来。任务可能跑十几分钟，期间改 agents.toml 不能让前后轮次用不同规则。
// 第一版只做"记录 + 任务内一致"；真正把快照喂给提示词，等调度器那一步。
import fs from 'node:fs';
import path from 'node:path';
import type { Config } from './tree.ts';

export type Snapshot = {
  takenAt: string;
  nodes: Array<{
    id: string;
    parent: string;
    plugin: string;
    model: string;
    access: string;
    timeoutMin: number;
    role: string;
    workspace: string;
  }>;
  limits: { maxSummary: number; maxDetail: number };
  lessons: string;
  prompts: Record<string, string>;
};

export function takeSnapshot(cfg: Config, lessons: string, root = process.cwd()): string {
  const prompts: Record<string, string> = {};
  for (const n of cfg.nodes) {
    if (prompts[n.role]) continue;
    const f = path.join(root, 'prompts', n.role + '.md');
    try {
      prompts[n.role] = fs.readFileSync(f, 'utf8');
    } catch {
      // 缺文件不是错误：buildPrompt 有内置兜底
    }
  }
  const snap: Snapshot = {
    takenAt: new Date().toISOString(),
    nodes: cfg.nodes.map((n) => ({
      id: n.id,
      parent: n.parent,
      plugin: n.plugin,
      model: n.model,
      access: n.access,
      timeoutMin: n.timeoutMin,
      role: n.role,
      workspace: n.workspace,
    })),
    limits: { maxSummary: cfg.maxSummary, maxDetail: cfg.maxDetail },
    lessons,
    prompts,
  };
  return JSON.stringify(snap);
}

export function readSnapshot(json: string): Snapshot | null {
  try {
    return JSON.parse(json) as Snapshot;
  } catch {
    return null;
  }
}
