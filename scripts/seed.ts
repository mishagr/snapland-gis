/**
 * Seeds random polygons for demos and benchmarks.
 *   npm run db:seed -- --count 10000 [--region israel|telaviv]
 * Polygons are irregular quadrilaterals (≈100 m – 2 km across) owned by a
 * "Seed Bot" user; area and history rows are computed by PostGIS.
 */
import { existsSync } from 'node:fs';
import { parseArgs } from 'node:util';

if (existsSync('.env')) process.loadEnvFile('.env');

const { values } = parseArgs({ options: { count: { type: 'string', default: '10000' }, region: { type: 'string', default: 'israel' } } });
const count = Number(values.count);
const region = values.region === 'telaviv' ? { lng: 34.72, lat: 32.02, w: 0.15, h: 0.12 } : { lng: 34.3, lat: 29.6, w: 1.3, h: 3.6 };

const { getServices } = await import('@/server/container');
const s = getServices();

const bot = await s.prisma.user.upsert({
  where: { email: 'seed-bot@snapland.local' },
  update: {},
  create: { email: 'seed-bot@snapland.local', displayName: 'Seed Bot', passwordHash: 'disabled' },
});

const started = performance.now();
const batch = 2000;
for (let done = 0; done < count; done += batch) {
  const n = Math.min(batch, count - done);
  await s.prisma.$executeRaw`
    WITH params AS (
      SELECT ${region.lng}::float8 + random() * ${region.w}::float8 AS x,
             ${region.lat}::float8 + random() * ${region.h}::float8 AS y,
             0.001 + random() * 0.02 AS r
      FROM generate_series(1, ${n}::int)
    ), corners AS (
      SELECT ST_MakePoint(x - r * (0.6 + random() * 0.4), y - r * (0.6 + random() * 0.4)) AS p1,
             ST_MakePoint(x + r * (0.6 + random() * 0.4), y - r * (0.6 + random() * 0.4)) AS p2,
             ST_MakePoint(x + r * (0.6 + random() * 0.4), y + r * (0.6 + random() * 0.4)) AS p3,
             ST_MakePoint(x - r * (0.6 + random() * 0.4), y + r * (0.6 + random() * 0.4)) AS p4
      FROM params
    ), fixed AS (
      SELECT ST_SetSRID(ST_MakePolygon(ST_MakeLine(ARRAY[p1, p2, p3, p4, p1])), 4326) AS geom FROM corners
    ), ins AS (
      INSERT INTO areas (owner_id, name, geom, area_sq_km, vertex_count, updated_by_id)
      SELECT ${bot.id}::uuid, 'Seed parcel ' || substr(md5(random()::text), 1, 6), geom,
             ST_Area(geom::geography) / 1e6, ST_NPoints(geom) - 1, ${bot.id}::uuid
      FROM fixed WHERE ST_IsValid(geom)
      RETURNING *
    )
    INSERT INTO area_versions (area_id, version, action, name, description, geom, area_sq_km, edited_by_id)
    SELECT id, 1, 'CREATE', name, description, geom, area_sq_km, owner_id FROM ins`;
  process.stdout.write(`\rseeded ${Math.min(done + batch, count)}/${count}`);
}
await s.prisma.$executeRawUnsafe('ANALYZE areas');
await s.redis.incr('areas:gen');
console.log(`\ndone in ${((performance.now() - started) / 1000).toFixed(1)} s; live areas: ${await s.areaRepo.countLive()}`);
await s.prisma.$disconnect();
s.redis.disconnect();
