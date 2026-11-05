import {
  AgentBindingSchema,
  BackoffSchema,
  DEFAULT_PRIORITY,
  DEFAULT_TASK_POLICY,
  type PluginDefinition,
  type PluginKind,
  PrioritySchema,
  RouteMatchSchema,
  SinkBindingSchema,
  type TaskPolicy,
  TaskPolicySchema,
} from '@super-loop/protocol';
import { ErrorCode, interpolateRefs, LoopError } from '@super-loop/shared';
import { z } from 'zod';

const PluginDefinitionSchema = z.custom<PluginDefinition<PluginKind, unknown>>(
  (v) =>
    typeof v === 'object' &&
    v !== null &&
    typeof (v as { create?: unknown }).create === 'function' &&
    typeof (v as { kind?: unknown }).kind === 'string',
  'expected a plugin definition (default export of a plugin package)',
);

export const PluginInstanceConfigSchema = z.object({
  use: PluginDefinitionSchema,
  config: z.unknown().optional(),
  enabled: z.boolean().default(true),
});

export const RouteConfigSchema = z.object({
  name: z.string().min(1),
  enabled: z.boolean().default(true),
  order: z.number().int().optional(),
  match: RouteMatchSchema.default({}),
  agents: z.array(AgentBindingSchema).min(1),
  sinks: z.array(SinkBindingSchema).default([]),
  policy: TaskPolicySchema.partial().default({}),
  stopOnMatch: z.boolean().default(true),
});
export type RouteConfig = z.input<typeof RouteConfigSchema>;

export const KernelConfigSchema = z.object({
  /** 看板/API 的对外地址，用于通知里的链接。 */
  publicUrl: z.string().url().default('http://localhost:7300'),
  /** key 为实例名 `<plugin>:<instance>`。 */
  plugins: z.record(z.string(), PluginInstanceConfigSchema).default({}),
  routes: z.array(RouteConfigSchema).default([]),
  defaults: z
    .object({
      policy: TaskPolicySchema.partial().default({}),
      priority: PrioritySchema.default(DEFAULT_PRIORITY),
      /** 对所有 Task 生效的通知绑定（例如看板收件箱）。 */
      sinks: z.array(SinkBindingSchema).default([]),
    })
    .prefault({}),
  limits: z
    .object({
      globalConcurrency: z.number().int().positive().default(4),
      maxSpawnDepth: z.number().int().nonnegative().default(3),
      shutdownGraceMs: z.number().int().nonnegative().default(30_000),
      /** Run 租约时长；Agent 每次产出事件都会续约。 */
      leaseMs: z.number().int().positive().default(60_000),
      /** 调度循环间隔（有新消息时会立即触发一次）。 */
      tickMs: z.number().int().positive().default(250),
      approvalTtlMs: z
        .number()
        .int()
        .positive()
        .default(24 * 3_600_000),
      /** 插件连续崩溃多少次后自动禁用。 */
      maxPluginCrashes: z.number().int().positive().default(5),
      pluginCallTimeoutMs: z.number().int().positive().default(30_000),
      delivery: z
        .object({
          maxAttempts: z.number().int().positive().default(5),
          backoff: BackoffSchema.default({ type: 'exponential', baseMs: 2_000, maxMs: 60_000 }),
        })
        .prefault({}),
    })
    .prefault({}),
});

export type KernelConfigInput = z.input<typeof KernelConfigSchema>;
export type KernelConfig = z.output<typeof KernelConfigSchema>;

/** 配置文件辅助函数：只做类型提示，校验在 Kernel 构造时进行。 */
export function defineConfig(config: KernelConfigInput): KernelConfigInput {
  return config;
}

/** 递归替换 `${env:NAME}`；缺失的变量直接报错。（`${secret:}` 由宿主在加载配置时处理） */
export function interpolateEnv(value: unknown, env: NodeJS.ProcessEnv, path = '$'): unknown {
  try {
    return interpolateRefs(
      value,
      (kind, name) => (kind === 'env' ? env[name] : `\${secret:${name}}`),
      path,
    );
  } catch (error) {
    throw new LoopError(ErrorCode.INVALID_CONFIG, (error as Error).message, { retryable: false });
  }
}

export function resolveConfig(input: KernelConfigInput): KernelConfig {
  const parsed = KernelConfigSchema.safeParse(input);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '$'}: ${i.message}`);
    throw new LoopError(
      ErrorCode.INVALID_CONFIG,
      `invalid kernel config\n  ${issues.join('\n  ')}`,
      {
        retryable: false,
        details: { issues },
      },
    );
  }
  return parsed.data;
}

type PolicyPatch = { [K in keyof TaskPolicy]?: TaskPolicy[K] | undefined };

/** 按顺序覆盖默认策略（忽略 undefined 字段）。 */
export function mergePolicy(...parts: PolicyPatch[]): TaskPolicy {
  const merged: Record<string, unknown> = { ...DEFAULT_TASK_POLICY };
  for (const part of parts) {
    for (const [k, v] of Object.entries(part)) if (v !== undefined) merged[k] = v;
  }
  return TaskPolicySchema.parse(merged);
}
