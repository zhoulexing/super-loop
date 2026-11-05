import {
  type AgentRunContext,
  type ApprovalOutcome,
  type ApprovalRequest,
  type ContentStore,
  type EmitResult,
  type EnvelopeDraft,
  EnvelopeDraftSchema,
  type InstanceName,
  type LogFields,
  type Logger,
  type PluginContext,
  type PluginPaths,
  type RunId,
  type RunPaths,
  type SourceContext,
} from '@super-loop/protocol';
import { createMemoryContentStore, newId } from '@super-loop/shared';
import { FakeClock } from './clock.js';
import { createMemoryKv, createStaticSecrets } from './memory.js';

export interface LogRecord {
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  fields: LogFields;
}

/** 记录所有日志的 Logger，便于断言。 */
export function createRecordingLogger(records: LogRecord[] = [], bindings: LogFields = {}) {
  const log =
    (level: LogRecord['level']) =>
    (message: string, fields: LogFields = {}) => {
      records.push({ level, message, fields: { ...bindings, ...fields } });
    };
  const logger: Logger & { records: LogRecord[] } = {
    records,
    debug: log('debug'),
    info: log('info'),
    warn: log('warn'),
    error: log('error'),
    child: (more) => createRecordingLogger(records, { ...bindings, ...more }),
  };
  return logger;
}

export interface TestPluginContextOptions {
  instance?: InstanceName;
  clock?: FakeClock;
  secrets?: Record<string, string>;
  signal?: AbortSignal;
  /** 共享的内容存储（附件 + 产物），默认新建一个内存实现。 */
  content?: ContentStore;
  paths?: PluginPaths;
}

export type TestPluginContext = PluginContext & {
  readonly content: ContentStore;
  readonly clock: FakeClock;
  readonly logger: ReturnType<typeof createRecordingLogger>;
};

export function createTestPluginContext(options: TestPluginContextOptions = {}): TestPluginContext {
  const clock = options.clock ?? new FakeClock();
  const content = options.content ?? createMemoryContentStore();
  return {
    content,
    instance: options.instance ?? 'test:default',
    logger: createRecordingLogger(),
    clock,
    kv: createMemoryKv(clock),
    files: content.attachments,
    paths: options.paths ?? {},
    secrets: createStaticSecrets(options.secrets),
    signal: options.signal ?? new AbortController().signal,
  };
}

export type TestSourceContext = SourceContext &
  TestPluginContext & {
    /** 已 emit 的草稿（已通过 schema 校验）。 */
    readonly emitted: EnvelopeDraft[];
  };

/** emit 时校验草稿并按 idempotencyKey 去重，行为与内核一致。 */
export function createTestSourceContext(options: TestPluginContextOptions = {}): TestSourceContext {
  const base = createTestPluginContext(options);
  const emitted: EnvelopeDraft[] = [];
  const seen = new Map<string, EmitResult['envelopeId']>();
  return {
    ...base,
    emitted,
    async emit(draft) {
      const parsed = EnvelopeDraftSchema.parse(draft);
      const existing = seen.get(parsed.idempotencyKey);
      if (existing) return { envelopeId: existing, duplicated: true };
      const envelopeId = newId('envelope');
      seen.set(parsed.idempotencyKey, envelopeId);
      emitted.push(parsed);
      return { envelopeId, duplicated: false };
    },
  };
}

export interface TestAgentRunContextOptions extends TestPluginContextOptions {
  runId?: RunId;
  /** Run 的目录（work / artifacts 等），默认为空。 */
  runPaths?: RunPaths;
  /** 审批策略，默认全部批准。 */
  approve?: boolean | ((request: ApprovalRequest) => boolean | Promise<boolean>);
}

export type TestAgentRunContext = AgentRunContext &
  TestPluginContext & {
    readonly approvalRequests: ApprovalRequest[];
    readonly spawned: EnvelopeDraft[];
  };

export function createTestAgentRunContext(
  options: TestAgentRunContextOptions = {},
): TestAgentRunContext {
  const base = createTestPluginContext(options);
  const approvalRequests: ApprovalRequest[] = [];
  const spawned: EnvelopeDraft[] = [];
  const approve = options.approve ?? true;
  const runId = options.runId ?? newId('run');
  return {
    ...base,
    runId,
    files: base.content.artifacts(runId),
    paths: { ...base.paths, ...options.runPaths },
    approvalRequests,
    spawned,
    async awaitApproval(request): Promise<ApprovalOutcome> {
      approvalRequests.push(request);
      const granted = typeof approve === 'function' ? await approve(request) : approve;
      return { approvalId: newId('approval'), granted };
    },
    async spawn(draft) {
      spawned.push(EnvelopeDraftSchema.parse(draft));
      return { envelopeId: newId('envelope'), duplicated: false };
    },
  };
}
