import { loginSchema } from '@/lib/api/schemas';
import { sessionResponse } from '@/server/auth/sessionResponse';
import { getServices } from '@/server/container';
import { apiRoute } from '@/server/http/apiHandler';
import { ApiError } from '@/server/http/errors';

export const dynamic = 'force-dynamic';

export const POST = apiRoute(async ({ body, meta }) => {
  const { auth, sessions, limiters, audit } = getServices();
  const input = await body(loginSchema);

  // Keyed by IP + account: slows credential stuffing without letting one
  // attacker lock a victim out from every network.
  const limit = await limiters.login.consume(`${meta.ip ?? 'unknown'}:${input.email}`);
  if (!limit.allowed) throw ApiError.rateLimited(limit.retryAfterMs);

  const user = await auth.verifyCredentials(input);
  if (!user) {
    audit.record({ action: 'auth.login_failed', entityType: 'user', metadata: { email: input.email }, ...meta });
    throw ApiError.unauthorized('Invalid email or password');
  }
  const session = await sessions.create({ userId: user.id, email: user.email, displayName: user.displayName, ip: meta.ip });
  audit.record({ action: 'auth.login', userId: user.id, entityType: 'session', entityId: session.id.slice(0, 8), ...meta });
  return sessionResponse(user, session.id);
});
