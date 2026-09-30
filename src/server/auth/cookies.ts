import { getServerEnv } from '@/server/config/env';

export const SESSION_COOKIE = 'snapland_sid';

export interface CookieOptions {
  httpOnly: boolean;
  secure: boolean;
  sameSite: 'lax';
  path: string;
  maxAge: number;
}

export function sessionCookieOptions(): CookieOptions {
  const env = getServerEnv();
  return { httpOnly: true, secure: env.cookieSecure, sameSite: 'lax', path: '/', maxAge: env.SESSION_TTL_SECONDS };
}

/** Parses a raw Cookie header (used by the WebSocket upgrade, which bypasses Next). */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return undefined;
}
