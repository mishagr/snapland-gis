import type { Redis } from 'ioredis';
import type { PrismaClient } from '@/generated/prisma/client';
import { readRealtimeStats, type RealtimeStats } from '@/server/realtime/stats';

export interface DependencyCheck {
  ok: boolean;
  latencyMs: number;
  error?: string;
  detail?: Record<string, unknown>;
}

export interface Readiness {
  status: 'ok' | 'down';
  checks: { database: DependencyCheck; redis: DependencyCheck };
  realtime: RealtimeStats | null;
  uptimeSeconds: number;
  memory: { rssMb: number; heapUsedMb: number };
}

const startedAt = Date.now();

/** Liveness (process up) vs readiness (dependencies reachable) for orchestrators and monitors. */
export class HealthService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly redis: Redis,
    private readonly timeoutMs = 2_000,
  ) {}

  liveness() {
    return { status: 'ok' as const, uptimeSeconds: Math.round((Date.now() - startedAt) / 1000), version: process.env.npm_package_version ?? '0.1.0' };
  }

  async readiness(): Promise<Readiness> {
    const [database, redis] = await Promise.all([
      this.check(async () => {
        const [row] = await this.prisma.$queryRaw<{ postgis: string }[]>`SELECT postgis_lib_version() AS postgis`;
        return { postgis: row?.postgis };
      }),
      this.check(async () => {
        await this.redis.ping();
        return {};
      }),
    ]);
    const mem = process.memoryUsage();
    return {
      status: database.ok && redis.ok ? 'ok' : 'down',
      checks: { database, redis },
      realtime: readRealtimeStats(),
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      memory: { rssMb: Math.round(mem.rss / 1048576), heapUsedMb: Math.round(mem.heapUsed / 1048576) },
    };
  }

  private async check(fn: () => Promise<Record<string, unknown>>): Promise<DependencyCheck> {
    const start = performance.now();
    let timer: NodeJS.Timeout | undefined;
    try {
      const detail = await Promise.race([
        fn(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`timed out after ${this.timeoutMs}ms`)), this.timeoutMs);
        }),
      ]);
      return { ok: true, latencyMs: Math.round(performance.now() - start), detail };
    } catch (err) {
      return { ok: false, latencyMs: Math.round(performance.now() - start), error: err instanceof Error ? err.message : String(err) };
    } finally {
      clearTimeout(timer);
    }
  }
}
