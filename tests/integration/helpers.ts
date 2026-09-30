import type { PolygonGeometry } from '@/lib/geo/types';

/**
 * Integration tests run against real PostgreSQL/PostGIS and Redis.
 * Set TEST_DATABASE_URL (a disposable, migrated database) and TEST_REDIS_URL
 * (a Redis DB index that may be flushed, e.g. redis://localhost:6379/15);
 * otherwise the suites are skipped.
 */
export const integrationEnabled = Boolean(process.env.TEST_DATABASE_URL && process.env.TEST_REDIS_URL);

export async function bootServices() {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.REDIS_URL = process.env.TEST_REDIS_URL;
  process.env.REDIS_KEY_PREFIX = 'snapland-test:';
  process.env.AREA_CACHE_TTL_SECONDS = '60';
  process.env.LOG_LEVEL = 'silent';
  const { getServices } = await import('@/server/container');
  return getServices();
}

export async function resetData(services: Awaited<ReturnType<typeof bootServices>>) {
  await services.prisma.$executeRawUnsafe('TRUNCATE audit_logs, area_versions, areas, users RESTART IDENTITY CASCADE');
  await services.redis.flushdb();
}

export async function shutdown(services: Awaited<ReturnType<typeof bootServices>>) {
  await services.prisma.$disconnect();
  services.redis.disconnect();
}

export function square(lng: number, lat: number, size = 0.01): PolygonGeometry {
  return {
    type: 'Polygon',
    coordinates: [[[lng, lat], [lng + size, lat], [lng + size, lat + size], [lng, lat + size], [lng, lat]]],
  };
}

export async function makeUser(services: Awaited<ReturnType<typeof bootServices>>, name: string) {
  const user = await services.auth.register({ email: `${name.toLowerCase()}@test.local`, password: 'password123', displayName: name });
  return { id: user.id, displayName: user.displayName };
}
