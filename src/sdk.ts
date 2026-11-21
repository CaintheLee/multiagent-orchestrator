// 对外入口（SDK）：外部脚本、CLI 子命令、evals 只依赖这个文件。
//
// 为什么需要它：之前每个调用方都得知道 protocol/kernel/store 三层里哪个文件导出什么，
// 目录一调整就全断。这里固定一组「对外承诺」的符号，内部怎么分层不影响外面。
//
// 用法：
//   import { parseReceipt, evidenceProblem } from './src/sdk.ts';
//
// 注意：这里只导出纯逻辑（解析、校验、拼装）。真正跑树的 runTree 需要 DB 和进程，
// 不在 SDK 承诺范围内——它属于应用层，接口随时可能变。

export { parseReceipt } from './protocol/receipt.ts';
export { buildPrompt } from './protocol/prompt.ts';
export { buildResumeBrief, RESUME_MAX, RESUME_LINES } from './protocol/resume.ts';
export {
  ALLOWED_KEYS, EVIDENCE_MIN, EVIDENCE_MAX, EVIDENCE_LIMIT,
  FENCE, NAME_RE, SPAWN_LIMIT, TELL_LIMIT, TELL_MAX,
} from './protocol/schema.ts';

export {
  loadConfig, parseToml, saveConfig, childrenOf, nodeById,
  resolveWorkspace, workspaceIsIsolated, MAX_NODES,
} from './kernel/tree.ts';
export {
  checkArtifacts, evidenceProblem, verifyEvidence, hasTextArtifacts, inside,
} from './kernel/settle.ts';
export { guard, reworkTimes, sameInstructionTimes, MAX_REWORK } from './kernel/guard.ts';

export { saveCheckpoint, listCheckpoints } from './store/checkpoints.ts';

export type { Config, NodeConfig } from './kernel/tree.ts';
export type { Receipt, ParseResult, Artifact, Dispatch, SpawnRequest, Tell } from './protocol/schema.ts';
export type { RunRecord } from './store/runs.ts';
export type { Checkpoint } from './store/checkpoints.ts';
export type { Verdict } from './kernel/guard.ts';
