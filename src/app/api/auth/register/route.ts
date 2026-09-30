import { registerSchema } from '@/lib/api/schemas';
import { sessionResponse } from '@/server/auth/sessionResponse';
import { getServices } from '@/server/container';
import { apiRoute } from '@/server/http/apiHandler';
import { ApiError } from '@/server/http/errors';

export const dynamic = 'force-dynamic';

export const POST = apiRoute(async ({ body, meta }) => {
  const { auth, sessions, limiters, audit } = getServices();
  const limit = await limiters.register.consume(meta.ip ?? 'unknown');
  if (!limit.allowed) throw ApiError.rateLimited(limit.retryAfterMs);

  const input = await body(registerSchema);
  const user = await auth.register(input);
  const session = await sessions.create({ userId: user.id, email: user.email, displayName: user.displayName, ip: meta.ip });
  audit.record({ action: 'auth.register', userId: user.id, entityType: 'user', entityId: user.id, ...meta });
  return sessionResponse(user, session.id, 201);
});
