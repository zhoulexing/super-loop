import type { AgentError, AgentEvent, AgentResultEvent, HealthStatus } from '@super-loop/protocol';
import { toLoopError } from '@super-loop/shared';

export const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;

/**
 * 包装 Agent 事件流：在 `intervalMs` 内没有任何事件时自动插入 heartbeat，
 * 让内核续约租约。长时间静默的 Agent（例如等待子进程）都应使用它。
 */
export async function* withHeartbeat(
  events: AsyncIterable<AgentEvent>,
  options: { intervalMs?: number } = {},
): AsyncGenerator<AgentEvent, void, undefined> {
  const intervalMs = options.intervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  const iterator = events[Symbol.asyncIterator]();
  let pending = iterator.next();
  let finished = false;
  try {
    while (true) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const tick = new Promise<'tick'>((resolve) => {
        timer = setTimeout(() => resolve('tick'), intervalMs);
      });
      const next = await Promise.race([pending, tick]);
      clearTimeout(timer);
      if (next === 'tick') {
        yield { type: 'heartbeat' };
        continue;
      }
      if (next.done) {
        finished = true;
        return;
      }
      yield next.value;
      pending = iterator.next();
    }
  } finally {
    // 消费方提前退出时通知上游；不等待，避免上游阻塞导致挂起。
    if (!finished) void iterator.return?.()?.catch(() => {});
  }
}

export function succeeded(summary: string, output?: unknown): AgentResultEvent {
  return {
    type: 'result',
    status: 'succeeded',
    summary,
    ...(output === undefined ? {} : { output }),
  };
}

export function failed(error: AgentError, summary: string = error.message): AgentResultEvent {
  return { type: 'result', status: 'failed', summary, error };
}

/** 把任意异常转换成失败的 result 事件。 */
export function failedFrom(error: unknown): AgentResultEvent {
  return failed(toLoopError(error).toPayload());
}

export function healthy(at: string, message?: string): HealthStatus {
  return { status: 'healthy', checkedAt: at, ...(message === undefined ? {} : { message }) };
}

export function unhealthy(at: string, message: string): HealthStatus {
  return { status: 'unhealthy', checkedAt: at, message };
}
