import { readFile, realpath, stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import type { MiddlewareHandler } from 'hono';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.map': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

/** 看板页面的 CSP：只允许同源脚本与接口，字体来自 Google Fonts。 */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  'font-src https://fonts.gstatic.com',
  "img-src 'self' blob: data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
].join('; ');

/**
 * 托管看板构建产物（apps/dashboard/dist）：
 * - 带扩展名的路径按文件返回，`assets/` 下的文件名含哈希，长期缓存；
 * - 其它路径（如 `/tasks/<id>`）回落到 index.html，由前端路由处理；
 * - 拒绝目录穿越与指向目录外的符号链接。
 */
export function serveDashboard(dir: string): MiddlewareHandler {
  let rootReal: Promise<string> | undefined;
  return async (c, next) => {
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') return next();
    if (c.req.path.startsWith('/api/')) return next();
    rootReal ??= realpath(dir);
    const root = await rootReal;

    let rel: string;
    try {
      rel = normalize(decodeURIComponent(c.req.path)).replace(/^([/\\])+/, '');
    } catch {
      return next();
    }
    const wantsFile = extname(rel) !== '';
    const file = wantsFile ? join(root, rel) : join(root, 'index.html');
    let real: string;
    try {
      real = await realpath(file);
      if (!real.startsWith(root + sep) || !(await stat(real)).isFile()) return next();
    } catch {
      return next();
    }

    const body = await readFile(real);
    const ext = extname(real);
    const headers: Record<string, string> = {
      'content-type': MIME[ext] ?? 'application/octet-stream',
      'x-content-type-options': 'nosniff',
      'cache-control': rel.startsWith('assets/')
        ? 'public, max-age=31536000, immutable'
        : 'no-cache',
    };
    if (ext === '.html') {
      headers['content-security-policy'] = CSP;
      headers['referrer-policy'] = 'same-origin';
    }
    if (c.req.method === 'HEAD') return c.body(null, 200, headers);
    return c.body(new Uint8Array(body), 200, headers);
  };
}
