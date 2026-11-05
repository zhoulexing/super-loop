import { z } from 'zod';

/** ISO8601 时间戳（UTC 或带偏移）。 */
export const TimestampSchema = z.iso.datetime({ offset: true });
export type Timestamp = z.infer<typeof TimestampSchema>;

/** 0 最高，3 最低。 */
export const PrioritySchema = z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]);
export type Priority = z.infer<typeof PrioritySchema>;
export const DEFAULT_PRIORITY: Priority = 2;

export const RiskLevelSchema = z.enum(['low', 'medium', 'high', 'critical']);
export type RiskLevel = z.infer<typeof RiskLevelSchema>;
export const RISK_ORDER: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2, critical: 3 };

/** 审计主体：谁做了这件事。 */
export type Actor = 'kernel' | 'watchdog' | `plugin:${string}` | `user:${string}`;
export const ActorSchema: z.ZodType<Actor> = z
  .string()
  .regex(/^(kernel|watchdog|plugin:[\w.:-]+|user:[\w.@-]+)$/, 'invalid actor') as never;

/** 插件实例名：`<plugin>:<instance>`，如 `claude-code:default`、`lark:ops-group`。 */
export type InstanceName = `${string}:${string}`;
export const InstanceNameSchema: z.ZodType<InstanceName> = z
  .string()
  .regex(
    /^[a-z0-9][a-z0-9-]*:[a-z0-9][a-z0-9_-]*$/,
    'instance name must be "<plugin>:<instance>"',
  ) as never;

export const LabelsSchema = z.record(z.string(), z.string());
export type Labels = z.infer<typeof LabelsSchema>;

export const JsonObjectSchema = z.record(z.string(), z.unknown());
export type JsonObject = z.infer<typeof JsonObjectSchema>;

export const HealthStatusSchema = z.object({
  status: z.enum(['healthy', 'degraded', 'unhealthy']),
  message: z.string().optional(),
  checkedAt: TimestampSchema,
  details: JsonObjectSchema.optional(),
});
export type HealthStatus = z.infer<typeof HealthStatusSchema>;

/**
 * 文件引用。数据库只存逻辑地址，不存绝对路径，目录可以整体搬迁：
 * - 附件：`attachment:<YYYY-MM-DD>/<ULID>-<文件名>`
 * - 产物：`artifact:<runId>/<相对路径>`
 */
export const FILE_REF_PATTERN =
  /^(attachment:\d{4}-\d{2}-\d{2}\/[^/]+|artifact:run_[0-9A-HJKMNP-TV-Z]{26}\/.+)$/;

export const FileRefSchema = z.object({
  ref: z.string().regex(FILE_REF_PATTERN, 'invalid file ref'),
  name: z.string().min(1),
  mime: z.string().min(1),
  size: z.number().int().nonnegative(),
});
export type FileRef = z.infer<typeof FileRefSchema>;

export const SubjectKindSchema = z.enum([
  'envelope',
  'task',
  'run',
  'route',
  'approval',
  'incident',
  'remediation',
  'delivery',
  'plugin',
  'kernel',
  'config',
]);
export type SubjectKind = z.infer<typeof SubjectKindSchema>;

export const SubjectRefSchema = z.object({ kind: SubjectKindSchema, id: z.string().min(1) });
export type SubjectRef = z.infer<typeof SubjectRefSchema>;

/** 统一错误载荷（跨进程/跨插件传递用）。 */
export const ErrorPayloadSchema = z.object({
  code: z.string().regex(/^[A-Z][A-Z0-9_]*$/, 'error code must be SCREAMING_SNAKE_CASE'),
  message: z.string(),
  retryable: z.boolean(),
  details: JsonObjectSchema.optional(),
});
export type ErrorPayload = z.infer<typeof ErrorPayloadSchema>;
