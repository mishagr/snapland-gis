import { existsSync } from 'node:fs';
import { defineConfig } from 'prisma/config';

// Prisma 7 no longer loads .env automatically.
if (existsSync('.env')) process.loadEnvFile('.env');

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: {
    // `prisma generate` (e.g. during `docker build`) does not need a live database.
    url: process.env.DATABASE_URL ?? 'postgresql://placeholder:placeholder@localhost:5432/placeholder',
  },
});
