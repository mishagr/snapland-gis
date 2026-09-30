import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import type { PrismaClient } from '@/generated/prisma/client';
import type { AreaRepository } from '@/server/areas/AreaRepository';

export interface RetentionPolicy {
  softDeletedAreaDays: number;
  auditLogDays: number;
}

/**
 * Data retention: soft-deleted areas are recoverable for N days, then hard-deleted
 * (with their history); audit rows older than M days are dropped. Runs on a timer
 * in every instance, but a Redis lock ensures only one instance purges per cycle.
 */
export class RetentionService {
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly repo: AreaRepository,
    private readonly redis: Redis,
    private readonly policy: RetentionPolicy,
    private readonly logger: Logger,
  ) {}

  async purge(now = new Date()): Promise<{ areas: number; auditLogs: number }> {
    const day = 24 * 3600 * 1000;
    const areas = await this.repo.purgeDeletedBefore(new Date(now.getTime() - this.policy.softDeletedAreaDays * day));
    let auditLogs = 0;
    const auditCutoff = new Date(now.getTime() - this.policy.auditLogDays * day);
    for (;;) {
      const deleted = await this.prisma.$executeRaw`
        DELETE FROM audit_logs WHERE id IN (SELECT id FROM audit_logs WHERE created_at < ${auditCutoff} LIMIT 5000)`;
      auditLogs += deleted;
      if (deleted < 5000) break;
    }
    this.logger.info({ areas, auditLogs }, 'retention purge finished');
    return { areas, auditLogs };
  }

  start(intervalMinutes: number): void {
    if (intervalMinutes <= 0 || this.timer) return;
    const intervalMs = intervalMinutes * 60_000;
    const run = async () => {
      try {
        const acquired = await this.redis.set('retention:lock', String(process.pid), 'PX', intervalMs - 1000, 'NX');
        if (acquired) await this.purge();
      } catch (err) {
        this.logger.error({ err }, 'retention purge failed');
      }
    };
    this.timer = setInterval(run, intervalMs);
    this.timer.unref();
    setTimeout(run, 30_000).unref();
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }
}
