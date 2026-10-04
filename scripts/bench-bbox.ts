/**
 * Benchmarks viewport queries (the hot read path) against the current database.
 *   npm run bench:bbox -- [--runs 100]
 * Measures the repository query directly (no cache) at three viewport sizes, then
 * the service path with the Redis cache for repeated nearby viewports.
 */
import { existsSync } from 'node:fs';
import { parseArgs } from 'node:util';

if (existsSync('.env')) process.loadEnvFile('.env');
process.env.LOG_LEVEL = 'silent';

const { values } = parseArgs({ options: { runs: { type: 'string', default: '100' } } });
const runs = Number(values.runs);
const { getServices } = await import('@/server/container');
const s = getServices();

const scenarios = [
  { name: 'street (1 km, 2 m/px)', span: 0.01, res: 2 },
  { name: 'city (10 km, 10 m/px)', span: 0.1, res: 10 },
  { name: 'region (60 km, 60 m/px)', span: 0.6, res: 60 },
  { name: 'country (400 km, 400 m/px)', span: 4, res: 400 },
];

function percentile(sorted: number[], p: number) {
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
}

console.log(`live areas: ${await s.areaRepo.countLive()}, runs per scenario: ${runs}\n`);
console.log('| viewport | p50 ms | p95 ms | max ms | avg rows | truncated |');
console.log('|---|---|---|---|---|---|');
for (const sc of scenarios) {
  const times: number[] = [];
  let rows = 0;
  let truncated = 0;
  for (let i = 0; i < runs; i++) {
    const lng = 34.3 + Math.random() * Math.max(0.01, 1.3 - sc.span);
    const lat = 29.6 + Math.random() * Math.max(0.01, 3.6 - sc.span);
    const tolerance = sc.res > 2 ? (sc.res * 0.5) / 111_320 : 0;
    const t0 = performance.now();
    const r = await s.areaRepo.findInBBox({ minLng: lng, minLat: lat, maxLng: lng + sc.span, maxLat: lat + sc.span * 0.8 }, s.env.MAX_AREAS_PER_QUERY, tolerance);
    times.push(performance.now() - t0);
    rows += r.areas.length;
    if (r.truncated) truncated++;
  }
  times.sort((a, b) => a - b);
  console.log(`| ${sc.name} | ${percentile(times, 50).toFixed(1)} | ${percentile(times, 95).toFixed(1)} | ${times.at(-1)!.toFixed(1)} | ${Math.round(rows / runs)} | ${truncated}/${runs} |`);
}

// Cached path: users panning around the same city.
let hits = 0;
const cached: number[] = [];
for (let i = 0; i < runs; i++) {
  const jitter = () => (Math.random() - 0.5) * 0.004;
  const t0 = performance.now();
  const r = await s.areas.list({ minLng: 34.75 + jitter(), minLat: 32.05 + jitter(), maxLng: 34.85 + jitter(), maxLat: 32.13 + jitter() }, 10);
  cached.push(performance.now() - t0);
  if (r.cache === 'hit') hits++;
}
cached.sort((a, b) => a - b);
console.log(`\nservice + Redis cache (panning within a city): p50 ${percentile(cached, 50).toFixed(1)} ms, p95 ${percentile(cached, 95).toFixed(1)} ms, hit rate ${Math.round((hits / runs) * 100)}%`);
await s.prisma.$disconnect();
s.redis.disconnect();
