/**
 * 产物预览的安全头。
 *
 * 产物是模型写的 HTML，里面有脚本。以前用**同源 iframe** 直接渲染，等于把
 * hub 的全部 API（派活、改配置、开线授权）交给这段脚本：一个 fetch 就能
 * 驱动本地 Agent，`esc()` 只管拼进页面的字符串，管不了主动渲染的文档
 * （外部审计 C-2）。
 *
 * 现在的做法：给主动文档（html/htm/svg/xhtml）回 `CSP: sandbox`，
 * 文档跑在不透明源里——脚本拿不到 cookie、也不被当作同源，写接口的 Origin
 * 校验会直接拒掉 "null"。默认连脚本都不给；确实需要（图表报表）时由人勾选。
 */

/** 会被浏览器当文档执行的扩展名 */
const ACTIVE = new Set(['.html', '.htm', '.svg', '.xhtml']);

export function isActiveDoc(ext: string): boolean {
  return ACTIVE.has(String(ext || '').toLowerCase());
}

const BASE: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
};

/**
 * 允许脚本时仍然保留 `sandbox`（不加 allow-same-origin），
 * 所以脚本能画图，但 origin 是 null，读不到 hub 的任何数据。
 */
export function previewHeaders(ext: string, allowScripts: boolean): Record<string, string> {
  const h: Record<string, string> = { ...BASE };
  if (!isActiveDoc(ext)) return h;
  const sandbox = allowScripts ? 'sandbox allow-scripts allow-popups' : 'sandbox';
  h['Content-Security-Policy'] =
    sandbox
    + "; default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data:";
  return h;
}
