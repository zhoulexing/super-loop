import { describe, expect, it } from 'vitest';
import {
  createMemoryKv,
  createTestAgentRunContext,
  createTestSourceContext,
  FakeClock,
  MemoryStore,
  runStoreContractTests,
} from '../src/index.js';

runStoreContractTests('MemoryStore', (clock) => new MemoryStore(clock));

describe('memory kv', () => {
  it('支持 TTL（基于注入时钟）', async () => {
    const clock = new FakeClock();
    const kv = createMemoryKv(clock);
    await kv.set('a', 1, { ttlMs: 100 });
    expect(await kv.get('a')).toBe(1);
    clock.advance(100);
    expect(await kv.get('a')).toBeUndefined();
  });
});

describe('test contexts', () => {
  it('source ctx 按 idempotencyKey 去重并校验草稿', async () => {
    const ctx = createTestSourceContext();
    const d = { kind: 'event' as const, idempotencyKey: 'k', subject: 's', payload: 1 };
    expect((await ctx.emit(d)).duplicated).toBe(false);
    expect((await ctx.emit(d)).duplicated).toBe(true);
    expect(ctx.emitted).toHaveLength(1);
    await expect(ctx.emit({ ...d, idempotencyKey: '' })).rejects.toThrow();
  });

  it('agent ctx 记录审批请求并按策略返回', async () => {
    const ctx = createTestAgentRunContext({ approve: (r) => r.risk === 'low' });
    const low = await ctx.awaitApproval({ action: 'read', title: 't', detail: {}, risk: 'low' });
    const high = await ctx.awaitApproval({ action: 'rm', title: 't', detail: {}, risk: 'high' });
    expect([low.granted, high.granted]).toEqual([true, false]);
    expect(ctx.approvalRequests).toHaveLength(2);
  });
});
