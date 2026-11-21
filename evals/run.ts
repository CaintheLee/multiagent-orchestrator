// 跑 evals：一条一行，最后给通过率。非 0 退出码方便挂到 CI 或 pre-commit。
import { cases } from './cases.ts';

const t0 = Date.now();
let pass = 0;
const failures: Array<{ name: string; why: string }> = [];

for (const c of cases) {
  let why: string | null;
  try {
    why = c.run();
  } catch (e) {
    why = '抛异常：' + (e instanceof Error ? e.message : String(e));
  }
  if (why === null) {
    pass += 1;
    console.log(`\u2713 ${c.name}`);
  } else {
    failures.push({ name: c.name, why });
    console.log(`\u2717 ${c.name}\n    ${why}`);
  }
}

const ms = Date.now() - t0;
console.log(`\n${cases.length} 项：${pass} 通过，${failures.length} 失败（${ms}ms）`);
if (failures.length) {
  console.log('\n失败明细：');
  for (const f of failures) console.log(`- ${f.name}：${f.why}`);
  process.exit(1);
}
