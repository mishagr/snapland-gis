/**
 * Security headers for every response. Scripts may only come from this origin and
 * the govmap API (which needs jQuery). Images may come from any HTTPS host because
 * tile sources are configurable at runtime (govmap orthophoto grid) and images
 * cannot execute code; everything else is locked to 'self'.
 */
export function buildSecurityHeaders(): { key: string; value: string }[] {
  const dev = process.env.NODE_ENV !== 'production';
  const govmap = 'https://*.govmap.gov.il https://govmap.gov.il';
  const csp = [
    "default-src 'self'",
    // Next.js needs inline bootstrap scripts; 'unsafe-eval' only in dev (React refresh).
    `script-src 'self' 'unsafe-inline' ${dev ? "'unsafe-eval'" : ''} ${govmap} https://code.jquery.com`,
    `style-src 'self' 'unsafe-inline' ${govmap}`,
    "img-src 'self' data: blob: https:",
    `font-src 'self' data: ${govmap}`,
    `connect-src 'self' ws: wss: ${govmap}`,
    `frame-src ${govmap}`,
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
  return [
    { key: 'Content-Security-Policy', value: csp.replace(/\s+/g, ' ') },
    { key: 'X-Content-Type-Options', value: 'nosniff' },
    { key: 'X-Frame-Options', value: 'DENY' },
    { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
    { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(self)' },
    ...(dev ? [] : [{ key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' }]),
  ];
}

