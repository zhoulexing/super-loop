import { z } from 'zod';
import { ActorSchema, SubjectRefSchema, TimestampSchema } from './common.js';
import { EventIdSchema, TraceIdSchema } from './ids.js';

/**
 * Journal 事件类型全集。命名：`<subject>.<过去式>`。
 * 已发布的类型不可删除或改语义；新增类型需升 protocol minor 版本。
 */
export const JOURNAL_EVENT_TYPES = [
  // envelope
  'envelope.received',
  'envelope.duplicated',
  'envelope.routed',
  'envelope.unrouted',
  'envelope.rejected',
  // task
  'task.created',
  'task.assigned',
  'task.unassigned',
  'task.queued',
  'task.reprioritized',
  'task.awaiting_input',
  'task.failed',
  'task.closed',
  'task.reopened',
  // turn（会话轮次）
  'turn.added',
  'turn.completed',
  'turn.failed',
  'turn.interrupted',
  'turn.cancelled',
  // routing（Router 插件自动分配）
  'routing.requested',
  'routing.decided',
  'routing.failed',
  // run
  'run.started',
  'run.event',
  'run.heartbeat',
  'run.succeeded',
  'run.failed',
  'run.timed_out',
  'run.cancelled',
  // approval
  'approval.requested',
  'approval.granted',
  'approval.rejected',
  'approval.expired',
  // delivery
  'delivery.queued',
  'delivery.succeeded',
  'delivery.failed',
  'delivery.dead',
  // plugin
  'plugin.loaded',
  'plugin.crashed',
  'plugin.restarted',
  'plugin.disabled',
  // watchdog
  'incident.opened',
  'incident.updated',
  'incident.resolved',
  'remediation.proposed',
  'remediation.executed',
  'remediation.verified',
  'remediation.rolled_back',
  'remediation.failed',
  // kernel / config
  'kernel.started',
  'kernel.stopping',
  'config.changed',
  'route.upserted',
  'route.deleted',
] as const;

export const JournalEventTypeSchema = z.enum(JOURNAL_EVENT_TYPES);
export type JournalEventType = z.infer<typeof JournalEventTypeSchema>;

export const JournalEventSchema = z.object({
  /** 全局单调递增序号，由 Store 分配。 */
  seq: z.number().int().positive(),
  id: EventIdSchema,
  type: JournalEventTypeSchema,
  at: TimestampSchema,
  subject: SubjectRefSchema,
  actor: ActorSchema,
  traceId: TraceIdSchema.optional(),
  /** 事件载荷。各类型的具体 schema 随内核实现逐步补齐（M1）。 */
  data: z.unknown(),
});
export type JournalEvent = z.infer<typeof JournalEventSchema>;

/** 写入前的事件（seq 由 Store 分配）。 */
export const JournalEventDraftSchema = JournalEventSchema.omit({ seq: true });
export type JournalEventDraft = z.infer<typeof JournalEventDraftSchema>;
