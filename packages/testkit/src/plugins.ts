import { definePlugin } from '@super-loop/plugin-sdk';
import type {
  AgentCapabilities,
  AgentEvent,
  AgentRunContext,
  AgentRunInput,
  DeliveryResult,
  Notification,
  PluginDefinition,
  SourceContext,
} from '@super-loop/protocol';
import { z } from 'zod';

const CAPABILITIES: AgentCapabilities = {
  streaming: true,
  resumable: false,
  toolApproval: true,
  workspace: 'none',
  costReporting: false,
};

const healthy = async () => ({ status: 'healthy' as const, checkedAt: new Date().toISOString() });

/** 用一个函数快速定义测试 Agent。 */
export function defineTestAgent(
  run: (input: AgentRunInput, ctx: AgentRunContext) => AsyncIterable<AgentEvent>,
  options: { name?: string } = {},
): PluginDefinition<'agent', unknown> {
  return definePlugin({
    name: options.name ?? 'agent-test',
    version: '0.0.0',
    kind: 'agent',
    configSchema: z.unknown(),
    create: () => ({ capabilities: CAPABILITIES, run, health: healthy }),
  });
}

/** 记录所有通知的测试 Sink；`deliver` 可自定义结果。 */
export function defineTestSink(
  deliver: (n: Notification) => DeliveryResult | Promise<DeliveryResult> = () => ({ ok: true }),
  options: { name?: string } = {},
): PluginDefinition<'sink', unknown> & { readonly received: Notification[] } {
  const received: Notification[] = [];
  const def = definePlugin({
    name: options.name ?? 'sink-test',
    version: '0.0.0',
    kind: 'sink',
    configSchema: z.unknown(),
    create: () => ({
      async deliver(n: Notification) {
        received.push(n);
        return deliver(n);
      },
      health: healthy,
    }),
  });
  return { ...def, received };
}

/** 测试 Source：启动后把 ctx 交给调用方，由测试手动 emit。 */
export function defineTestSource(options: { name?: string } = {}): PluginDefinition<
  'source',
  unknown
> & {
  /** start 之后可用。 */
  readonly ctx: () => SourceContext;
} {
  let current: SourceContext | undefined;
  const def = definePlugin({
    name: options.name ?? 'source-test',
    version: '0.0.0',
    kind: 'source',
    configSchema: z.unknown(),
    create: () => ({
      async start(ctx: SourceContext) {
        current = ctx;
      },
      async stop() {
        current = undefined;
      },
      health: healthy,
    }),
  });
  return {
    ...def,
    ctx: () => {
      if (!current) throw new Error('source not started');
      return current;
    },
  };
}

/** 轮询直到条件成立（返回真值），超时抛错。 */
export async function waitFor<T>(
  check: () => T | Promise<T>,
  options: { timeoutMs?: number; intervalMs?: number; message?: string } = {},
): Promise<NonNullable<T>> {
  const deadline = Date.now() + (options.timeoutMs ?? 3_000);
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value as NonNullable<T>;
    } catch (error) {
      last = error;
    }
    await new Promise((r) => setTimeout(r, options.intervalMs ?? 5));
  }
  throw new Error(
    `waitFor timed out${options.message ? `: ${options.message}` : ''}${last ? ` (last error: ${String(last)})` : ''}`,
  );
}
