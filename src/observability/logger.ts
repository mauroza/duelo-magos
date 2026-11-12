import { trace } from '@opentelemetry/api';
import { pino, type Logger } from 'pino';

/** Logs estructurados en JSON, correlacionados con la traza activa. Nunca registran secretos. */
export function createLogger(level: string, instanceId: string): Logger {
  return pino({
    level,
    base: { service: 'duelo-magos', instance: instanceId },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'password',
        'refreshToken',
        'accessToken',
        'ticket',
        '*.password',
        '*.refreshToken',
        '*.ticket',
      ],
      censor: '[redactado]',
    },
    mixin() {
      const span = trace.getActiveSpan();
      if (!span) return {};
      const ctx = span.spanContext();
      return { traceId: ctx.traceId, spanId: ctx.spanId };
    },
  });
}

export type { Logger };
