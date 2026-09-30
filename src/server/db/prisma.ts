import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@/generated/prisma/client';
import { getServerEnv } from '@/server/config/env';

const globalForPrisma = globalThis as unknown as { __snaplandPrisma?: PrismaClient };

/**
 * One PrismaClient per process, backed by a bounded `pg` pool. Every query runs
 * with a server-side statement timeout so a slow spatial query cannot pin a
 * connection indefinitely. The instance lives on `globalThis` because the custom
 * server and Next's bundled route handlers load separate copies of this module.
 */
export function getPrisma(): PrismaClient {
  if (globalForPrisma.__snaplandPrisma) return globalForPrisma.__snaplandPrisma;
  const env = getServerEnv();
  const adapter = new PrismaPg({
    connectionString: env.DATABASE_URL,
    max: env.DB_POOL_MAX,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    statement_timeout: env.DB_STATEMENT_TIMEOUT_MS,
    application_name: 'snapland-gis',
  });
  globalForPrisma.__snaplandPrisma = new PrismaClient({ adapter });
  return globalForPrisma.__snaplandPrisma;
}

export async function disconnectPrisma(): Promise<void> {
  await globalForPrisma.__snaplandPrisma?.$disconnect();
  globalForPrisma.__snaplandPrisma = undefined;
}
