import type { NextConfig } from 'next';
import { buildSecurityHeaders } from './src/server/security/securityHeaders';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Server-only packages that must not be bundled into route handlers.
  serverExternalPackages: ['pino', 'pino-pretty', 'ioredis', 'pg', '@prisma/adapter-pg', 'ws'],
  async headers() {
    return [{ source: '/:path*', headers: buildSecurityHeaders() }];
  },
};

export default nextConfig;
