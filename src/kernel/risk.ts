// 高风险动作识别：有些活一旦跑起来就难回头，必须先让人点头。
//
// 为什么放在「开跑前」而不是「跑到一半」（2026-11-21 决策 P0-5）：
// 跑到一半才发现要删东西，那时已经改了几个文件，回滚成本比一开始停一下高得多。
// 所以这里做的是**任务级拦截**：任务正文里出现高风险动作，整个任务先挂起等人确认。
//
// 判定用关键词，不调模型：
// 1. 调模型判「这算不算高风险」本身就是一次不确定性，同一句话两次结果可能不同；
// 2. 关键词误判的代价只是多点一次确认，漏判的代价是文件没了——宁可宽一点。
//
// 刻意**不**把「跑测试」「编译」「格式化」算进来：那些天天做，每次都拦会让人放弃这个功能。

/** 一类风险 */
export type Risk = {
  /** 机器可读的类型 */
  kind: 'delete' | 'move' | 'rename' | 'protocol' | 'overwrite' | 'assets';
  /** 命中的原文片段，用来告诉人「我是因为这句话拦的」 */
  hit: string;
  /** 命中词在任务正文里的起始下标。判断否定语境要用它，
   *  不能拿 hit 反查（同一句话里同一个词可能出现多次） */
  at: number;
};

/**
 * 规则表。
 *
 * `re` 用带边界的写法：`删` 单独出现太宽（"删掉临时文件"要拦，
 * 但"删除按钮的文案"是改代码，不该拦）。所以要求它和动作词同现。
 */
const RULES: Array<{ kind: Risk['kind']; label: string; re: RegExp }> = [
  // 单个「删」也要拦：口语里常说「把 X 删了」「删一下」，只认「删除」会漏掉这些。
  // 代价是「删除按钮的文案」这种改代码的活也会被拦——多点一次确认，比漏删强。
  { kind: 'delete', label: '删除文件', re: /(删除|删掉|删了|删|清除|清空|\brm\b|\bdel\b|remove\s+all|delete)/i },
  { kind: 'move', label: '移动/隔离', re: /(移动到|移到|迁移|搬走|隔离区|隔离到|quarantine)/i },
  { kind: 'rename', label: '批量改名', re: /(重命名|改名|批量.*名|rename)/i },
  { kind: 'protocol', label: '改协议版本', re: /(协议版本|PROTOCOL_VERSION|schema\s*版本|改.*版本号)/i },
  { kind: 'overwrite', label: '覆盖已有文件', re: /(覆盖|覆写|overwrite)/i },
  { kind: 'assets', label: '动资产库', re: /(资产库|asset_inventory|全部资产|所有资产)/i },
];

/**
 * 扫一遍任务正文，返回命中的风险。
 *
 * 只从前 4000 字里找：任务正文动辄两万字，后半段多是验收标准，
 * 那里出现的「删除」通常是「不得删除」，按关键词拦反而误伤。
 */
export function detectRisk(task: string): Risk[] {
  const head = String(task || '').slice(0, 4000);
  const out: Risk[] = [];
  for (const r of RULES) {
    // 每个规则找**所有**匹配，不是只看第一处：
    // 「别删 A，但要删 B」里第一处是否定，第二处才是要做的事。
    // 只取第一个会把整条规则判成否定，直接把风险漏掉。
    let n = 0;
    for (const m of head.matchAll(new RegExp(r.re.source, r.re.flags.includes('g') ? r.re.flags : r.re.flags + 'g'))) {
      if (m.index === undefined) continue;
      // 取命中词前后各 20 字做证据，人一眼能看出是"要删"还是"不许删"
      const idx = Math.max(0, m.index - 20);
      out.push({
        kind: r.kind,
        hit: head.slice(idx, m.index + m[0].length + 20).replace(/\s+/g, ' '),
        at: m.index,
      });
      // 同一类最多记 3 处：再多只是噪音，人看不过来
      if (++n >= 3) break;
    }
  }
  return out;
}

/**
 * 是否属于「否定语境」——命中词前面紧挨着「不要/不许/禁止/不得/别」。
 *
 * 只看命中前 8 个字：太远就可能是另一个分句，比如
 * 「不要删 A，但要删 B」里第二个「删」确实是高风险。
 */
export function isNegated(at: number, task: string): boolean {
  const before = String(task || '').slice(Math.max(0, at - 8), at);
  return /(不要|不许|禁止|不得|别|切勿|不能)\s*$/.test(before);
}

/** 给人看的一句话 */
export function riskText(risks: Risk[]): string {
  return risks.map((r) => {
    const label = RULES.find((x) => x.kind === r.kind)?.label || r.kind;
    return `${label}（「${r.hit}」）`;
  }).join('；');
}

/**
 * 这个任务要不要拦。
 *
 * 全部命中都在否定语境里就不拦：「别删任何文件」是最安全的那类指令，
 * 拦下来只会让人困惑。
 */
export function needsSignoff(task: string): Risk[] {
  const risks = detectRisk(task);
  if (!risks.length) return [];
  const positive = risks.filter((r) => !isNegated(r.at, task));
  return positive;
}
