import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterAll, describe, expect, it } from 'vitest';
import { serveDashboard } from '../src/static.js';

const root = mkdtempSync(join(tmpdir(), 'super-loop-static-'));
const dist = join(root, 'dist');
mkdirSync(join(dist, 'assets'), { recursive: true });
writeFileSync(join(dist, 'index.html'), '<!doctype html><div id="root"></div>');
writeFileSync(join(dist, 'assets', 'app-abc.js'), 'console.log(1)');
writeFileSync(join(root, 'secret.txt'), 'top secret');
symlinkSync(join(root, 'secret.txt'), join(dist, 'leak.txt'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const app = new Hono();
app.get('/api/v1/health', (c) => c.json({ ok: true }));
app.use('*', serveDashboard(dist));
app.notFound((c) => c.json({ error: { code: 'NOT_FOUND' } }, 404));

describe('serveDashboard', () => {
  it('首页与前端路由返回 index.html（带 CSP），资源文件长期缓存', async () => {
    for (const path of ['/', '/tasks/task_01JABCDEFGHJKMNPQRSTVWXYZ0']) {
      const res = await app.request(path);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/html');
      expect(res.headers.get('content-security-policy')).toContain("script-src 'self'");
      expect(res.headers.get('cache-control')).toBe('no-cache');
    }
    const js = await app.request('/assets/app-abc.js');
    expect(js.headers.get('content-type')).toContain('text/javascript');
    expect(js.headers.get('cache-control')).toContain('immutable');
    expect(await js.text()).toBe('console.log(1)');
  });

  it('API 路由不受影响；不存在的文件、目录穿越与外链符号链接都返回 404', async () => {
    expect(await (await app.request('/api/v1/health')).json()).toEqual({ ok: true });
    expect((await app.request('/api/v1/nope')).status).toBe(404);
    for (const path of ['/missing.js', '/../secret.txt', '/%2e%2e/secret.txt', '/leak.txt']) {
      expect((await app.request(path)).status, path).toBe(404);
    }
  });
});
