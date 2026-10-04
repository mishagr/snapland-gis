import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default('0.0.0.0'),
  /** Public origin of the app; used for CORS, Origin checks and cookies. */
  APP_ORIGIN: z.url().default('http://localhost:3000'),
  /** Extra origins allowed for CORS / WebSocket (comma separated). */
  ALLOWED_ORIGINS: z.string().default(''),
  TRUST_PROXY: bool.default(false),
  DATABASE_URL: z.string().min(1),
  DB_POOL_MAX: z.coerce.number().int().positive().default(10),
  DB_STATEMENT_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
  REDIS_URL: z.string().min(1).default('redis://localhost:6379'),
  REDIS_KEY_PREFIX: z.string().default('snapland:'),
  SESSION_TTL_SECONDS: z.coerce.number().int().positive().default(7 * 24 * 3600),
  COOKIE_SECURE: bool.optional(),
  DRAW_RATE_LIMIT_PER_MIN: z.coerce.number().int().positive().default(50),
  /** Sign-in attempts per IP+email per 15 minutes. */
  LOGIN_RATE_LIMIT: z.coerce.number().int().positive().default(10),
  /** Registrations per IP per hour. */
  REGISTER_RATE_LIMIT: z.coerce.number().int().positive().default(5),
  AREA_CACHE_TTL_SECONDS: z.coerce.number().int().nonnegative().default(60),
  MAX_AREAS_PER_QUERY: z.coerce.number().int().positive().default(2000),
  REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  SOFT_DELETE_RETENTION_DAYS: z.coerce.number().int().positive().default(30),
  AUDIT_RETENTION_DAYS: z.coerce.number().int().positive().default(365),
  RETENTION_INTERVAL_MINUTES: z.coerce.number().int().nonnegative().default(360),
  WS_MAX_CONNECTIONS_PER_USER: z.coerce.number().int().positive().default(10),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

export type ServerEnv = z.infer<typeof schema> & { allowedOrigins: string[]; cookieSecure: boolean };

let cached: ServerEnv | undefined;

/** Parsed, validated server configuration (throws with a readable message when invalid). */
export function getServerEnv(): ServerEnv {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid server environment: ${problems}`);
  }
  const env = parsed.data;
  const allowedOrigins = [env.APP_ORIGIN, ...env.ALLOWED_ORIGINS.split(',')]
    .map((o) => o.trim().replace(/\/$/, ''))
    .filter(Boolean);
  cached = {
    ...env,
    allowedOrigins: [...new Set(allowedOrigins)],
    cookieSecure: env.COOKIE_SECURE ?? env.APP_ORIGIN.startsWith('https://'),
  };
  return cached;
}

/** For tests only. */
export function resetServerEnvCache(): void {
  cached = undefined;
}
