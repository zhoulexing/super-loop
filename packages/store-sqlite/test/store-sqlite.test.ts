import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeEnvelope, runStoreContractTests } from '@super-loop/testkit';
import { afterAll, describe, expect, it } from 'vitest';
import { SqliteStore } from '../src/index.js';

const dir = mkdtempSync(join(tmpdir(), 'super-loop-sqlite-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

runStoreContractTests(
  'SqliteStore(:memory:)',
  (clock) => new SqliteStore({ path: ':memory:', clock }),
);

describe('SqliteStore（文件）', () => {
  it('重新打开后数据仍在，seq 继续递增', async () => {
    const path = join(dir, 'persist.db');
    const env = makeEnvelope();
    const a = new SqliteStore({ path });
    await a.envelopes.put(env);
    await a.append([
      {
        id: 'evt_01JABCDEFGHJKMNPQRSTVWXYZ0',
        type: 'kernel.started',
        at: env.receivedAt,
        subject: { kind: 'kernel', id: 'k' },
        actor: 'kernel',
        data: {},
      },
    ]);
    await a.close();

    const b = new SqliteStore({ path });
    expect((await b.envelopes.get(env.id))?.id).toBe(env.id);
    const [next] = await b.append([
      {
        id: 'evt_01JABCDEFGHJKMNPQRSTVWXYZ1',
        type: 'kernel.started',
        at: env.receivedAt,
        subject: { kind: 'kernel', id: 'k' },
        actor: 'kernel',
        data: {},
      },
    ]);
    expect(next?.seq).toBe(2);
    await b.close();
  });

  it('禁止嵌套事务', async () => {
    const store = new SqliteStore({ path: ':memory:' });
    await expect(store.transaction(() => store.transaction(async () => 1))).rejects.toThrow(
      /nested/,
    );
    await store.close();
  });
});
