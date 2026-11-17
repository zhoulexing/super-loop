import type { ApiErrorBody } from '@super-loop/protocol';

/**
 * API 调用失败。`code` 与服务端错误码一致（`NOT_FOUND`、`CONFLICT` 等）；
 * 网络不可达时 `code = 'UNAVAILABLE'`、`status = 0`。
 */
export class LoopApiError extends Error {
  override readonly name = 'LoopApiError';

  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }

  /** 可以稍后重试的错误：网络问题、5xx、429。 */
  get retryable(): boolean {
    return this.status === 0 || this.status === 429 || this.status >= 500;
  }
}

export function isLoopApiError(error: unknown): error is LoopApiError {
  return error instanceof LoopApiError;
}

/** 把非 2xx 响应转成 LoopApiError（响应体不是约定格式时用 HTTP 状态兜底）。 */
export async function errorFromResponse(res: Response): Promise<LoopApiError> {
  let body: Partial<ApiErrorBody> | undefined;
  try {
    body = (await res.json()) as Partial<ApiErrorBody>;
  } catch {
    body = undefined;
  }
  const e = body?.error;
  if (e && typeof e.code === 'string') {
    return new LoopApiError(e.code, e.message ?? e.code, res.status, e.details);
  }
  return new LoopApiError(
    res.status >= 500 ? 'INTERNAL' : 'HTTP_ERROR',
    `HTTP ${res.status} ${res.statusText}`.trim(),
    res.status,
  );
}
