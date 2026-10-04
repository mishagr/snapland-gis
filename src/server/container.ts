import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import type { PrismaClient } from '@/generated/prisma/client';
import { PolygonValidator } from '@/lib/geo/PolygonValidator';
import { AreaCache } from '@/server/areas/AreaCache';
import { AreaRepository } from '@/server/areas/AreaRepository';
import { AreaService } from '@/server/areas/AreaService';
import { AuditLogger } from '@/server/audit/AuditLogger';
import { AuthService } from '@/server/auth/AuthService';
import { PasswordHasher } from '@/server/auth/PasswordHasher';
import { SessionStore } from '@/server/auth/SessionStore';
import { getServerEnv, type ServerEnv } from '@/server/config/env';
import { getPrisma } from '@/server/db/prisma';
import { getRedis } from '@/server/db/redis';
import { getLogger } from '@/server/logging/logger';
import { HealthService } from '@/server/ops/HealthService';
import { RetentionService } from '@/server/ops/RetentionService';
import { InProcessEventBus, type DomainEventBus } from '@/server/realtime/EventBus';
import { RedisSlidingWindowRateLimiter, type RateLimiter } from '@/server/security/RateLimiter';

export interface Services {
  env: ServerEnv;
  logger: Logger;
  prisma: PrismaClient;
  redis: Redis;
  sessions: SessionStore;
  auth: AuthService;
  audit: AuditLogger;
  areaRepo: AreaRepository;
  areas: AreaService;
  bus: DomainEventBus;
  limiters: { draw: RateLimiter; login: RateLimiter; register: RateLimiter };
  health: HealthService;
  retention: RetentionService;
}

const globalForServices = globalThis as unknown as { __snaplandServices?: Services };

/**
 * Composition root. Stored on `globalThis` so the custom server (loaded by tsx)
 * and Next's separately bundled route handlers share one set of singletons,
 * in particular one event bus connecting REST writes to WebSocket fan-out.
 */
export function getServices(): Services {
  return (globalForServices.__snaplandServices ??= buildServices());
}

function buildServices(): Services {
  const env = getServerEnv();
  const logger = getLogger();
  const prisma = getPrisma();
  const redis = getRedis();
  const onLimiterError = (err: unknown) => logger.warn({ err }, 'rate limiter unavailable; failing open');
  const limiters = {
    draw: new RedisSlidingWindowRateLimiter(redis, { name: 'draw', limit: env.DRAW_RATE_LIMIT_PER_MIN, windowMs: 60_000 }, onLimiterError),
    login: new RedisSlidingWindowRateLimiter(redis, { name: 'login', limit: env.LOGIN_RATE_LIMIT, windowMs: 15 * 60_000 }, onLimiterError),
    register: new RedisSlidingWindowRateLimiter(redis, { name: 'register', limit: env.REGISTER_RATE_LIMIT, windowMs: 60 * 60_000 }, onLimiterError),
  };
  const audit = new AuditLogger(prisma, logger);
  const areaRepo = new AreaRepository(prisma);
  const bus = new InProcessEventBus();
  const areas = new AreaService({
    repo: areaRepo,
    cache: new AreaCache(redis, env.AREA_CACHE_TTL_SECONDS, logger),
    bus,
    audit,
    validator: new PolygonValidator(),
    drawLimiter: limiters.draw,
    logger,
    maxAreasPerQuery: env.MAX_AREAS_PER_QUERY,
  });
  return {
    env,
    logger,
    prisma,
    redis,
    sessions: new SessionStore(redis, env.SESSION_TTL_SECONDS),
    auth: new AuthService(prisma, new PasswordHasher()),
    audit,
    areaRepo,
    areas,
    bus,
    limiters,
    health: new HealthService(prisma, redis),
    retention: new RetentionService(
      prisma,
      areaRepo,
      redis,
      { softDeletedAreaDays: env.SOFT_DELETE_RETENTION_DAYS, auditLogDays: env.AUDIT_RETENTION_DAYS },
      logger,
    ),
  };
}
