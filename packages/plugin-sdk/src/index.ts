// 插件作者常用的协议类型，统一从 SDK 导出，减少依赖面。
export type * from '@super-loop/protocol';
export {
  AgentEventSchema,
  EnvelopeDraftSchema,
  NotificationSchema,
  PLUGIN_API_VERSION,
} from '@super-loop/protocol';
export { ErrorCode, LoopError, renderTemplate, sleep, withTimeout } from '@super-loop/shared';
export * from './agent.js';
export * from './define.js';
