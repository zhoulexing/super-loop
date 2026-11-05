import type { JournalEventDraft, JournalEventType, Store } from '@super-loop/protocol';
import { newId } from '@super-loop/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeClock } from './clock.js';
import { makeEnvelope } from './fixtures.js';

function draft(type: JournalEventType, subjectId = 'env_x', traceId?: string): JournalEventDraft {
  return {
    id: newId('event'),
    type,
    at: '2026-01-01T00:00:00.000Z',
    subject: { kind: 'envelope', id: subjectId },
    actor: 'kernel',
    ...(traceId ? { traceId: traceId as JournalEventDraft['traceId'] & string } : {}),
    data: { n: 1 },
  };
}

/**
 * Store 契约测试：所有 Store 实现必须通过。
 * `factory` 每个用例调用一次，返回一个全新的空 Store。
 */
export function runStoreContractTests(
  name: string,
  factory: (clock: FakeClock) => Store | Promise<Store>,
): void {
  describe(`store contract: ${name}`, () => {
    const opened: Store[] = [];
    const open = async (clock = new FakeClock()) => {
      const store = await factory(clock);
      opened.push(store);
      return store;
    };
    afterEach(async () => {
      await Promise.all(opened.splice(0).map((s) => s.close()));
    });

    it('append 分配单调 seq，readJournal 按 seq 读取', async () => {
      const store = await open();
      const [a, b] = await store.append([draft('envelope.received'), draft('task.created')]);
      expect([a?.seq, b?.seq]).toEqual([1, 2]);
      expect(a?.data).toEqual({ n: 1 });
      expect(await store.latestSeq()).toBe(2);
      expect((await store.readJournal(2, 10)).map((e) => e.seq)).toEqual([2]);
    });

    it('readJournal 支持按 subject / trace / type 过滤', async () => {
      const store = await open();
      const trace = newId('trace');
      await store.append([
        draft('envelope.received', 'env_a', trace),
        draft('task.created', 'task_b'),
        draft('run.started', 'env_a'),
      ]);
      expect((await store.readJournal(1, 10, { subjectId: 'env_a' })).map((e) => e.seq)).toEqual([
        1, 3,
      ]);
      expect((await store.readJournal(1, 10, { traceId: trace })).map((e) => e.seq)).toEqual([1]);
      expect(
        (await store.readJournal(1, 10, { types: ['task.created', 'run.started'] })).map(
          (e) => e.seq,
        ),
      ).toEqual([2, 3]);
    });

    it('事务失败时事件与投影一起回滚', async () => {
      const store = await open();
      const env = makeEnvelope();
      await expect(
        store.transaction(async (tx) => {
          await tx.append([draft('envelope.received')]);
          await tx.envelopes.put(env);
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');
      expect(await store.latestSeq()).toBe(0);
      expect(await store.envelopes.get(env.id)).toBeUndefined();
    });

    it('并发事务串行执行，seq 不重复', async () => {
      const store = await open();
      await Promise.all(
        Array.from({ length: 10 }, () =>
          store.transaction(async (tx) => {
            await tx.append([draft('envelope.received')]);
            await Promise.resolve();
            await tx.append([draft('task.created')]);
          }),
        ),
      );
      const seqs = (await store.readJournal(1, 100)).map((e) => e.seq);
      expect(seqs).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    });

    it('put 覆盖、get 返回副本', async () => {
      const store = await open();
      const env = makeEnvelope({ subject: 'v1' });
      await store.envelopes.put(env);
      await store.envelopes.put({ ...env, subject: 'v2' });
      const got = await store.envelopes.get(env.id);
      expect(got?.subject).toBe('v2');
      if (got) got.subject = 'mutated';
      expect((await store.envelopes.get(env.id))?.subject).toBe('v2');
    });

    it('按 source 实例 + idempotencyKey 查重', async () => {
      const store = await open();
      const env = makeEnvelope({ idempotencyKey: 'k1' });
      await store.envelopes.put(env);
      expect((await store.envelopes.findByIdempotencyKey('manual:default', 'k1'))?.id).toBe(env.id);
      expect(await store.envelopes.findByIdempotencyKey('cron:main', 'k1')).toBeUndefined();
    });

    it('list 支持等值/IN 过滤、排序与游标分页', async () => {
      const store = await open();
      const envs = Array.from({ length: 5 }, (_, i) =>
        makeEnvelope({ kind: i % 2 === 0 ? 'task' : 'event' }),
      );
      for (const e of envs) await store.envelopes.put(e);
      const ids = envs.map((e) => e.id);

      const page1 = await store.envelopes.list({ limit: 2 });
      expect(page1.items.map((e) => e.id)).toEqual(ids.slice(0, 2));
      const page2 = await store.envelopes.list({ limit: 2, cursor: page1.nextCursor as string });
      expect(page2.items.map((e) => e.id)).toEqual(ids.slice(2, 4));
      const page3 = await store.envelopes.list({ limit: 2, cursor: page2.nextCursor as string });
      expect(page3.items.map((e) => e.id)).toEqual(ids.slice(4));
      expect(page3.nextCursor).toBeUndefined();

      expect((await store.envelopes.list({ where: { kind: 'event' } })).items).toHaveLength(2);
      expect(
        (await store.envelopes.list({ where: { kind: ['event', 'task'] } })).items,
      ).toHaveLength(5);
      expect((await store.envelopes.list({ order: 'desc', limit: 1 })).items[0]?.id).toBe(ids[4]);
    });

    it('kv 按命名空间隔离，支持前缀列举与 TTL', async () => {
      const clock = new FakeClock();
      const store = await open(clock);
      const a = store.kv('plugin:a');
      await a.set('inbox/1', { x: 1 });
      await a.set('inbox/2', { x: 2 }, { ttlMs: 100 });
      await a.set('other', true);
      expect(await store.kv('plugin:b').get('inbox/1')).toBeUndefined();
      expect((await a.list('inbox/')).map((e) => e.key)).toEqual(['inbox/1', 'inbox/2']);
      clock.advance(100);
      expect(await a.get('inbox/2')).toBeUndefined();
      await a.delete('inbox/1');
      expect((await a.list('inbox/')).length).toBe(0);
    });
  });
}
