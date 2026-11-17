import { z } from 'zod';
import type { AgentCapabilities, AgentEvent, AgentRunInput } from './agent.js';
import type { ApprovalOutcome, ApprovalRequest } from './approval.js';
import type { FileRef, HealthStatus, InstanceName } from './common.js';
import type { EnvelopeDraft } from './envelope.js';
import type { EnvelopeId, RunId, TaskId } from './ids.js';
import type { RouterQueries, RouterRequest, RouterResult } from './routing.js';
import type { DeliveryResult, Notification } from './sink.js';
import type { Incident, ProbeSample, Remediation, RemediationAction } from './watchdog.js';

/** 插件协议版本。内核据此判断插件是否兼容。 */
export const PLUGIN_API_VERSION = 1;

export const PluginKindSchema = z.enum(['source', 'agent', 'sink', 'router', 'probe', 'playbook']);
export type PluginKind = z.infer<typeof PluginKindSchema>;

/**
 * 插件声明的权限：
 * - `fs:workspace` / `fs:read:<glob>` / `fs:write:<glob>`
 * - `fs:shared:read`：只读访问主目录 shared/（用户维护的共享资料）
 * - `fs:state`：读写 state/<plugin>/<instance>/（插件实例的持久状态，如 CLI 会话）
 * - `fs:cache`：读写 cache/<plugin>/（可随时删除的缓存，如 git 镜像）
 * - `process:spawn`
 * - `net:*` / `net:<host>`
 * - `secrets:<name>`
 */
export const PluginPermissionSchema = z
  .string()
  .regex(
    /^(fs:workspace|fs:shared:read|fs:state|fs:cache|fs:(read|write):.+|process:spawn|net:(\*|[\w.-]+)|secrets:[\w-]+)$/,
  );
export type PluginPermission = z.infer<typeof PluginPermissionSchema>;

export const PluginManifestSchema = z.object({
  /** 与包名去掉 `@super-loop/` 前缀一致，如 `agent-claude-code`。 */
  name: z.string().regex(/^[a-z][a-z0-9-]*$/),
  version: z.string().regex(/^\d+\.\d+\.\d+(-[\w.]+)?$/),
  kind: PluginKindSchema,
  apiVersion: z.number().int().positive(),
  description: z.string().optional(),
  permissions: z.array(PluginPermissionSchema),
});
export type PluginManifest = z.infer<typeof PluginManifestSchema>;

// ─────────────────────── 内核注入给插件的能力 ───────────────────────

export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  child(bindings: LogFields): Logger;
}

/** 统一时间来源，便于测试与回放。禁止直接使用 Date.now()。 */
export interface Clock {
  /** epoch 毫秒。 */
  now(): number;
  /** ISO8601 UTC。 */
  iso(): string;
}

/** 插件私有命名空间的 KV。 */
export interface KvStore {
  get<T = unknown>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown, options?: { ttlMs?: number }): Promise<void>;
  delete(key: string): Promise<void>;
  list<T = unknown>(prefix?: string): Promise<Array<{ key: string; value: T }>>;
}

/** 文件读写。写入位置由上下文决定：Source 等插件写附件，Agent 在 Run 中写产物。 */
export interface FileStore {
  /** 文件名会被清洗（去掉路径分隔符、..、控制字符），同名时自动加序号。 */
  put(data: Uint8Array | string, meta: { name: string; mime?: string }): Promise<FileRef>;
  /** 读取任意文件（附件或产物）。不存在时抛 NOT_FOUND。 */
  get(ref: string): Promise<Uint8Array>;
}

/** 内容存储（附件 + 产物），由宿主注入内核。默认实现见 @super-loop/host。 */
/** 一次 Run 在工作区中的位置。 */
export interface RunScope {
  taskId: TaskId;
  runId: RunId;
}

export interface ContentStore {
  readonly attachments: FileStore;
  artifacts(scope: RunScope): FileStore;
  read(ref: string): Promise<Uint8Array>;
  /** 不存在返回 undefined。 */
  stat(ref: string): Promise<FileRef | undefined>;
  /** 列出某次 Run 的全部产物（含 Agent 直接写入 artifacts/ 的文件）。 */
  listArtifacts(scope: RunScope): Promise<FileRef[]>;
}

export interface RunWorkspace {
  /** Agent 的工作目录（cwd），同一任务的所有 Run 共用：workspaces/<taskId>/work。 */
  work: string;
  /** 本次 Run 的交付结果目录 workspaces/<taskId>/artifacts/<runId>，Run 结束时自动登记为产物。 */
  artifacts: string;
}

/** 目录提供者，由宿主注入内核；不注入时 Run 没有工作区，插件也拿不到共享目录。 */
export interface DirectoryProvider {
  workspace(scope: RunScope): Promise<RunWorkspace>;
  shared(): Promise<string>;
  state(instance: InstanceName): Promise<string>;
  cache(plugin: string): Promise<string>;
}

/** 插件可用的目录，只包含 permissions 中声明过的。 */
export interface PluginPaths {
  shared?: string;
  state?: string;
  cache?: string;
}

export interface RunPaths extends PluginPaths {
  work?: string;
  artifacts?: string;
}

export interface SecretResolver {
  get(name: string): Promise<string | undefined>;
}

export interface PluginContext {
  readonly instance: InstanceName;
  readonly logger: Logger;
  readonly clock: Clock;
  readonly kv: KvStore;
  /** 插件级上下文写入附件；Run 上下文中写入本次 Run 的产物。 */
  readonly files: FileStore;
  readonly paths: PluginPaths;
  readonly secrets: SecretResolver;
  /** 插件实例被停止时触发。 */
  readonly signal: AbortSignal;
}

export interface EmitResult {
  envelopeId: EnvelopeId;
  duplicated: boolean;
}

export interface SourceContext extends PluginContext {
  emit(draft: EnvelopeDraft): Promise<EmitResult>;
}

export interface AgentRunContext extends PluginContext {
  readonly runId: RunId;
  readonly taskId: TaskId;
  readonly paths: RunPaths;
  /** Run 被取消或超时时触发（与实例级 signal 合并）。 */
  readonly signal: AbortSignal;
  /** 阻塞等待人工审批；内核负责记录、通知与超时。 */
  awaitApproval(request: ApprovalRequest): Promise<ApprovalOutcome>;
  /** 派生子任务，内核自动设置 trace.parentId/depth 并检查最大深度。 */
  spawn(draft: EnvelopeDraft): Promise<EmitResult>;
}

export type SinkContext = PluginContext;

export interface RouterContext extends PluginContext {
  /** 本批被取消或超时时触发（与实例级 signal 合并）。 */
  readonly signal: AbortSignal;
  readonly query: RouterQueries;
}

// ─────────────────────────── 插件实现接口 ───────────────────────────

interface Disposable {
  /** 实例卸载时调用，释放资源。 */
  dispose?(): Promise<void>;
}

export interface SourcePlugin extends Disposable {
  start(ctx: SourceContext): Promise<void>;
  stop(): Promise<void>;
  health(): Promise<HealthStatus>;
  /** 支持确认的来源（如 MQ）：Envelope 成功入库后调用。 */
  ack?(envelopeId: EnvelopeId, ref?: string): Promise<void>;
}

export interface AgentPlugin extends Disposable {
  readonly capabilities: AgentCapabilities;
  /** 校验 AgentBinding.options；不提供则 options 原样透传。 */
  readonly optionsSchema?: z.ZodType<Record<string, unknown>>;
  run(input: AgentRunInput, ctx: AgentRunContext): AsyncIterable<AgentEvent>;
  /** 不实现时内核直接终止执行进程。 */
  cancel?(runId: RunId): Promise<void>;
  health(): Promise<HealthStatus>;
}

export interface SinkPlugin extends Disposable {
  deliver(notification: Notification, ctx: SinkContext): Promise<DeliveryResult>;
  health(): Promise<HealthStatus>;
}

/**
 * Router：判断待分配的 Task 应该派给哪个 Agent（可以是 LLM / Agent 驱动）。
 * 只返回决策，状态迁移由内核执行；同一实例同时只会收到一批。
 */
export interface RouterPlugin extends Disposable {
  route(request: RouterRequest, ctx: RouterContext): Promise<RouterResult>;
  health(): Promise<HealthStatus>;
}

/** @experimental M4 前可能调整。 */
export interface ProbePlugin extends Disposable {
  readonly intervalMs: number;
  collect(ctx: PluginContext): Promise<ProbeSample[]>;
}

/** @experimental M4 前可能调整。 */
export interface PlaybookPlugin extends Disposable {
  /** 能处理的 Incident 类型，支持 glob。 */
  readonly handles: readonly string[];
  propose(
    incident: Incident,
    ctx: PluginContext,
  ): Promise<Omit<Remediation, 'id' | 'status' | 'createdAt' | 'updatedAt' | 'approvalId'> | null>;
  execute(
    action: RemediationAction,
    ctx: PluginContext,
  ): Promise<{ ok: boolean; message?: string }>;
}

export interface PluginInstanceMap {
  source: SourcePlugin;
  agent: AgentPlugin;
  sink: SinkPlugin;
  router: RouterPlugin;
  probe: ProbePlugin;
  playbook: PlaybookPlugin;
}

/** 插件包的默认导出。 */
export interface PluginDefinition<K extends PluginKind = PluginKind, Config = unknown>
  extends PluginManifest {
  readonly kind: K;
  readonly configSchema: z.ZodType<Config>;
  create(config: Config, ctx: PluginContext): PluginInstanceMap[K] | Promise<PluginInstanceMap[K]>;
}
