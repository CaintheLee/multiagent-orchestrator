// 全项目唯一的「我在哪」。
//
// 之前每个模块各自写 `process.cwd()`：从别的目录启动时，界面能开（它用模块位置推），
// 但任务库、配置、模板、工作区全指向错误位置——表现为「页面空白 + 没有任务」。
// 能打开却没有数据，比完全打不开更难排查（见 docs/PATH_BEACONS.md P0-1）。
//
// 这个文件不依赖任何其它模块，谁都可以引。
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 包根（<repo>）。由本文件位置推导，与 cwd 无关 */
export const PKG_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * 数据目录 `.data`。
 *
 * 两个环境变量：
 * - `MA_DATA_DIR`：历史语义是「父目录」，代码在后面拼 `.data`（测试一直在用，保持兼容）
 * - `MA_HOME`：直接指定 `.data` 的位置，更符合直觉（新增，优先）
 *
 * 名字和实际含义不一致是 P0-2 记录的问题，这里用新变量绕开，不破坏旧用法。
 */
export const DATA_DIR = process.env.MA_HOME
  ? path.resolve(process.env.MA_HOME)
  : path.join(process.env.MA_DATA_DIR || PKG_ROOT, '.data');

/** agents.toml */
export const CONFIG_FILE = process.env.MA_CONFIG || path.join(PKG_ROOT, 'agents.toml');

/** 自定义 provider 配置 */
export const PROVIDERS_FILE = path.join(PKG_ROOT, 'providers.toml');

/** 职责模板 */
export const PROMPTS_DIR = path.join(PKG_ROOT, 'prompts');

/** 前端单文件 */
export const UI_FILE = path.join(PKG_ROOT, 'ui', 'index.html');

/**
 * 任务工作区的根：`.sandbox/t<taskId>/<node>` 就拼在这下面。
 * 用包根而不是 cwd——工作区属于这个实例，不属于"你在哪敲的命令"。
 */
export const SANDBOX_ROOT = PKG_ROOT;

/**
 * 归档区：任务结束后把产物复制一份到这里，长期可查。
 *
 * 为什么不放项目目录：归档是「这个编排实例做过什么」的记录，
 * 属于 MultiAgent 而不是被编排的那个项目。放项目里会污染对方的仓库。
 * 为什么放 .data 下：和任务库、轮次同源，备份一个目录就够；
 * 需要给人看时用 /api/archive 或直接开这个路径。
 */
export const ARCHIVE_DIR = process.env.MA_ARCHIVE
  ? path.resolve(process.env.MA_ARCHIVE)
  : path.join(DATA_DIR, 'archive');
