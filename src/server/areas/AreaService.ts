import type { Logger } from 'pino';
import type { CreateAreaInput, UpdateAreaInput } from '@/lib/api/schemas';
import type { AreaDto, AreaListResponse, AreaVersionDto, ConflictDetails } from '@/lib/api/types';
import type { PolygonValidator } from '@/lib/geo/PolygonValidator';
import type { BBox, PolygonGeometry } from '@/lib/geo/types';
import type { AuditLogger } from '@/server/audit/AuditLogger';
import { ApiError } from '@/server/http/errors';
import type { AreaEventType, DomainEventBus } from '@/server/realtime/EventBus';
import type { RateLimiter } from '@/server/security/RateLimiter';
import type { AreaCache, CacheStatus } from './AreaCache';
import type { AreaRepository } from './AreaRepository';

export interface Actor {
  id: string;
  displayName: string;
}

export interface RequestMeta {
  ip?: string;
  userAgent?: string | null;
  requestId?: string;
}

export interface AreaServiceDeps {
  repo: AreaRepository;
  cache: AreaCache;
  bus: DomainEventBus;
  audit: AuditLogger;
  validator: PolygonValidator;
  drawLimiter: RateLimiter;
  logger: Logger;
  maxAreasPerQuery: number;
}

/** Metres per degree of latitude; good enough to turn a pixel size into a tolerance. */
const METRES_PER_DEGREE = 111_320;

/**
 * Business rules for areas:
 * - everyone can read and edit any live area (collaborative map);
 * - only the owner can delete / restore;
 * - every change bumps `version`; writers must send the version they edited
 *   (`expectedVersion`) and get 409 + current state when someone was faster;
 * - create/update/delete/restore count as drawing actions (rate limited).
 */
export class AreaService {
  constructor(private readonly deps: AreaServiceDeps) {}

  /**
   * @param resolution ground resolution of the client viewport in metres/pixel; when
   *   zoomed out (> 2 m/px) geometry is simplified to ~½ pixel, cutting payload size.
   */
  async list(bbox: BBox, resolution?: number): Promise<AreaListResponse & { cache: CacheStatus }> {
    const tolerance = resolution && resolution > 2 ? (resolution * 0.5) / METRES_PER_DEGREE : 0;
    const bucket = tolerance > 0 ? `r${Math.round(Math.log2(resolution!))}` : 'full';
    const { value, status } = await this.deps.cache.getOrLoad(bbox, bucket, (snapped) =>
      this.deps.repo.findInBBox(snapped, this.deps.maxAreasPerQuery, tolerance),
    );
    return { ...value, cache: status };
  }

  async get(id: string): Promise<AreaDto> {
    const area = await this.deps.repo.findById(id);
    if (!area) throw ApiError.notFound('Area not found');
    return area;
  }

  async versions(id: string): Promise<AreaVersionDto[]> {
    const area = await this.deps.repo.findById(id, true);
    if (!area) throw ApiError.notFound('Area not found');
    return this.deps.repo.listVersions(id);
  }

  async create(actor: Actor, input: CreateAreaInput, meta: RequestMeta): Promise<AreaDto> {
    const geometry = this.validateGeometry(input.geometry);
    await this.enforceDrawLimit(actor, meta, 'create');
    const area = await this.deps.repo.create({ ownerId: actor.id, name: input.name, description: input.description, geometry });
    await this.afterWrite('area.created', area, actor, meta, { areaSqKm: area.areaSqKm, vertexCount: area.vertexCount });
    return area;
  }

  async update(actor: Actor, id: string, input: UpdateAreaInput, meta: RequestMeta): Promise<AreaDto> {
    const geometry = input.geometry ? this.validateGeometry(input.geometry) : undefined;
    await this.enforceDrawLimit(actor, meta, 'update');
    const outcome = await this.deps.repo.update(
      id,
      input.expectedVersion,
      { name: input.name, description: input.description, geometry },
      actor.id,
    );
    if (outcome.status === 'not_found') throw ApiError.notFound('Area not found');
    if (outcome.status === 'conflict') throw this.conflict(actor, outcome.current, input.expectedVersion, meta);
    await this.afterWrite(
      'area.updated',
      outcome.area,
      actor,
      meta,
      { fromVersion: input.expectedVersion, changed: Object.keys(input).filter((k) => k !== 'expectedVersion') },
      outcome.previousBBox,
    );
    return outcome.area;
  }

  async delete(actor: Actor, id: string, expectedVersion: number | undefined, meta: RequestMeta): Promise<AreaDto> {
    await this.enforceDrawLimit(actor, meta, 'delete');
    const outcome = await this.deps.repo.softDelete(id, actor.id, expectedVersion);
    if (outcome.status === 'not_found') throw ApiError.notFound('Area not found');
    if (outcome.status === 'forbidden') throw ApiError.forbidden('Only the owner can delete this area');
    if (outcome.status === 'conflict') throw this.conflict(actor, outcome.current, expectedVersion ?? 0, meta);
    await this.afterWrite('area.deleted', outcome.area, actor, meta);
    return outcome.area;
  }

  async restore(actor: Actor, id: string, meta: RequestMeta): Promise<AreaDto> {
    await this.enforceDrawLimit(actor, meta, 'restore');
    const outcome = await this.deps.repo.restore(id, actor.id);
    if (outcome.status === 'not_found') throw ApiError.notFound('No deleted area with this id');
    if (outcome.status === 'forbidden') throw ApiError.forbidden('Only the owner can restore this area');
    if (outcome.status === 'conflict') throw ApiError.conflict('Area cannot be restored');
    await this.afterWrite('area.restored', outcome.area, actor, meta);
    return outcome.area;
  }

  private validateGeometry(input: unknown): PolygonGeometry {
    const result = this.deps.validator.validate(input);
    if (!result.ok) throw ApiError.invalidGeometry(result.issues[0]!.message, { issues: result.issues });
    return result.polygon;
  }

  private async enforceDrawLimit(actor: Actor, meta: RequestMeta, op: string): Promise<void> {
    const result = await this.deps.drawLimiter.consume(actor.id);
    if (result.allowed) return;
    this.deps.audit.record({
      action: 'rate_limit.exceeded',
      userId: actor.id,
      entityType: 'user',
      entityId: actor.id,
      metadata: { limiter: 'draw', op, limit: result.limit },
      ...meta,
    });
    throw ApiError.rateLimited(result.retryAfterMs);
  }

  private conflict(actor: Actor, current: AreaDto, expectedVersion: number, meta: RequestMeta): ApiError {
    this.deps.audit.record({
      action: 'area.conflict',
      userId: actor.id,
      entityType: 'area',
      entityId: current.id,
      metadata: { expectedVersion, currentVersion: current.version, lastEditor: current.updatedById },
      ...meta,
    });
    const details: ConflictDetails = { current };
    return ApiError.conflict(
      `This area was changed by ${current.updatedByName} (now version ${current.version}). Review their changes and try again.`,
      details,
    );
  }

  private async afterWrite(
    type: AreaEventType,
    area: AreaDto,
    actor: Actor,
    meta: RequestMeta,
    metadata: Record<string, unknown> = {},
    previousBBox?: BBox,
  ): Promise<void> {
    await this.deps.cache.invalidate();
    this.deps.bus.publish({ type, area, actor, previousBBox, at: new Date().toISOString() });
    const action = ({
      'area.created': 'area.create',
      'area.updated': 'area.update',
      'area.deleted': 'area.delete',
      'area.restored': 'area.restore',
    } as const)[type];
    this.deps.audit.record({
      action,
      userId: actor.id,
      entityType: 'area',
      entityId: area.id,
      metadata: { version: area.version, ...metadata },
      ...meta,
    });
  }
}
