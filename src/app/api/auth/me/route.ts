import { apiRoute } from '@/server/http/apiHandler';

export const dynamic = 'force-dynamic';

export const GET = apiRoute(
  async ({ requireSession }) => {
    const s = requireSession();
    return { user: { id: s.userId, email: s.email, displayName: s.displayName } };
  },
  { auth: true },
);
