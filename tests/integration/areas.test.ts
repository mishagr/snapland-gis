import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ApiError } from '@/server/http/errors';
import { toApiError } from '@/server/http/apiHandler';
import { GeodesicAreaCalculator } from '@/lib/geo/GeodesicAreaCalculator';
import type { PolygonGeometry } from '@/lib/geo/types';
import { bootServices, integrationEnabled, makeUser, resetData, shutdown, square } from './helpers';

type Services = Awaited<ReturnType<typeof bootServices>>;
const meta = { ip: '127.0.0.1', requestId: 'test-request' };

describe.skipIf(!integrationEnabled)('areas (PostGIS)', () => {
  let s: Services;
  let alice: { id: string; displayName: string };
  let bob: { id: string; displayName: string };

  beforeAll(async () => {
    s = await bootServices();
  });
  beforeEach(async () => {
    await resetData(s);
    alice = await makeUser(s, 'Alice');
    bob = await makeUser(s, 'Bob');
  });
  afterAll(async () => shutdown(s));

  it('computes geodesic area in PostGIS, matching the client calculation', async () => {
    const geometry = square(34.78, 32.08);
    const area = await s.areas.create(alice, { name: 'Field', description: '', geometry }, meta);
    const client = new GeodesicAreaCalculator().areaSqKm(geometry.coordinates[0]);
    expect(Math.abs(area.areaSqKm - client) / client).toBeLessThan(1e-9);
    expect(area.vertexCount).toBe(4);
    expect(area.version).toBe(1);
  });

  it('returns only live areas intersecting the bbox, with cache hit on repeat', async () => {
    const inside = await s.areas.create(alice, { name: 'In', description: '', geometry: square(34.78, 32.08) }, meta);
    await s.areas.create(alice, { name: 'Out', description: '', geometry: square(35.5, 33.0) }, meta);
    const bbox = { minLng: 34.7, minLat: 32.0, maxLng: 34.9, maxLat: 32.2 };
    const first = await s.areas.list(bbox);
    expect(first.areas.map((a) => a.id)).toEqual([inside.id]);
    expect(first.cache).toBe('miss');
    expect((await s.areas.list(bbox)).cache).toBe('hit');
    await s.areas.delete(alice, inside.id, undefined, meta); // write invalidates
    const after = await s.areas.list(bbox);
    expect(after.cache).toBe('miss');
    expect(after.areas).toHaveLength(0);
  });

  it('simplifies geometry for zoomed-out viewports only', async () => {
    const ring: [number, number][] = [];
    for (let i = 0; i < 400; i++) {
      const a = (i / 400) * 2 * Math.PI;
      const r = 0.05 * (1 + 0.002 * Math.sin(a * 50));
      ring.push([34.8 + r * Math.cos(a), 32.1 + r * Math.sin(a)]);
    }
    ring.push(ring[0]!);
    await s.areas.create(alice, { name: 'Circle', description: '', geometry: { type: 'Polygon', coordinates: [ring] } }, meta);
    const bbox = { minLng: 34.5, minLat: 31.8, maxLng: 35.1, maxLat: 32.4 };
    const full = await s.areas.list(bbox);
    const coarse = await s.areas.list(bbox, 150);
    expect(full.areas[0]!.geometry.coordinates[0].length).toBe(401);
    expect(coarse.areas[0]!.simplified).toBe(true);
    expect(coarse.areas[0]!.geometry.coordinates[0].length).toBeLessThan(100);
  });

  it('rejects a stale expectedVersion with 409 and the current state; history records both editors', async () => {
    const area = await s.areas.create(alice, { name: 'A', description: '', geometry: square(34.78, 32.08) }, meta);
    await s.areas.update(bob, area.id, { expectedVersion: 1, name: 'Bob was here' }, meta);
    const err = (await s.areas.update(alice, area.id, { expectedVersion: 1, name: 'Alice' }, meta).catch((e) => e)) as ApiError;
    expect(err.status).toBe(409);
    expect((err.details as { current: { version: number; name: string } }).current).toMatchObject({ version: 2, name: 'Bob was here' });
    const versions = await s.areas.versions(area.id);
    expect(versions.map((v) => [v.version, v.action, v.editedByName])).toEqual([
      [2, 'UPDATE', 'Bob'],
      [1, 'CREATE', 'Alice'],
    ]);
  });

  it('lets exactly one of many concurrent writers with the same version win', async () => {
    const area = await s.areas.create(alice, { name: 'Race', description: '', geometry: square(34.78, 32.08) }, meta);
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, (_, i) => s.areas.update(i % 2 ? alice : bob, area.id, { expectedVersion: 1, name: `writer ${i}` }, meta)),
    );
    const ok = results.filter((r) => r.status === 'fulfilled');
    const conflicts = results.filter((r) => r.status === 'rejected' && (r.reason as ApiError).status === 409);
    expect(ok).toHaveLength(1);
    expect(conflicts).toHaveLength(7);
    expect((await s.areas.get(area.id)).version).toBe(2);
  });

  it('recomputes area and reports the previous bbox on geometry updates', async () => {
    const area = await s.areas.create(alice, { name: 'Move', description: '', geometry: square(34.78, 32.08) }, meta);
    const outcome = await s.areaRepo.update(area.id, 1, { geometry: square(34.9, 32.2, 0.02) }, bob.id);
    expect(outcome.status).toBe('updated');
    if (outcome.status !== 'updated') return;
    expect(outcome.area.areaSqKm).toBeCloseTo(area.areaSqKm * 4, 1);
    expect(outcome.previousBBox).toEqual({ minLng: 34.78, minLat: 32.08, maxLng: 34.79, maxLat: 32.09 });
  });

  it('only the owner can delete or restore; deleted areas can be restored', async () => {
    const area = await s.areas.create(alice, { name: 'Mine', description: '', geometry: square(34.78, 32.08) }, meta);
    expect(((await s.areas.delete(bob, area.id, undefined, meta).catch((e) => e)) as ApiError).status).toBe(403);
    await s.areas.delete(alice, area.id, undefined, meta);
    expect(((await s.areas.get(area.id).catch((e) => e)) as ApiError).status).toBe(404);
    expect(((await s.areas.restore(bob, area.id, meta).catch((e) => e)) as ApiError).status).toBe(403);
    const restored = await s.areas.restore(alice, area.id, meta);
    expect(restored.deletedAt).toBeNull();
    expect((await s.areas.versions(area.id)).map((v) => v.action)).toEqual(['RESTORE', 'DELETE', 'CREATE']);
  });

  it('rejects invalid geometry in the service and, as a last line, in the database', async () => {
    const bowtie: PolygonGeometry = { type: 'Polygon', coordinates: [[[0, 0], [1, 1], [1, 0], [0, 1], [0, 0]]] };
    const err = (await s.areas.create(alice, { name: 'x', description: '', geometry: bowtie }, meta).catch((e) => e)) as ApiError;
    expect(err.code).toBe('INVALID_GEOMETRY');
    // Bypass the validator: the CHECK (ST_IsValid) constraint still refuses it.
    const dbErr = await s.areaRepo.create({ ownerId: alice.id, name: 'x', description: '', geometry: bowtie }).catch((e) => e);
    expect(toApiError(dbErr).code).toBe('INVALID_GEOMETRY');
  });

  it('enforces 50 drawing actions per minute per user', async () => {
    let limited: ApiError | null = null;
    for (let i = 0; i < 51 && !limited; i++) {
      try {
        await s.areas.create(bob, { name: `r${i}`, description: '', geometry: square(34 + i * 0.02, 31) }, meta);
      } catch (e) {
        limited = e as ApiError;
        expect(i).toBe(50);
      }
    }
    expect(limited?.status).toBe(429);
    // Other users are unaffected.
    await expect(s.areas.create(alice, { name: 'ok', description: '', geometry: square(34.5, 31.5) }, meta)).resolves.toBeTruthy();
  });

  it('writes an audit trail', async () => {
    const area = await s.areas.create(alice, { name: 'Audited', description: '', geometry: square(34.78, 32.08) }, meta);
    await s.areas.update(bob, area.id, { expectedVersion: 1, description: 'x' }, meta);
    await new Promise((r) => setTimeout(r, 100)); // audit writes are fire-and-forget
    const rows = await s.prisma.auditLog.findMany({ where: { entityId: area.id }, orderBy: { id: 'asc' } });
    expect(rows.map((r) => r.action)).toEqual(['area.create', 'area.update']);
    expect(rows[0]!.ip).toBe('127.0.0.1');
  });

  it('purges soft-deleted areas after the retention window', async () => {
    const old = await s.areas.create(alice, { name: 'Old', description: '', geometry: square(34.78, 32.08) }, meta);
    const recent = await s.areas.create(alice, { name: 'Recent', description: '', geometry: square(34.8, 32.1) }, meta);
    await s.areas.delete(alice, old.id, undefined, meta);
    await s.areas.delete(alice, recent.id, undefined, meta);
    await s.prisma.$executeRaw`UPDATE areas SET deleted_at = now() - interval '40 days' WHERE id = ${old.id}::uuid`;
    const purged = await s.retention.purge();
    expect(purged.areas).toBe(1);
    expect(await s.areaRepo.findById(old.id, true)).toBeNull();
    expect(await s.areaRepo.findById(recent.id, true)).not.toBeNull();
  });

  it('uses the partial GIST index for viewport queries', async () => {
    await s.prisma.$executeRaw`
      INSERT INTO areas (owner_id, name, geom, area_sq_km, vertex_count, updated_by_id)
      SELECT ${alice.id}::uuid, 'bulk ' || g, ST_MakeEnvelope(x, y, x + 0.001, y + 0.001, 4326), 0.01, 4, ${alice.id}::uuid
      FROM generate_series(1, 5000) g,
           LATERAL (SELECT 34.2 + random() * 1.5 AS x, 29.5 + random() * 3.5 AS y) p`;
    await s.prisma.$executeRawUnsafe('ANALYZE areas');
    const plan = await s.prisma.$queryRawUnsafe<{ 'QUERY PLAN': string }[]>(
      `EXPLAIN SELECT id FROM areas WHERE deleted_at IS NULL AND geom && ST_MakeEnvelope(34.78, 32.08, 34.8, 32.1, 4326)`,
    );
    expect(plan.map((r) => r['QUERY PLAN']).join('\n')).toContain('areas_geom_live_gist');
  });
});
