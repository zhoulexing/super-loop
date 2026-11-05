import {
  createTestPluginContext,
  makeNotification,
  runSinkContractTests,
} from '@super-loop/testkit';
import { describe, expect, it } from 'vitest';
import plugin, { INBOX_PREFIX } from '../src/index.js';

runSinkContractTests({ plugin, config: {} });

describe('sink-dashboard', () => {
  it('写入收件箱、重复投递幂等、超出上限删除最旧', async () => {
    const ctx = createTestPluginContext();
    const sink = await plugin.create(plugin.configSchema.parse({ maxItems: 2 }), ctx);
    const [a, b, c] = [makeNotification(), makeNotification(), makeNotification()];
    await sink.deliver(a, ctx);
    await sink.deliver(a, ctx);
    expect(await ctx.kv.list(INBOX_PREFIX)).toHaveLength(1);
    await sink.deliver(b, ctx);
    await sink.deliver(c, ctx);
    const keys = (await ctx.kv.list(INBOX_PREFIX)).map((e) => e.key);
    expect(keys).toEqual([`${INBOX_PREFIX}${b.deliveryId}`, `${INBOX_PREFIX}${c.deliveryId}`]);
  });
});
