import { z } from 'zod';
import { InstanceNameSchema, SubjectRefSchema, TimestampSchema } from './common.js';
import { SinkTriggerSchema } from './envelope.js';
import { DeliveryIdSchema, TraceIdSchema } from './ids.js';

export const NotificationTriggerSchema = z.enum([...SinkTriggerSchema.options, 'incident']);
export type NotificationTrigger = z.infer<typeof NotificationTriggerSchema>;

export const NotificationSchema = z.object({
  /** 幂等键：同一 deliveryId 重复投递，Sink 应只产生一次外部效果（尽力而为）。 */
  deliveryId: DeliveryIdSchema,
  trigger: NotificationTriggerSchema,
  title: z.string().min(1),
  /** 已渲染的 Markdown。 */
  body: z.string(),
  links: z.object({
    dashboard: z.string().url(),
    approve: z.string().url().optional(),
    reject: z.string().url().optional(),
  }),
  subject: SubjectRefSchema,
  traceId: TraceIdSchema.optional(),
  data: z.unknown(),
});
export type Notification = z.infer<typeof NotificationSchema>;

export const DeliveryResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), externalId: z.string().optional() }),
  z.object({ ok: z.literal(false), retryable: z.boolean(), error: z.string() }),
]);
export type DeliveryResult = z.infer<typeof DeliveryResultSchema>;

/** queued（含失败后等待重试）→ succeeded | dead。每次失败记 delivery.failed 事件。 */
export const DeliveryStatusSchema = z.enum(['queued', 'succeeded', 'dead']);
export type DeliveryStatus = z.infer<typeof DeliveryStatusSchema>;

export const DeliverySchema = z.object({
  id: DeliveryIdSchema,
  sink: InstanceNameSchema,
  trigger: NotificationTriggerSchema,
  subject: SubjectRefSchema,
  status: DeliveryStatusSchema,
  attempts: z.number().int().nonnegative(),
  notBefore: TimestampSchema.optional(),
  lastError: z.string().optional(),
  externalId: z.string().optional(),
  /** 入队时渲染好的通知，重试时原样投递。 */
  notification: NotificationSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type Delivery = z.infer<typeof DeliverySchema>;
