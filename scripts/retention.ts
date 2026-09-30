/** One-off retention purge (for cron / Kubernetes CronJob): npm run retention:purge */
import { existsSync } from 'node:fs';

if (existsSync('.env')) process.loadEnvFile('.env');
const { getServices } = await import('@/server/container');
const s = getServices();
const result = await s.retention.purge();
console.log(JSON.stringify(result));
await s.prisma.$disconnect();
s.redis.disconnect();
