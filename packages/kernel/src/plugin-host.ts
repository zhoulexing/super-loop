import {
  type AgentPlugin,
  type AgentRunContext,
  type Clock,
  type ContentStore,
  type DirectoryProvider,
  type EmitResult,
  type EnvelopeDraft,
  type HealthStatus,
  type InstanceName,
  InstanceNameSchema,
  type Logger,
  PLUGIN_API_VERSION,
  type PluginContext,
  type PluginDefinition,
  type PluginInfo,
  type PluginInstanceMap,
  type PluginKind,
  type PluginPaths,
  type PluginStatus,
  type RouterAgentInfo,
  type RouterContext,
  type RouterPlugin,
  type RouterQueries,
  type RunWorkspace,
  type SecretResolver,
  type SinkPlugin,
  type SourcePlugin,
  type Store,
} from '@super-loop/protocol';
import { ErrorCode, LoopError, toLoopError, withTimeout } from '@super-loop/shared';
import { interpolateEnv, type KernelConfig } from './config.js';

export type { PluginInfo, PluginStatus } from '@super-loop/protocol';

interface Entry {
  instance: InstanceName;
  def: PluginDefinition<PluginKind, unknown>;
  status: PluginStatus;
  impl?: PluginInstanceMap[PluginKind];
  ctx?: PluginContext;
  controller: AbortController;
  crashes: number;
  error?: string;
  description?: string;
}

export type Lookup<T> =
  | { status: 'ready'; impl: T; instance: InstanceName; ctx: PluginContext; plugin: string }
  | { status: 'missing' | 'disabled' | 'wrong_kind' };

/** 插件生命周期事件，由内核写入 Journal。 */
export type PluginHostEvent =
  | { type: 'plugin.loaded'; instance: InstanceName; data: Record<string, unknown> }
  | { type: 'plugin.crashed'; instance: InstanceName; data: Record<string, unknown> }
  | { type: 'plugin.disabled'; instance: InstanceName; data: Record<string, unknown> };

export interface PluginHostDeps {
  config: KernelConfig;
  store: Store;
  clock: Clock;
  logger: Logger;
  content: ContentStore;
  dirs: DirectoryProvider | undefined;
  secrets: SecretResolver;
  env: NodeJS.ProcessEnv;
  onEvent(event: PluginHostEvent): Promise<void>;
}

/** 插件私有 KV 命名空间约定。 */
export const pluginKvNamespace = (instance: string) => `plugin:${instance}`;

const REQUIRED_METHODS: Record<PluginKind, string[]> = {
  source: ['start', 'stop', 'health'],
  agent: ['run', 'health'],
  sink: ['deliver', 'health'],
  router: ['route', 'health'],
  probe: ['collect'],
  playbook: ['propose', 'execute'],
};

export class PluginHost {
  readonly #entries = new Map<InstanceName, Entry>();
  readonly #deps: PluginHostDeps;

  constructor(deps: PluginHostDeps) {
    this.#deps = deps;
  }

  /** 加载并实例化所有插件。配置错误直接抛出（内核拒绝启动）；create 失败则标记 failed。 */
  async load(): Promise<void> {
    const { config, env } = this.#deps;
    for (const [rawName, spec] of Object.entries(config.plugins)) {
      const name = InstanceNameSchema.safeParse(rawName);
      if (!name.success) {
        throw new LoopError(
          ErrorCode.INVALID_CONFIG,
          `plugins.${rawName}: instance name must be "<plugin>:<instance>"`,
        );
      }
      const instance = name.data;
      const def = spec.use;
      if (def.apiVersion !== PLUGIN_API_VERSION) {
        throw new LoopError(
          ErrorCode.PLUGIN_INCOMPATIBLE,
          `plugins.${instance}: "${def.name}" targets apiVersion ${def.apiVersion}, kernel supports ${PLUGIN_API_VERSION}`,
        );
      }
      const parsed = def.configSchema.safeParse(
        interpolateEnv(spec.config ?? {}, env, `plugins.${instance}.config`),
      );
      if (!parsed.success) {
        const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '$'}: ${i.message}`);
        throw new LoopError(
          ErrorCode.INVALID_CONFIG,
          `plugins.${instance}.config invalid: ${issues.join('; ')}`,
        );
      }

      const entry: Entry = {
        instance,
        def,
        status: spec.enabled ? 'ready' : 'disabled',
        controller: new AbortController(),
        crashes: 0,
        ...(spec.description === undefined ? {} : { description: spec.description }),
      };
      this.#entries.set(instance, entry);
      if (!spec.enabled) continue;

      entry.ctx = await this.#makeContext(entry);
      try {
        const ctx = entry.ctx;
        const impl = await withTimeout(
          async () => def.create(parsed.data, ctx),
          config.limits.pluginCallTimeoutMs,
          { label: `${instance}.create` },
        );
        const missing = REQUIRED_METHODS[def.kind].filter(
          (m) => typeof (impl as unknown as Record<string, unknown>)[m] !== 'function',
        );
        if (missing.length > 0) {
          throw new LoopError(
            ErrorCode.PLUGIN_PROTOCOL_VIOLATION,
            `${def.kind} plugin is missing methods: ${missing.join(', ')}`,
          );
        }
        entry.impl = impl;
        await this.#deps.onEvent({
          type: 'plugin.loaded',
          instance,
          data: { plugin: def.name, version: def.version, kind: def.kind },
        });
      } catch (error) {
        entry.status = 'failed';
        entry.error = toLoopError(error).message;
        this.#deps.logger.error('plugin failed to load', { instance, error: entry.error });
        await this.#deps.onEvent({
          type: 'plugin.crashed',
          instance,
          data: { phase: 'create', error: entry.error },
        });
      }
    }
  }

  /** 只把 permissions 中声明过的目录交给插件。 */
  async #resolvePaths(entry: Entry): Promise<PluginPaths> {
    const { dirs } = this.#deps;
    if (!dirs) return {};
    const perms = new Set(entry.def.permissions);
    const paths: PluginPaths = {};
    if (perms.has('fs:shared:read')) paths.shared = await dirs.shared();
    if (perms.has('fs:state')) paths.state = await dirs.state(entry.instance);
    if (perms.has('fs:cache')) paths.cache = await dirs.cache(entry.def.name);
    return paths;
  }

  async #makeContext(entry: Entry): Promise<PluginContext> {
    const { store, clock, logger, content, secrets } = this.#deps;
    return {
      instance: entry.instance,
      logger: logger.child({ plugin: entry.def.name, instance: entry.instance }),
      clock,
      kv: store.kv(pluginKvNamespace(entry.instance)),
      files: content.attachments,
      paths: await this.#resolvePaths(entry),
      secrets,
      signal: entry.controller.signal,
    };
  }

  #lookup<K extends PluginKind>(instance: string, kind: K): Lookup<PluginInstanceMap[K]> {
    const entry = this.#entries.get(instance as InstanceName);
    if (!entry) return { status: 'missing' };
    if (entry.def.kind !== kind) return { status: 'wrong_kind' };
    if (entry.status !== 'ready' || !entry.impl || !entry.ctx) return { status: 'disabled' };
    return {
      status: 'ready',
      impl: entry.impl as PluginInstanceMap[K],
      instance: entry.instance,
      ctx: entry.ctx,
      plugin: entry.def.name,
    };
  }

  agent(instance: string): Lookup<AgentPlugin> {
    return this.#lookup(instance, 'agent');
  }

  sink(instance: string): Lookup<SinkPlugin> {
    return this.#lookup(instance, 'sink');
  }

  router(instance: string): Lookup<RouterPlugin> {
    return this.#lookup(instance, 'router');
  }

  /** 交给 Router 的可用 Agent 列表（只含已就绪的实例）。 */
  routableAgents(): RouterAgentInfo[] {
    const out: RouterAgentInfo[] = [];
    for (const e of this.#entries.values()) {
      if (e.def.kind !== 'agent' || e.status !== 'ready' || !e.impl) continue;
      out.push({
        instance: e.instance,
        plugin: e.def.name,
        capabilities: (e.impl as AgentPlugin).capabilities,
        ...(e.description === undefined ? {} : { description: e.description }),
      });
    }
    return out;
  }

  /** 构造一批路由的上下文：signal 同时受实例停止与本批取消控制。 */
  routerContext(
    instance: InstanceName,
    extra: { signal: AbortSignal; query: RouterQueries; batchId: string },
  ): RouterContext {
    const entry = this.#entries.get(instance);
    if (!entry?.ctx)
      throw new LoopError(ErrorCode.PLUGIN_NOT_FOUND, `plugin ${instance} not ready`);
    return {
      ...entry.ctx,
      logger: entry.ctx.logger.child({ batchId: extra.batchId }),
      query: extra.query,
      signal: AbortSignal.any([entry.controller.signal, extra.signal]),
    };
  }

  /** 构造一次 Run 的上下文：signal 同时受实例停止与 Run 取消控制。 */
  /**
   * 构造一次 Run 的上下文：
   * - signal 同时受实例停止与 Run 取消控制；
   * - files 写入本次 Run 的产物目录；paths 额外包含 work / artifacts。
   */
  runContext(
    instance: InstanceName,
    extra: Omit<AgentRunContext, keyof PluginContext | 'signal' | 'paths'> & {
      signal: AbortSignal;
      workspace?: RunWorkspace | undefined;
    },
  ): AgentRunContext {
    const entry = this.#entries.get(instance);
    if (!entry?.ctx)
      throw new LoopError(ErrorCode.PLUGIN_NOT_FOUND, `plugin ${instance} not ready`);
    const { workspace, ...rest } = extra;
    return {
      ...entry.ctx,
      logger: entry.ctx.logger.child({ runId: extra.runId }),
      files: this.#deps.content.artifacts({ taskId: extra.taskId, runId: extra.runId }),
      paths: {
        ...entry.ctx.paths,
        ...(workspace ? { work: workspace.work, artifacts: workspace.artifacts } : {}),
      },
      ...rest,
      signal: AbortSignal.any([entry.controller.signal, extra.signal]),
    };
  }

  async startSources(
    emit: (
      source: { plugin: string; instance: InstanceName },
      draft: EnvelopeDraft,
    ) => Promise<EmitResult>,
  ): Promise<void> {
    for (const entry of this.#entries.values()) {
      if (entry.def.kind !== 'source' || entry.status !== 'ready' || !entry.impl || !entry.ctx) {
        continue;
      }
      const source = entry.impl as SourcePlugin;
      const ctx = {
        ...entry.ctx,
        emit: (draft: EnvelopeDraft) =>
          emit({ plugin: entry.def.name, instance: entry.instance }, draft),
      };
      try {
        await withTimeout(() => source.start(ctx), this.#deps.config.limits.pluginCallTimeoutMs, {
          label: `${entry.instance}.start`,
        });
      } catch (error) {
        await this.recordCrash(entry.instance, error, 'start');
      }
    }
  }

  /** 记录一次插件崩溃（抛异常 / 违反协议）；连续达到上限后自动禁用。 */
  async recordCrash(instance: InstanceName, error: unknown, phase: string): Promise<void> {
    const entry = this.#entries.get(instance);
    if (!entry) return;
    entry.crashes += 1;
    entry.error = toLoopError(error).message;
    await this.#deps.onEvent({
      type: 'plugin.crashed',
      instance,
      data: { phase, error: entry.error, crashes: entry.crashes },
    });
    if (entry.status === 'ready' && entry.crashes >= this.#deps.config.limits.maxPluginCrashes) {
      entry.status = 'disabled';
      await this.#deps.onEvent({
        type: 'plugin.disabled',
        instance,
        data: { reason: 'too many consecutive crashes', crashes: entry.crashes },
      });
    }
  }

  recordSuccess(instance: InstanceName): void {
    const entry = this.#entries.get(instance);
    if (entry) entry.crashes = 0;
  }

  list(): PluginInfo[] {
    return [...this.#entries.values()].map((e) => ({
      instance: e.instance,
      plugin: e.def.name,
      version: e.def.version,
      kind: e.def.kind,
      status: e.status,
      crashes: e.crashes,
      ...(e.error === undefined ? {} : { error: e.error }),
      ...(e.description === undefined ? {} : { description: e.description }),
      ...(e.def.kind === 'agent' && e.impl
        ? { capabilities: (e.impl as AgentPlugin).capabilities }
        : {}),
    }));
  }

  async health(instance: InstanceName): Promise<HealthStatus> {
    const entry = this.#entries.get(instance);
    const checkedAt = this.#deps.clock.iso();
    if (!entry) return { status: 'unhealthy', checkedAt, message: 'not found' };
    if (entry.status !== 'ready' || !entry.impl) {
      return { status: 'unhealthy', checkedAt, message: entry.status };
    }
    const impl = entry.impl as { health?: () => Promise<HealthStatus> };
    if (!impl.health) return { status: 'healthy', checkedAt };
    try {
      return await withTimeout(() => impl.health?.() as Promise<HealthStatus>, 5_000);
    } catch (error) {
      return { status: 'unhealthy', checkedAt, message: toLoopError(error).message };
    }
  }

  /** 停止 Source、触发实例 signal、调用 dispose。错误只记录不抛出。 */
  async stopAll(): Promise<void> {
    const timeout = this.#deps.config.limits.pluginCallTimeoutMs;
    for (const entry of this.#entries.values()) {
      try {
        if (entry.def.kind === 'source' && entry.impl && entry.status === 'ready') {
          await withTimeout(() => (entry.impl as SourcePlugin).stop(), timeout);
        }
      } catch (error) {
        this.#deps.logger.warn('source stop failed', {
          instance: entry.instance,
          error: String(error),
        });
      }
    }
    for (const entry of this.#entries.values()) {
      entry.controller.abort(new LoopError(ErrorCode.KERNEL_SHUTDOWN, 'kernel stopping'));
      const dispose = (entry.impl as { dispose?: () => Promise<void> } | undefined)?.dispose;
      if (!dispose) continue;
      try {
        await withTimeout(() => dispose.call(entry.impl), timeout);
      } catch (error) {
        this.#deps.logger.warn('plugin dispose failed', {
          instance: entry.instance,
          error: String(error),
        });
      }
    }
  }
}
