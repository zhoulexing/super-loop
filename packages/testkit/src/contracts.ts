import {
  AgentCapabilitiesSchema,
  type AgentEvent,
  AgentEventSchema,
  type AgentRunInput,
  DeliveryResultSchema,
  EnvelopeDraftSchema,
  HealthStatusSchema,
  type Notification,
  type PluginDefinition,
  PluginManifestSchema,
  type SourcePlugin,
} from '@super-loop/protocol';
import { sleep, withTimeout } from '@super-loop/shared';
import { describe, expect, it } from 'vitest';
import {
  createTestAgentRunContext,
  createTestPluginContext,
  createTestSourceContext,
  type TestAgentRunContextOptions,
} from './context.js';
import { makeAgentRunInput, makeNotification } from './fixtures.js';

interface ContractBase<K extends 'agent' | 'source' | 'sink', C> {
  plugin: PluginDefinition<K, C>;
  /** 交给 configSchema 解析的原始配置。 */
  config: unknown;
  /** 单个用例超时，默认 5000ms。 */
  timeoutMs?: number;
}

function manifestTests<C>(
  plugin: PluginDefinition<'agent' | 'source' | 'sink', C>,
  kind: string,
  config: unknown,
) {
  it('manifest 合法且 kind 正确', () => {
    expect(PluginManifestSchema.safeParse(plugin).success).toBe(true);
    expect(plugin.kind).toBe(kind);
  });
  it('configSchema 能解析示例配置', () => {
    expect(plugin.configSchema.safeParse(config).success).toBe(true);
  });
}

async function instantiate<K extends 'agent' | 'source' | 'sink', C>(c: ContractBase<K, C>) {
  return c.plugin.create(c.plugin.configSchema.parse(c.config), createTestPluginContext());
}

// ───────────────────────────── Agent ─────────────────────────────

export interface AgentContractOptions<C = unknown> extends ContractBase<'agent', C> {
  /** 正常完成的输入，默认 makeAgentRunInput()。 */
  input?: AgentRunInput;
  context?: TestAgentRunContextOptions;
  /** 是否测试取消（插件响应 signal 后应在 timeoutMs 内结束）。默认 true。 */
  testCancellation?: boolean;
}

export function runAgentContractTests<C>(options: AgentContractOptions<C>): void {
  const timeoutMs = options.timeoutMs ?? 5_000;
  describe(`agent contract: ${options.plugin.name}`, () => {
    manifestTests(options.plugin, 'agent', options.config);

    it('capabilities 与 health 合法', async () => {
      const agent = await instantiate(options);
      expect(AgentCapabilitiesSchema.safeParse(agent.capabilities).success).toBe(true);
      expect(HealthStatusSchema.safeParse(await agent.health()).success).toBe(true);
    });

    it('事件全部合法，且以唯一的 result 结尾', async () => {
      const agent = await instantiate(options);
      const events: AgentEvent[] = [];
      await withTimeout(async () => {
        for await (const e of agent.run(
          options.input ?? makeAgentRunInput(),
          createTestAgentRunContext(options.context),
        )) {
          events.push(e);
        }
      }, timeoutMs);
      for (const e of events)
        expect(AgentEventSchema.safeParse(e).success, JSON.stringify(e)).toBe(true);
      const results = events.filter((e) => e.type === 'result');
      expect(results).toHaveLength(1);
      expect(events.at(-1)?.type).toBe('result');
    });

    if (options.testCancellation !== false) {
      it('响应取消信号并在超时内结束', async () => {
        const agent = await instantiate(options);
        const controller = new AbortController();
        const ctx = createTestAgentRunContext({ ...options.context, signal: controller.signal });
        const events: AgentEvent[] = [];
        setTimeout(() => controller.abort(), 10);
        await withTimeout(async () => {
          for await (const e of agent.run(options.input ?? makeAgentRunInput(), ctx))
            events.push(e);
        }, timeoutMs);
        const last = events.at(-1);
        if (last) expect(last.type).toBe('result');
      });
    }
  });
}

// ───────────────────────────── Source ─────────────────────────────

export interface SourceContractOptions<C = unknown> extends ContractBase<'source', C> {
  /** 启动后触发一次产出（例如调用 webhook）。不提供则只等待自然产出。 */
  trigger?: (source: SourcePlugin) => Promise<void>;
  /** 期望至少产出的 Envelope 数，默认 1；0 表示只测生命周期。 */
  minEmits?: number;
}

export function runSourceContractTests<C>(options: SourceContractOptions<C>): void {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const minEmits = options.minEmits ?? 1;
  describe(`source contract: ${options.plugin.name}`, () => {
    manifestTests(options.plugin, 'source', options.config);

    it('start/stop 生命周期正常，产出的草稿合法且有 idempotencyKey', async () => {
      const source = await instantiate(options);
      const ctx = createTestSourceContext();
      await withTimeout(() => source.start(ctx), timeoutMs);
      try {
        if (options.trigger) await options.trigger(source);
        const deadline = Date.now() + timeoutMs;
        while (ctx.emitted.length < minEmits && Date.now() < deadline) await sleep(10);
        expect(ctx.emitted.length).toBeGreaterThanOrEqual(minEmits);
        for (const d of ctx.emitted) {
          expect(EnvelopeDraftSchema.safeParse(d).success).toBe(true);
          expect(d.idempotencyKey.length).toBeGreaterThan(0);
        }
        expect(HealthStatusSchema.safeParse(await source.health()).success).toBe(true);
      } finally {
        await withTimeout(() => source.stop(), timeoutMs);
      }
    });
  });
}

// ───────────────────────────── Sink ─────────────────────────────

export interface SinkContractOptions<C = unknown> extends ContractBase<'sink', C> {
  notification?: Notification;
}

export function runSinkContractTests<C>(options: SinkContractOptions<C>): void {
  const timeoutMs = options.timeoutMs ?? 5_000;
  describe(`sink contract: ${options.plugin.name}`, () => {
    manifestTests(options.plugin, 'sink', options.config);

    it('deliver 返回合法结果，重复 deliveryId 不抛错', async () => {
      const sink = await instantiate(options);
      const ctx = createTestPluginContext();
      const n = options.notification ?? makeNotification();
      const first = await withTimeout(() => sink.deliver(n, ctx), timeoutMs);
      const second = await withTimeout(() => sink.deliver(n, ctx), timeoutMs);
      expect(DeliveryResultSchema.safeParse(first).success).toBe(true);
      expect(DeliveryResultSchema.safeParse(second).success).toBe(true);
      expect(HealthStatusSchema.safeParse(await sink.health()).success).toBe(true);
    });
  });
}
