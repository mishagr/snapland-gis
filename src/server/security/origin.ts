import { getServerEnv } from '@/server/config/env';

/** True when the Origin header is absent (same-origin navigation / non-browser) or allow-listed. */
export function isAllowedOrigin(origin: string | null | undefined): boolean {
  if (!origin) return true;
  return getServerEnv().allowedOrigins.includes(origin.replace(/\/$/, ''));
}

/**
 * CSRF defence for cookie-authenticated mutations: browsers always send Origin on
 * cross-site POST/PATCH/DELETE, so rejecting unknown origins blocks forged requests
 * (SameSite=Lax cookies are the second layer).
 */
export function isTrustedMutationOrigin(origin: string | null | undefined, secFetchSite: string | null | undefined): boolean {
  if (origin) return isAllowedOrigin(origin);
  return secFetchSite !== 'cross-site';
}

export function corsHeaders(origin: string | null | undefined): Record<string, string> {
  if (!origin || !isAllowedOrigin(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,X-Request-Id',
    'Access-Control-Expose-Headers': 'X-Request-Id,Retry-After',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
  };
}
