/**
 * 配置写入的唯一入口。
 *
 * agents.toml 是「读整份 → 改 → 重写整份」的格式：任何两处同时写都会互相覆盖，
 * 后写的那个拿旧快照落盘，把另一处刚加的节点或刚改的设置抹掉。
 *
 * 之前只有派生（spawn）那条路排了队，界面保存节点、改开线设置、增删节点
 * 仍然各写各的，和派生并发时照样丢（外部审计 M5）。
 * 现在所有写配置的地方都走这里：队列和「读最新」都在锁内完成。
 */
import { loadConfig, saveConfig, type Config } from './tree.ts';

/** 带状态码的配置错误：路由直接翻成 400/409，不必区分是哪种校验失败 */
export class ConfigError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

let chain: Promise<unknown> = Promise.resolve();

/**
 * 串行地「读最新 → 改 → 写回」。
 * fn 抛错就不写盘，错误原样抛给调用方。
 */
export function mutateConfig<T>(file: string, fn: (cfg: Config) => T): Promise<T> {
  const run = chain.then(() => {
    const cfg = loadConfig(file);
    const out = fn(cfg);
    saveConfig(cfg, file);
    return out;
  });
  // 链上挂一份吞错副本：一次失败不能卡死后面所有写
  chain = run.then(
    () => {},
    () => {},
  );
  return run;
}
