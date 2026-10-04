/**
 * Custom Node server: Next.js (pages, API routes) and the collaboration
 * WebSocket endpoint (`/ws`) share one HTTP server, one port and one process, so
 * REST writes reach WebSocket subscribers through an in-process event bus.
 */
import { existsSync } from 'node:fs';
import { createServer, type IncomingMessage } from 'node:http';

if (existsSync('.env')) process.loadEnvFile('.env');

const { default: next } = await import('next');
const { getServerEnv } = await import('@/server/config/env');
const { getServices } = await import('@/server/container');
const { disconnectPrisma } = await import('@/server/db/prisma');
const { disconnectRedis } = await import('@/server/db/redis');
const { CLIENT_IP_HEADER } = await import('@/server/http/constants');
const { RealtimeGateway } = await import('@/server/realtime/RealtimeGateway');
const { registerRealtimeStats } = await import('@/server/realtime/stats');

const env = getServerEnv();
const dev = env.NODE_ENV !== 'production';
const app = next({ dev, hostname: env.HOST, port: env.PORT });
const handle = app.getRequestHandler();

await app.prepare();

const services = getServices();
const { logger } = services;

function clientIp(req: IncomingMessage): string | undefined {
  if (env.TRUST_PROXY) {
    const forwarded = req.headers['x-forwarded-for'];
    const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0]?.trim();
    if (first) return first;
  }
  return req.socket.remoteAddress ?? undefined;
}

const gateway = new RealtimeGateway({
  sessions: services.sessions,
  bus: services.bus,
  audit: services.audit,
  logger,
  maxConnectionsPerUser: env.WS_MAX_CONNECTIONS_PER_USER,
  clientIp,
});
registerRealtimeStats(() => gateway.getStats());

const server = createServer((req, res) => {
  // Never trust a client-supplied value for the header route handlers read the IP from.
  req.headers[CLIENT_IP_HEADER] = clientIp(req) ?? '';
  void handle(req, res);
});

// Slowloris / stuck-request protection at the socket level (API handlers have their own timeout).
server.headersTimeout = 20_000;
server.requestTimeout = 30_000;
server.keepAliveTimeout = 65_000;

// `/ws` is ours; every other upgrade (e.g. Next's HMR socket in dev) is left for Next,
// which attaches its own `upgrade` listener and ignores paths it does not route.
server.on('upgrade', (req, socket, head) => {
  gateway.handleUpgrade(req, socket, head);
});

server.listen(env.PORT, env.HOST, () => {
  logger.info({ port: env.PORT, host: env.HOST, dev, origin: env.APP_ORIGIN }, 'snapland-gis ready');
});

services.retention.start(env.RETENTION_INTERVAL_MINUTES);

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'shutting down');
  const force = setTimeout(() => process.exit(1), 10_000);
  force.unref();
  services.retention.stop();
  await gateway.close();
  const closed = new Promise<void>((resolve) => server.close(() => resolve()));
  server.closeIdleConnections();
  await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 5_000))]);
  server.closeAllConnections();
  await Promise.allSettled([disconnectPrisma(), disconnectRedis()]);
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => logger.error({ err: reason }, 'unhandled rejection'));
