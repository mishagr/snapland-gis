import pino, { type Logger } from 'pino';

const globalForLogger = globalThis as unknown as { __snaplandLogger?: Logger };

/**
 * Structured JSON logger (one line per event). Pipe through `pino-pretty` for
 * human-readable output in development (`npm run dev:pretty`).
 */
export function getLogger(): Logger {
  return (globalForLogger.__snaplandLogger ??= pino({
    level: process.env.LOG_LEVEL ?? (process.env.NODE_ENV === 'test' ? 'silent' : 'info'),
    base: { service: 'snapland-gis' },
    redact: {
      paths: ['password', '*.password', 'passwordHash', '*.passwordHash', 'req.headers.cookie', 'headers.cookie'],
      censor: '[redacted]',
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  }));
}
