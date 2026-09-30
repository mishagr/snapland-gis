import type { PrismaClient } from '@/generated/prisma/client';
import type { Logger } from 'pino';

export type AuditAction =
  | 'auth.register'
  | 'auth.login'
  | 'auth.login_failed'
  | 'auth.logout'
  | 'area.create'
  | 'area.update'
  | 'area.delete'
  | 'area.restore'
  | 'area.conflict'
  | 'rate_limit.exceeded'
  | 'ws.connect'
  | 'ws.rejected';

export interface AuditEntry {
  action: AuditAction;
  userId?: string | null;
  entityType: 'user' | 'area' | 'session' | 'socket';
  entityId?: string | null;
  metadata?: Record<string, unknown>;
  ip?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
}

/**
 * Append-only audit trail. Writes are fire-and-forget: an audit failure is logged
 * loudly but never fails the user's request. Every entry is also emitted to the
 * structured log so it reaches log shipping even if the DB write fails.
 */
export class AuditLogger {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly logger: Logger,
  ) {}

  record(entry: AuditEntry): void {
    this.logger.info({ audit: entry }, `audit ${entry.action}`);
    void this.prisma.auditLog
      .create({
        data: {
          action: entry.action,
          userId: entry.userId ?? null,
          entityType: entry.entityType,
          entityId: entry.entityId ?? null,
          metadata: (entry.metadata ?? {}) as object,
          ip: entry.ip?.slice(0, 64) ?? null,
          userAgent: entry.userAgent?.slice(0, 512) ?? null,
          requestId: entry.requestId ?? null,
        },
      })
      .catch((err: unknown) => this.logger.error({ err, audit: entry }, 'audit write failed'));
  }
}
