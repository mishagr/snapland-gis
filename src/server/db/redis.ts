import { Redis } from 'ioredis';
import { getServerEnv } from '@/server/config/env';
import { getLogger } from '@/server/logging/logger';

const globalForRedis = globalThis as unknown as { __snaplandRedis?: Redis };

/**
 * Shared Redis connection (sessions, rate limiting, cache, retention lock).
 * Commands fail fast instead of queueing forever when Redis is down so callers
 * can degrade (cache bypass, rate-limit fail-open) rather than hang requests.
 */
export function getRedis(): Redis {
  if (globalForRedis.__snaplandRedis) return globalForRedis.__snaplandRedis;
  const env = getServerEnv();
  const redis = new Redis(env.REDIS_URL, {
    keyPrefix: env.REDIS_KEY_PREFIX,
    maxRetriesPerRequest: 2,
    connectTimeout: 5_000,
    commandTimeout: 3_000,
    retryStrategy: (attempt) => Math.min(attempt * 200, 5_000),
  });
  let lastErrorLog = 0;
  redis.on('error', (err) => {
    const now = Date.now();
    if (now - lastErrorLog > 10_000) {
      lastErrorLog = now;
      getLogger().error({ err }, 'redis connection error');
    }
  });
  globalForRedis.__snaplandRedis = redis;
  return redis;
}

export async function disconnectRedis(): Promise<void> {
  const redis = globalForRedis.__snaplandRedis;
  globalForRedis.__snaplandRedis = undefined;
  if (redis) await redis.quit().catch(() => redis.disconnect());
}
