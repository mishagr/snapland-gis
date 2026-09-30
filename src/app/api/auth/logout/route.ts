import { clearedSessionResponse } from '@/server/auth/sessionResponse';
import { getServices } from '@/server/container';
import { apiRoute } from '@/server/http/apiHandler';

export const dynamic = 'force-dynamic';

export const POST = apiRoute(async ({ session, meta }) => {
  if (session) {
    const { sessions, audit } = getServices();
    await sessions.destroy(session.id);
    audit.record({ action: 'auth.logout', userId: session.userId, entityType: 'session', entityId: session.id.slice(0, 8), ...meta });
  }
  return clearedSessionResponse();
});
