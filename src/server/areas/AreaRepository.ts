import { Prisma, type PrismaClient } from '@/generated/prisma/client';
import type { AreaDto, AreaVersionDto } from '@/lib/api/types';
import type { BBox, PolygonGeometry } from '@/lib/geo/types';

interface AreaRow {
  id: string;
  owner_id: string;
  owner_name: string;
  name: string;
  description: string;
  area_sq_km: number;
  vertex_count: number;
  version: number;
  created_at: Date;
  updated_at: Date;
  updated_by_id: string;
  updated_by_name: string;
  deleted_at: Date | null;
  geometry: PolygonGeometry | string;
  simplified?: boolean;
  /** Only set by update(): bbox of the geometry before the change. */
  p_min_lng?: number;
  p_min_lat?: number;
  p_max_lng?: number;
  p_max_lat?: number;
}

interface VersionRow {
  version: number;
  action: AreaVersionDto['action'];
  name: string;
  description: string;
  area_sq_km: number;
  edited_by_id: string;
  edited_by_name: string;
  created_at: Date;
  geometry: PolygonGeometry | string;
}

export interface AreaPatch {
  name?: string;
  description?: string;
  geometry?: PolygonGeometry;
}

export type UpdateOutcome =
  | { status: 'updated'; area: AreaDto; previousBBox: BBox }
  | { status: 'conflict'; current: AreaDto }
  | { status: 'not_found' };

export type OwnerMutationOutcome =
  | { status: 'ok'; area: AreaDto }
  | { status: 'conflict'; current: AreaDto }
  | { status: 'forbidden' }
  | { status: 'not_found' };

/**
 * All SQL touching geometry lives here (Prisma cannot map PostGIS types).
 *
 * - Geometry enters as GeoJSON text → `ST_GeomFromGeoJSON`, SRID 4326.
 * - `area_sq_km` is always recomputed by PostGIS (`geography` = ellipsoidal) in the
 *   same statement, so clients can never persist a wrong area.
 * - Every mutation and its history row are written in one statement (data-modifying
 *   CTE), so history can never diverge from the live row.
 * - Optimistic locking: UPDATE … WHERE version = $expected. Under READ COMMITTED the
 *   second of two concurrent writers re-evaluates the predicate after the first
 *   commits, sees the bumped version and updates nothing → conflict.
 */
export class AreaRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Live areas whose bounding box overlaps `bbox` (GIST index, `&&` operator).
   * `simplifyTolerance` (degrees) thins vertices for low zooms; 0 returns full detail.
   */
  async findInBBox(bbox: BBox, limit: number, simplifyTolerance: number): Promise<{ areas: AreaDto[]; truncated: boolean }> {
    const rows = await this.prisma.$queryRaw<AreaRow[]>`
      SELECT a.id, a.owner_id, o.display_name AS owner_name, a.name, a.description, a.area_sq_km,
             a.vertex_count, a.version, a.created_at, a.updated_at, a.updated_by_id,
             u.display_name AS updated_by_name, a.deleted_at,
             ST_AsGeoJSON(
               CASE WHEN ${simplifyTolerance}::float8 > 0
                    THEN ST_SimplifyPreserveTopology(a.geom, ${simplifyTolerance}::float8)
                    ELSE a.geom END, 7)::json AS geometry,
             (${simplifyTolerance}::float8 > 0) AS simplified
      FROM areas a
      JOIN users o ON o.id = a.owner_id
      JOIN users u ON u.id = a.updated_by_id
      WHERE a.deleted_at IS NULL
        AND a.geom && ST_MakeEnvelope(${bbox.minLng}::float8, ${bbox.minLat}::float8, ${bbox.maxLng}::float8, ${bbox.maxLat}::float8, 4326)
      ORDER BY a.area_sq_km DESC, a.id
      LIMIT ${limit + 1}`;
    const truncated = rows.length > limit;
    return { areas: rows.slice(0, limit).map(toAreaDto), truncated };
  }

  async findById(id: string, includeDeleted = false): Promise<AreaDto | null> {
    const rows = await this.prisma.$queryRaw<AreaRow[]>`
      SELECT a.id, a.owner_id, o.display_name AS owner_name, a.name, a.description, a.area_sq_km,
             a.vertex_count, a.version, a.created_at, a.updated_at, a.updated_by_id,
             u.display_name AS updated_by_name, a.deleted_at, ST_AsGeoJSON(a.geom, 7)::json AS geometry
      FROM areas a
      JOIN users o ON o.id = a.owner_id
      JOIN users u ON u.id = a.updated_by_id
      WHERE a.id = ${id}::uuid AND (${includeDeleted}::boolean OR a.deleted_at IS NULL)`;
    return rows[0] ? toAreaDto(rows[0]) : null;
  }

  async create(input: { ownerId: string; name: string; description: string; geometry: PolygonGeometry }): Promise<AreaDto> {
    const rows = await this.prisma.$queryRaw<AreaRow[]>`
      WITH g AS (
        SELECT ST_SetSRID(ST_GeomFromGeoJSON(${JSON.stringify(input.geometry)}), 4326) AS geom
      ), ins AS (
        INSERT INTO areas (owner_id, name, description, geom, area_sq_km, vertex_count, updated_by_id)
        SELECT ${input.ownerId}::uuid, ${input.name}, ${input.description}, g.geom,
               ST_Area(g.geom::geography) / 1e6, ST_NPoints(g.geom) - 1, ${input.ownerId}::uuid
        FROM g
        RETURNING *
      ), hist AS (
        INSERT INTO area_versions (area_id, version, action, name, description, geom, area_sq_km, edited_by_id)
        SELECT id, version, 'CREATE', name, description, geom, area_sq_km, owner_id FROM ins
      )
      ${this.selectFrom('ins')}`;
    return toAreaDto(rows[0]!);
  }

  async update(id: string, expectedVersion: number, patch: AreaPatch, editorId: string): Promise<UpdateOutcome> {
    const geojson = patch.geometry ? JSON.stringify(patch.geometry) : null;
    const rows = await this.prisma.$queryRaw<AreaRow[]>`
      WITH prev AS (
        -- Same statement snapshot as the UPDATE: the geometry before this change.
        SELECT ST_XMin(geom) AS p_min_lng, ST_YMin(geom) AS p_min_lat, ST_XMax(geom) AS p_max_lng, ST_YMax(geom) AS p_max_lat
        FROM areas WHERE id = ${id}::uuid
      ), g AS (
        SELECT CASE WHEN ${geojson}::text IS NULL THEN NULL
                    ELSE ST_SetSRID(ST_GeomFromGeoJSON(${geojson}::text), 4326) END AS geom
      ), upd AS (
        UPDATE areas a SET
          name = COALESCE(${patch.name ?? null}::text, a.name),
          description = COALESCE(${patch.description ?? null}::text, a.description),
          geom = COALESCE(g.geom, a.geom),
          area_sq_km = CASE WHEN g.geom IS NULL THEN a.area_sq_km ELSE ST_Area(g.geom::geography) / 1e6 END,
          vertex_count = CASE WHEN g.geom IS NULL THEN a.vertex_count ELSE ST_NPoints(g.geom) - 1 END,
          version = a.version + 1,
          updated_at = now(),
          updated_by_id = ${editorId}::uuid
        FROM g
        WHERE a.id = ${id}::uuid AND a.version = ${expectedVersion}::int AND a.deleted_at IS NULL
        RETURNING a.*
      ), hist AS (
        INSERT INTO area_versions (area_id, version, action, name, description, geom, area_sq_km, edited_by_id)
        SELECT id, version, 'UPDATE', name, description, geom, area_sq_km, updated_by_id FROM upd
      )
      ${this.selectFrom('upd', 'prev')}`;
    const row = rows[0];
    if (row) {
      const previousBBox = { minLng: Number(row.p_min_lng), minLat: Number(row.p_min_lat), maxLng: Number(row.p_max_lng), maxLat: Number(row.p_max_lat) };
      return { status: 'updated', area: toAreaDto(row), previousBBox };
    }
    const current = await this.findById(id);
    return current ? { status: 'conflict', current } : { status: 'not_found' };
  }

  /** Soft delete; only the owner may delete. `expectedVersion` is optional. */
  async softDelete(id: string, actorId: string, expectedVersion?: number): Promise<OwnerMutationOutcome> {
    const rows = await this.prisma.$queryRaw<AreaRow[]>`
      WITH upd AS (
        UPDATE areas a SET deleted_at = now(), deleted_by_id = ${actorId}::uuid, version = a.version + 1,
                           updated_at = now(), updated_by_id = ${actorId}::uuid
        WHERE a.id = ${id}::uuid AND a.owner_id = ${actorId}::uuid AND a.deleted_at IS NULL
          AND (${expectedVersion ?? null}::int IS NULL OR a.version = ${expectedVersion ?? null}::int)
        RETURNING a.*
      ), hist AS (
        INSERT INTO area_versions (area_id, version, action, name, description, geom, area_sq_km, edited_by_id)
        SELECT id, version, 'DELETE', name, description, geom, area_sq_km, ${actorId}::uuid FROM upd
      )
      ${this.selectFrom('upd')}`;
    if (rows[0]) return { status: 'ok', area: toAreaDto(rows[0]) };
    return this.explainOwnerMiss(id, actorId, false);
  }

  /** Undo a soft delete (owner only) while the row is still inside the retention window. */
  async restore(id: string, actorId: string): Promise<OwnerMutationOutcome> {
    const rows = await this.prisma.$queryRaw<AreaRow[]>`
      WITH upd AS (
        UPDATE areas a SET deleted_at = NULL, deleted_by_id = NULL, version = a.version + 1,
                           updated_at = now(), updated_by_id = ${actorId}::uuid
        WHERE a.id = ${id}::uuid AND a.owner_id = ${actorId}::uuid AND a.deleted_at IS NOT NULL
        RETURNING a.*
      ), hist AS (
        INSERT INTO area_versions (area_id, version, action, name, description, geom, area_sq_km, edited_by_id)
        SELECT id, version, 'RESTORE', name, description, geom, area_sq_km, ${actorId}::uuid FROM upd
      )
      ${this.selectFrom('upd')}`;
    if (rows[0]) return { status: 'ok', area: toAreaDto(rows[0]) };
    return this.explainOwnerMiss(id, actorId, true);
  }

  async listVersions(areaId: string, limit = 50): Promise<AreaVersionDto[]> {
    const rows = await this.prisma.$queryRaw<VersionRow[]>`
      SELECT v.version, v.action, v.name, v.description, v.area_sq_km, v.edited_by_id,
             u.display_name AS edited_by_name, v.created_at, ST_AsGeoJSON(v.geom, 7)::json AS geometry
      FROM area_versions v
      JOIN users u ON u.id = v.edited_by_id
      WHERE v.area_id = ${areaId}::uuid
      ORDER BY v.version DESC
      LIMIT ${limit}`;
    return rows.map((r) => ({
      version: r.version,
      action: r.action,
      name: r.name,
      description: r.description,
      areaSqKm: Number(r.area_sq_km),
      editedById: r.edited_by_id,
      editedByName: r.edited_by_name,
      createdAt: r.created_at.toISOString(),
      geometry: parseGeometry(r.geometry),
    }));
  }

  /** Hard-deletes areas soft-deleted before `cutoff` (history cascades). Batched to keep locks short. */
  async purgeDeletedBefore(cutoff: Date, batchSize = 500): Promise<number> {
    let total = 0;
    for (;;) {
      const deleted = await this.prisma.$executeRaw`
        DELETE FROM areas WHERE id IN (
          SELECT id FROM areas WHERE deleted_at IS NOT NULL AND deleted_at < ${cutoff} LIMIT ${batchSize}
        )`;
      total += deleted;
      if (deleted < batchSize) return total;
    }
  }

  async countLive(): Promise<number> {
    const [row] = await this.prisma.$queryRaw<{ count: bigint }[]>`SELECT count(*) AS count FROM areas WHERE deleted_at IS NULL`;
    return Number(row?.count ?? 0);
  }

  /** Final SELECT of a mutation CTE, joined with user names. `cte` is a fixed identifier, never user input. */
  private selectFrom(cte: 'ins' | 'upd', prev?: 'prev'): Prisma.Sql {
    return Prisma.raw(`
      SELECT r.id, r.owner_id, o.display_name AS owner_name, r.name, r.description, r.area_sq_km,
             r.vertex_count, r.version, r.created_at, r.updated_at, r.updated_by_id,
             u.display_name AS updated_by_name, r.deleted_at, ST_AsGeoJSON(r.geom, 7)::json AS geometry
             ${prev ? ', p.p_min_lng, p.p_min_lat, p.p_max_lng, p.p_max_lat' : ''}
      FROM ${cte} r
      JOIN users o ON o.id = r.owner_id
      JOIN users u ON u.id = r.updated_by_id
      ${prev ? 'CROSS JOIN prev p' : ''}`);
  }

  private async explainOwnerMiss(id: string, actorId: string, wantDeleted: boolean): Promise<OwnerMutationOutcome> {
    const area = await this.findById(id, true);
    if (!area || (wantDeleted ? area.deletedAt === null : area.deletedAt !== null)) return { status: 'not_found' };
    if (area.ownerId !== actorId) return { status: 'forbidden' };
    return { status: 'conflict', current: area };
  }
}

function parseGeometry(value: PolygonGeometry | string): PolygonGeometry {
  return typeof value === 'string' ? (JSON.parse(value) as PolygonGeometry) : value;
}

function toAreaDto(r: AreaRow): AreaDto {
  return {
    id: r.id,
    ownerId: r.owner_id,
    ownerName: r.owner_name,
    name: r.name,
    description: r.description,
    areaSqKm: Number(r.area_sq_km),
    vertexCount: r.vertex_count,
    version: r.version,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
    updatedById: r.updated_by_id,
    updatedByName: r.updated_by_name,
    deletedAt: r.deleted_at ? r.deleted_at.toISOString() : null,
    geometry: parseGeometry(r.geometry),
    simplified: r.simplified ?? false,
  };
}
