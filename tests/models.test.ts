// 模型清单解析：来源是 CLI 的 --help，不是写死的常量。
// hy4free 下线时界面还显示它，就是因为以前把列表写死了。
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSupportedModels } from '../src/adapters/table.ts';
import { modelKnown, type ModelList } from '../src/adapters/models.ts';

const HELP = `
  --model <model>   Model for the current session. Please provide the model ID.
                    Currently supported: (fast-model, balanced-model, deep-model, hy4std,
                    hy3, hy3-x, deepseek-v4.1-flash, glm-5.3, glm-5.3-flash, space-bunny,
                    kimi-k3.1-pro, deepseek-v4-pro, step-5-preview, mimo-v2.6-pro)
  --text-to-image-model <model>  Model for text-to-image generation
`;

test('能从 --help 里解析出模型列表（跨行也能拼回来）', () => {
  const list = parseSupportedModels(HELP);
  assert.ok(list.length >= 10);
  assert.ok(list.includes('hy4std'));
  assert.ok(list.includes('space-bunny'));
  assert.ok(list.includes('kimi-k3.1-pro'));
});

test('已下线的 hy4free 不会出现在解析结果里', () => {
  assert.equal(parseSupportedModels(HELP).includes('hy4free'), false);
});

test('帮助里没有这句话时返回空数组，而不是编一个列表', () => {
  assert.deepEqual(parseSupportedModels('Usage: codebuddy [options]'), []);
});

test('非法字符会被过滤掉，不会把说明文字当成模型名', () => {
  const list = parseSupportedModels('Currently supported: (good-model, "bad one", --flag, ok2)');
  assert.deepEqual(list, ['good-model', 'ok2']);
});

test('modelKnown：空值算合法（用 CLI 默认），未知名字不算', () => {
  const ml: ModelList = { models: ['hy4std', 'glm-5.3'], source: 'live', at: Date.now(), from: ['codebuddy'] };
  assert.equal(modelKnown(ml, ''), true);
  assert.equal(modelKnown(ml, 'hy4std'), true);
  assert.equal(modelKnown(ml, 'hy4free'), false);
});
