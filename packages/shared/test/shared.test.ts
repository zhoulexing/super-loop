import { describe, expect, it } from 'vitest';
import {
  computeBackoffMs,
  ErrorCode,
  isId,
  LoopError,
  newId,
  renderTemplate,
  sleep,
  toLoopError,
  withTimeout,
} from '../src/index.js';

describe('id', () => {
  it('生成带前缀且单调递增的 ULID', () => {
    const a = newId('task');
    const b = newId('task');
    expect(isId('task', a)).toBe(true);
    expect(isId('run', a)).toBe(false);
    expect(a < b).toBe(true);
  });
});

describe('errors', () => {
  it('按错误码推断是否可重试', () => {
    expect(new LoopError(ErrorCode.TIMEOUT, 'x').retryable).toBe(true);
    expect(new LoopError(ErrorCode.INVALID_INPUT, 'x').retryable).toBe(false);
    expect(new LoopError(ErrorCode.INVALID_INPUT, 'x', { retryable: true }).retryable).toBe(true);
  });

  it('toLoopError 规整任意异常', () => {
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    expect(toLoopError(abort).code).toBe('CANCELLED');
    expect(toLoopError('boom').code).toBe('INTERNAL');
    expect(toLoopError(new Error('x')).toPayload()).toEqual({
      code: 'INTERNAL',
      message: 'x',
      retryable: false,
    });
  });
});

describe('backoff', () => {
  const exp = { type: 'exponential', baseMs: 100, maxMs: 1_000 } as const;
  it('指数退避并封顶', () => {
    expect([1, 2, 3, 4, 5].map((n) => computeBackoffMs(exp, n))).toEqual([
      100, 200, 400, 800, 1000,
    ]);
  });
  it('固定退避与 jitter', () => {
    expect(computeBackoffMs({ ...exp, type: 'fixed' }, 5)).toBe(100);
    expect(computeBackoffMs(exp, 3, 0.5)).toBe(200);
  });
});

describe('withTimeout / sleep', () => {
  it('超时抛出 TIMEOUT 并中止内部 signal', async () => {
    let inner: AbortSignal | undefined;
    await expect(
      withTimeout(
        (signal) => {
          inner = signal;
          return sleep(1_000, signal);
        },
        20,
        { label: 'probe' },
      ),
    ).rejects.toMatchObject({ code: 'TIMEOUT', message: 'probe timed out after 20ms' });
    expect(inner?.aborted).toBe(true);
  });

  it('外部取消抛出 CANCELLED', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 10);
    await expect(
      withTimeout(() => new Promise(() => {}), 1_000, { signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'CANCELLED' });
  });

  it('正常完成返回结果', async () => {
    await expect(withTimeout(async () => 42, 100)).resolves.toBe(42);
  });
});

describe('template', () => {
  it('渲染点路径变量，缺失为空', () => {
    const vars = { envelope: { subject: 'hello', payload: { n: 1 } } };
    expect(renderTemplate('{{ envelope.subject }} {{envelope.payload}} [{{nope.x}}]', vars)).toBe(
      'hello {"n":1} []',
    );
  });
});
