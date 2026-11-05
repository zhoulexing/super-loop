import type { LogFields, Logger } from '@super-loop/protocol';
import { type DestinationStream, type Logger as PinoLogger, pino } from 'pino';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

export interface CreateLoggerOptions {
  name: string;
  level?: LogLevel;
  bindings?: LogFields;
  destination?: DestinationStream;
  /** 同时追加写入的日志文件（目录不存在会自动创建）。 */
  file?: string;
}

/** 需要脱敏的字段路径。 */
const REDACT_PATHS = [
  '*.token',
  '*.apiKey',
  '*.password',
  '*.secret',
  '*.authorization',
  'headers.authorization',
];

function wrap(p: PinoLogger): Logger {
  return {
    debug: (msg, fields) => p.debug(fields ?? {}, msg),
    info: (msg, fields) => p.info(fields ?? {}, msg),
    warn: (msg, fields) => p.warn(fields ?? {}, msg),
    error: (msg, fields) => p.error(fields ?? {}, msg),
    child: (bindings) => wrap(p.child(bindings)),
  };
}

/** 结构化日志（pino）。必须带 traceId / runId 等上下文时用 child()。 */
export function createLogger(options: CreateLoggerOptions): Logger {
  const base = pino(
    {
      name: options.name,
      level: options.level ?? (process.env.SUPER_LOOP_LOG_LEVEL as LogLevel | undefined) ?? 'info',
      redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    options.file
      ? pino.multistream([
          { stream: options.destination ?? process.stdout },
          { stream: pino.destination({ dest: options.file, mkdir: true, sync: false }) },
        ])
      : options.destination,
  );
  return wrap(options.bindings ? base.child(options.bindings) : base);
}

export const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => noopLogger,
};
