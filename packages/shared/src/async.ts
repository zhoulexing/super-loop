import type { Backoff } from '@super-loop/protocol';
import { ErrorCode, LoopError } from './errors.js';

/**
 * 计算第 `attempt` 次失败后的退避时长（attempt 从 1 开始）。
 * `jitter` 取值 [0,1)，传入则使用 full jitter；不传则确定性（便于测试）。
 */
export function computeBackoffMs(backoff: Backoff, attempt: number, jitter?: number): number {
  const n = Math.max(1, Math.floor(attempt));
  const raw = backoff.type === 'fixed' ? backoff.baseMs : backoff.baseMs * 2 ** (n - 1);
  const capped = Math.min(backoff.maxMs, raw);
  return jitter === undefined ? capped : Math.floor(capped * jitter);
}

function abortReason(signal: AbortSignal): LoopError {
  const reason: unknown = signal.reason;
  if (reason instanceof LoopError) return reason;
  return new LoopError(ErrorCode.CANCELLED, 'operation aborted', {
    cause: reason,
    retryable: false,
  });
}

/** 可取消的 sleep。 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortReason(signal));
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortReason(signal as AbortSignal));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export interface WithTimeoutOptions {
  /** 外部取消信号，会与超时合并。 */
  signal?: AbortSignal;
  /** 超时错误中的描述。 */
  label?: string;
}

/**
 * 带超时执行一个异步操作。fn 收到的 signal 在超时或外部取消时触发，
 * fn 应当响应它以尽快释放资源。规范要求：对外部/插件调用一律使用本函数。
 */
export async function withTimeout<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  options: WithTimeoutOptions = {},
): Promise<T> {
  const controller = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([controller.signal, options.signal])
    : controller.signal;
  if (signal.aborted) throw abortReason(signal);

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const err = new LoopError(
        ErrorCode.TIMEOUT,
        `${options.label ?? 'operation'} timed out after ${timeoutMs}ms`,
      );
      controller.abort(err);
      reject(err);
    }, timeoutMs);
  });
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(abortReason(signal));
    signal.addEventListener('abort', onAbort, { once: true });
  });

  try {
    return await Promise.race([fn(signal), timeout, aborted]);
  } finally {
    clearTimeout(timer);
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

export function assertNever(value: never, message = 'unexpected value'): never {
  throw new LoopError(ErrorCode.INTERNAL, `${message}: ${JSON.stringify(value)}`);
}
