import type { ErrorPayload } from '@super-loop/protocol';

/** 内置错误码。插件可使用自定义码，但必须是 SCREAMING_SNAKE_CASE。 */
export const ErrorCode = {
  INTERNAL: 'INTERNAL',
  INVALID_INPUT: 'INVALID_INPUT',
  INVALID_CONFIG: 'INVALID_CONFIG',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  TIMEOUT: 'TIMEOUT',
  CANCELLED: 'CANCELLED',
  /** 被追问打断（"打断并发送"），不算失败。 */
  INTERRUPTED: 'INTERRUPTED',
  RATE_LIMITED: 'RATE_LIMITED',
  UNAVAILABLE: 'UNAVAILABLE',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  APPROVAL_REJECTED: 'APPROVAL_REJECTED',
  BUDGET_EXCEEDED: 'BUDGET_EXCEEDED',
  SPAWN_DEPTH_EXCEEDED: 'SPAWN_DEPTH_EXCEEDED',
  ILLEGAL_TRANSITION: 'ILLEGAL_TRANSITION',
  PLUGIN_INCOMPATIBLE: 'PLUGIN_INCOMPATIBLE',
  PLUGIN_PROTOCOL_VIOLATION: 'PLUGIN_PROTOCOL_VIOLATION',
  PLUGIN_NOT_FOUND: 'PLUGIN_NOT_FOUND',
  AGENT_FAILED: 'AGENT_FAILED',
  KERNEL_RESTARTED: 'KERNEL_RESTARTED',
  KERNEL_SHUTDOWN: 'KERNEL_SHUTDOWN',
} as const;
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

/** 默认可重试的错误码。 */
const RETRYABLE_BY_DEFAULT: ReadonlySet<string> = new Set([
  ErrorCode.TIMEOUT,
  ErrorCode.RATE_LIMITED,
  ErrorCode.UNAVAILABLE,
  ErrorCode.KERNEL_RESTARTED,
  ErrorCode.KERNEL_SHUTDOWN,
]);

export interface LoopErrorOptions {
  cause?: unknown;
  retryable?: boolean;
  details?: Record<string, unknown>;
}

export class LoopError extends Error {
  override readonly name = 'LoopError';
  readonly code: string;
  readonly retryable: boolean;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: string, message: string, options: LoopErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.code = code;
    this.retryable = options.retryable ?? RETRYABLE_BY_DEFAULT.has(code);
    this.details = options.details;
  }

  toPayload(): ErrorPayload {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      ...(this.details ? { details: this.details } : {}),
    };
  }
}

export function isLoopError(error: unknown): error is LoopError {
  return error instanceof LoopError;
}

/** 把任意异常规整为 LoopError；AbortError 映射为 CANCELLED。 */
export function toLoopError(error: unknown, fallbackCode: string = ErrorCode.INTERNAL): LoopError {
  if (isLoopError(error)) return error;
  if (error instanceof Error) {
    if (error.name === 'AbortError') {
      return new LoopError(ErrorCode.CANCELLED, error.message, { cause: error, retryable: false });
    }
    return new LoopError(fallbackCode, error.message, { cause: error });
  }
  return new LoopError(fallbackCode, String(error));
}
