import { cookies } from 'next/headers';
import type { UserDto } from '@/lib/api/types';
import { getServices } from '@/server/container';
import { SESSION_COOKIE } from './cookies';

/** Session user for server components (null when signed out or the store is unreachable). */
export async function getCurrentUser(): Promise<UserDto | null> {
  const sid = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!sid) return null;
  try {
    const session = await getServices().sessions.get(sid);
    return session ? { id: session.userId, email: session.email, displayName: session.displayName } : null;
  } catch {
    return null;
  }
}
