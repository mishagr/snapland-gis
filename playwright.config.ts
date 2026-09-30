import { defineConfig } from '@playwright/test';

/**
 * End-to-end tests drive the real app (custom server, Postgres/PostGIS, Redis)
 * in Chromium. By default Playwright starts the dev server with test-friendly
 * settings: govmap in mock mode (no token needed) and the dev ITM tile route.
 * Point E2E_BASE_URL at an already running server to skip that.
 */
const PORT = Number(process.env.E2E_PORT ?? 3210);
const baseURL = process.env.E2E_BASE_URL ?? `http://localhost:${PORT}`;

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 90_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL,
    viewport: { width: 1400, height: 860 },
    trace: 'retain-on-failure',
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {},
  },
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: 'npx tsx server.ts',
        url: `${baseURL}/api/health/ready`,
        timeout: 180_000,
        reuseExistingServer: false,
        env: {
          PORT: String(PORT),
          APP_ORIGIN: baseURL,
          GOVMAP_MODE: 'mock',
          ENABLE_DEV_TILES: 'true',
          GOVMAP_ORTHO_TILE_URL: '/api/dev/itm-tiles/{z}/{x}/{y}',
          LOG_LEVEL: 'warn',
          REDIS_KEY_PREFIX: 'snapland-e2e:',
          // Every test registers fresh users from 127.0.0.1.
          REGISTER_RATE_LIMIT: '1000',
        },
      },
});
