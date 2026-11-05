import {
  collect,
  createTestAgentRunContext,
  createTestPluginContext,
  makeAgentRunInput,
  runAgentContractTests,
} from '@super-loop/testkit';
import { describe, expect, it } from 'vitest';
import plugin from '../src/index.js';

runAgentContractTests({ plugin, config: {} });
// 带延迟的实例：验证取消信号能让 Run 提前结束。
runAgentContractTests({ plugin, config: { delayMs: 300 }, timeoutMs: 2_000 });

describe('agent-echo', () => {
  it('回显 prompt', async () => {
    const agent = await plugin.create(plugin.configSchema.parse({}), createTestPluginContext());
    const events = await collect(
      agent.run(makeAgentRunInput({ prompt: 'hi' }), createTestAgentRunContext()),
    );
    expect(events.find((e) => e.type === 'message')).toMatchObject({ content: 'hi' });
    expect(events.at(-1)).toMatchObject({
      type: 'result',
      status: 'succeeded',
      output: { echo: 'hi' },
    });
  });

  it('options.fail 产生可重试失败', async () => {
    const agent = await plugin.create(plugin.configSchema.parse({}), createTestPluginContext());
    const events = await collect(
      agent.run(makeAgentRunInput({ options: { fail: true } }), createTestAgentRunContext()),
    );
    expect(events.at(-1)).toMatchObject({
      type: 'result',
      status: 'failed',
      error: { code: 'UNAVAILABLE', retryable: true },
    });
  });

  it('长延迟时发出心跳', async () => {
    const agent = await plugin.create(
      plugin.configSchema.parse({ delayMs: 120, heartbeatMs: 30 }),
      createTestPluginContext(),
    );
    const events = await collect(agent.run(makeAgentRunInput(), createTestAgentRunContext()));
    expect(events.filter((e) => e.type === 'heartbeat').length).toBeGreaterThanOrEqual(2);
  });
});
