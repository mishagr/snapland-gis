import { NextResponse } from 'next/server';
import type { UserDto } from '@/lib/api/types';
import { SESSION_COOKIE, sessionCookieOptions } from './cookies';

/** JSON response carrying the user and the session cookie. */
export function sessionResponse(user: UserDto, sessionId: string, status = 200): NextResponse {
  const res = NextResponse.json({ user }, { status });
  res.cookies.set(SESSION_COOKIE, sessionId, sessionCookieOptions());
  return res;
}

export function clearedSessionResponse(): NextResponse {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, '', { ...sessionCookieOptions(), maxAge: 0 });
  return res;
}
