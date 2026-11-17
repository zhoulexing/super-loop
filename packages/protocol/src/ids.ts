import { z } from 'zod';

/** 所有实体 ID 的前缀。ID 格式：`<prefix>_<ULID>`。 */
export const ID_PREFIX = {
  envelope: 'env',
  task: 'task',
  run: 'run',
  turn: 'turn',
  route: 'rt',
  /** 一批交给 Router 的 Task。 */
  routingBatch: 'rtb',
  approval: 'apv',
  incident: 'inc',
  remediation: 'rem',
  delivery: 'dlv',
  event: 'evt',
  trace: 'trc',
} as const;

export type IdKind = keyof typeof ID_PREFIX;
export type IdOf<K extends IdKind> = `${(typeof ID_PREFIX)[K]}_${string}`;

export const ULID_PATTERN = '[0-9A-HJKMNP-TV-Z]{26}';

function idSchema<K extends IdKind>(kind: K): z.ZodType<IdOf<K>> {
  return z
    .string()
    .regex(new RegExp(`^${ID_PREFIX[kind]}_${ULID_PATTERN}$`), `invalid ${kind} id`) as never;
}

export const EnvelopeIdSchema = idSchema('envelope');
export const TaskIdSchema = idSchema('task');
export const RunIdSchema = idSchema('run');
export const TurnIdSchema = idSchema('turn');
export const RouteIdSchema = idSchema('route');
export const ApprovalIdSchema = idSchema('approval');
export const IncidentIdSchema = idSchema('incident');
export const RemediationIdSchema = idSchema('remediation');
export const DeliveryIdSchema = idSchema('delivery');
export const EventIdSchema = idSchema('event');
export const TraceIdSchema = idSchema('trace');

export type EnvelopeId = IdOf<'envelope'>;
export type TaskId = IdOf<'task'>;
export type RunId = IdOf<'run'>;
export type TurnId = IdOf<'turn'>;
export type RouteId = IdOf<'route'>;
export type ApprovalId = IdOf<'approval'>;
export type IncidentId = IdOf<'incident'>;
export type RemediationId = IdOf<'remediation'>;
export type DeliveryId = IdOf<'delivery'>;
export type EventId = IdOf<'event'>;
export type TraceId = IdOf<'trace'>;
