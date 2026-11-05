import type { AgentEvent, AgentPlugin } from '@super-loop/protocol';
import { sleep } from '@super-loop/shared';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  assertCompatible,
  defineAgentPlugin,
  definePlugin,
  failedFrom,
  PLUGIN_API_VERSION,
  succeeded,
  withHeartbeat,
} from '../src/index.js';

const noopAgent: AgentPlugin = {
  capabilities: {
    streaming: false,
    resumable: false,
    toolApproval: false,
    workspace: 'none',
    costReporting: false,
  },
  async *run() {
    yield succeeded('ok');
  },
  health: async () => ({ status: 'healthy', checkedAt: new Date().toISOString() }),
};

describe('definePlugin', () => {
  it('补全 apiVersion 与 permissions 并冻结', () => {
    const def = defineAgentPlugin({
      name: 'agent-noop',
      version: '1.0.0',
      configSchema: z.object({ a: z.number().default(1) }),
      create: () => noopAgent,
    });
    expect(def.kind).toBe('agent');
    expect(def.apiVersion).toBe(PLUGIN_API_VERSION);
    expect(def.permissions).toEqual([]);
    expect(Object.isFrozen(def)).toBe(true);
    expect(() => assertCompatible(def)).not.toThrow();
  });

  it('非法清单在定义时抛错', () => {
    expect(() =>
      definePlugin({
        name: 'Bad Name',
        version: '1',
        kind: 'agent',
        configSchema: z.object({}),
        create: () => noopAgent,
      }),
    ).toThrow(/invalid plugin manifest/);
  });

  it('apiVersion 不兼容时拒绝', () => {
    expect(() => assertCompatible({ name: 'x', apiVersion: 99 })).toThrow(/apiVersion 99/);
  });
});

describe('withHeartbeat', () => {
  it('静默期间插入心跳，并保留原事件顺序', async () => {
    async function* slow(): AsyncGenerator<AgentEvent> {
      yield { type: 'log', level: 'info', message: 'start' };
      await sleep(80);
      yield succeeded('done');
    }
    const events: AgentEvent[] = [];
    for await (const e of withHeartbeat(slow(), { intervalMs: 20 })) events.push(e);
    expect(events[0]?.type).toBe('log');
    expect(events.at(-1)?.type).toBe('result');
    expect(events.filter((e) => e.type === 'heartbeat').length).toBeGreaterThanOrEqual(2);
  });

  it('failedFrom 把异常转为失败结果', () => {
    expect(failedFrom(new Error('boom'))).toMatchObject({
      type: 'result',
      status: 'failed',
      error: { code: 'INTERNAL', message: 'boom' },
    });
  });
});
