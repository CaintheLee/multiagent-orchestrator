// 回执的字段与约束。改这里等于改协议：改完要同步 docs/protocol.md 和测试。
export type Artifact = {
  path: string;
  kind: string;
  bytes: number;
  /**
   * 工作区里的备份路径。产物落在 extra_dirs 白名单目录时由系统自动复制，
   * 续跑、导出、checkpoint 都以它为准（原路径可能被别的进程改掉）。
   */
  backup?: string;
  /**
   * true 表示这是「引用」而不是本节点的交付：收口轮列出的下级产物。
   * 只用于说明「我核了这些」，不计入本节点产出、不备份。
   */
  ref?: boolean;
};

/**
 * 这一轮写了、但没通过校验的文件。
 *
 * 单独记下来的理由：#40 那一轮把 23KB 的分析写到 D:/YourProject\docs，因为「不在工作区内」
 * 被判失败，产物清单清空——文件明明在，界面上却像什么都没做，日志里也只剩一句
 * 「产物有问题」。失败可以，但「它到底写了什么」必须留得住。
 */
export type Stray = {
  path: string;
  /** 能 stat 到就填真实大小，stat 不到可能是 0 */
  bytes: number;
  /** 为什么没通过：越界 / 备份失败 / 不存在 / 不是文件 */
  why: string;
};

export type Dispatch = {
  to: string;
  task: string;
};

/**
 * 派生请求：模型想临时新开一条产线。
 * 它不能自己生效，要进 approvals 表等人批。批准后只活在这一次任务里，不写 agents.toml。
 */
export type SpawnRequest = {
  /** 新节点 id，规则与现有节点一致 */
  name: string;
  /** 为什么要开这条线。审批的人只看这一句就够判断，所以必填 */
  why: string;
  /** 批准后立刻派给它的活 */
  task: string;
  /** 可选：不写就跟提出者用同一个模型/角色 */
  model?: string;
  role?: string;
};

/** 一条点对点留言。异步投递：发完就走，不等回话 */
export type Tell = {
  to: string;
  msg: string;
};

export type Receipt = {
  summary: string;
  artifacts: Artifact[];
  dispatch: Dispatch[];
  /** 判通过时用它证明「我真的打开过产物」：每条必须能在产物里逐字搜到 */
  evidence: string[];
  /** 想新开的产线，全部需要用户批准后才执行 */
  spawn: SpawnRequest[];
  /** 给同任务里其他节点的留言，异步投递，不阻塞这一轮 */
  tell: Tell[];
  /**
   * 明确「在问谁」。
   *
   * 和 question 的区别：question 是「我卡住了，谁能答都行」，由框架往上抛；
   * ask 是「我在等某个具体的节点/人回答」，父级必须处理——要么在 dispatch 里回，
   * 要么自己用 question 升级给人。没有这个字段时，子级的疑问只能一路冒到用户，
   * 中间那层主控形同虚设。
   */
  ask: Ask[];
  /**
   * 阶段计划：只在第一轮给一次。给了之后，收口判 pass 只表示「这一段过了」，
   * 引擎会继续推下一段，全部段落完成才算任务结束。
   */
  plan?: Phase[];
  /** 本轮做完的是哪一段（对应 plan 里的 id）。不给就按顺序推断 */
  phase?: string;
  question?: string;
};

export type Ask = {
  /** 谁在问。由框架填，模型不用写 */
  from?: string;
  /** 问谁：父节点 id，或 'user' 表示只能人来答 */
  to: string;
  question: string;
};

/**
 * 阶段：把一件大事切成若干段，由主控自己声明，引擎按顺序推进。
 *
 * 为什么需要：以前一个任务 = 派活 → 收口 → 结束。#45 的四段审计（审计/标记/隔离/冒烟）
 * 第一段跑完主控就判 pass，后三段压根没开始，而它自己觉得「任务完成了」。
 * 有了 plan，收口判 pass 只代表「这一段过了」，引擎会接着把下一段推给主控，
 * 全部段落跑完任务才真正结束。
 */
export type Phase = {
  /** 短 id，1–8 位字母数字，写进回执的 phase 字段 */
  id: string;
  /** 一句人话，简报里会显示 */
  name: string;
  /** 这一段的验收口径；不给就用 name 兜底 */
  doneWhen?: string;
};

export type ParseResult =
  | { ok: true; receipt: Receipt }
  | { ok: false; why: string; raw: string };

/** 回执顶层只允许这些字段，多一个就拒（autoloop 的 outcome 就是被这个挡下的） */
export const ALLOWED_KEYS: ReadonlySet<string> = new Set([
  'summary',
  'artifacts',
  'dispatch',
  'evidence',
  'spawn',
  'tell',
  'ask',
  'plan',
  'phase',
  'question',
]);

/** 证据片段的长度限制：太短到处都能搜到，太长模型抄不准 */
export const EVIDENCE_MIN = 6;
export const EVIDENCE_MAX = 120;
export const EVIDENCE_LIMIT = 6;

/** 回执块的语言标记 */
export const FENCE = 'agent-autoloop';

/** 节点 id 与派生名共用一套规则：要能安全拼进路径和 prompts/<role>.md */
export const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,7}$/;

/** 一轮最多提几个派生请求。超了截断——多出来的那些不该悄悄生效 */
export const SPAWN_LIMIT = 3;

/** 一轮最多发几条留言、每条最长多少字。留言是附注，不是第二份交付 */
export const TELL_LIMIT = 3;
export const TELL_MAX = 500;

/** 一轮最多提几个问题；单条上限比留言短——问题要短才答得准 */
export const ASK_LIMIT = 3;
export const ASK_MAX = 400;

/** 阶段最多几段。再多就该拆成多个任务了，一个任务串十个阶段没人盯得住 */
export const PLAN_LIMIT = 10;
