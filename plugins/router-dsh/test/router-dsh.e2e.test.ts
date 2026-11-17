/**
 * 真实调用 DeepSeek Harness + 模型。运行：
 *   E2E=1 OPENAI_API_KEY=... pnpm vitest run plugins/router-dsh/test/router-dsh.e2e.test.ts
 * 可用 ROUTER_DSH_PROVIDER / ROUTER_DSH_MODEL / ROUTER_DSH_KEY_NAME 换模型。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PluginContext, RouterQueries } from '@super-loop/plugin-sdk';
import { createTestPluginContext, makeEnvelope, makeRouterRequest } from '@super-loop/testkit';
import { afterAll, describe, expect, it } from 'vitest';
import plugin from '../src/index.js';

const keyName = process.env.ROUTER_DSH_KEY_NAME ?? 'OPENAI_API_KEY';
const apiKey = process.env[keyName];
const config = plugin.configSchema.parse({
  provider: process.env.ROUTER_DSH_PROVIDER ?? 'openai',
  model: process.env.ROUTER_DSH_MODEL ?? 'gpt-5.4-mini',
  apiKeySecret: keyName,
});
const query: RouterQueries = { searchTasks: async () => [], getTask: async () => undefined };

describe.skipIf(!apiKey)('router-dsh e2e（真实 dsh + 模型）', () => {
  let state: string;
  const kv = new Map<string, unknown>();
  const context = (): PluginContext => {
    const base = createTestPluginContext({
      paths: { state },
      secrets: { [keyName]: apiKey as string },
    });
    // 两个插件实例共用同一个 kv，模拟内核重启后读到上次保存的会话 ID
    return {
      ...base,
      kv: {
        get: async <T>(k: string) => kv.get(k) as T | undefined,
        set: async (k, v) => void kv.set(k, v),
        delete: async (k) => void kv.delete(k),
        list: async () => [],
      },
    };
  };

  afterAll(async () => {
    if (state) await rm(state, { recursive: true, force: true });
  });

  it('分配一批消息；重启插件后恢复同一个会话', async () => {
    state = await mkdtemp(join(tmpdir(), 'router-dsh-e2e-'));
    const ctx = context();
    const router = await plugin.create(config, ctx);
    const request = makeRouterRequest();
    const [code, article] = request.items;
    const result = await router.route(request, { ...ctx, query });
    await router.dispose?.();

    const byTask = new Map(result.decisions.map((d) => [d.taskId, d]));
    expect(byTask.size).toBe(2);
    expect(byTask.get(article?.taskId as never)).toMatchObject({
      action: 'assign',
      agent: 'writer:default',
    });
    const c = byTask.get(code?.taskId as never);
    expect(c?.action === 'assign' ? c.agent : 'coder:default').toBe('coder:default');
    expect(result.usage?.inputTokens).toBeGreaterThan(0);
    const sessionId = kv.get('session');
    expect(typeof sessionId).toBe('string');

    // 新的插件实例（相当于内核重启）：resume 同一个会话
    const ctx2 = context();
    const router2 = await plugin.create(config, ctx2);
    const next = makeRouterRequest({
      items: [
        {
          taskId: 'task_01JAAAAAAAAAAAAAAAAAAAAAAA' as never,
          envelope: makeEnvelope({ subject: '再写一篇露营装备清单的文章' }),
        },
      ],
    });
    const again = await router2.route(next, { ...ctx2, query });
    await router2.dispose?.();
    expect(again.decisions[0]).toMatchObject({ action: 'assign', agent: 'writer:default' });
    expect(kv.get('session')).toBe(sessionId);
  }, 180_000);
});
