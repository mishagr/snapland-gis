import { getServices } from '@/server/container';
import { apiRoute } from '@/server/http/apiHandler';
import { parseAreaId } from '@/server/http/params';

export const dynamic = 'force-dynamic';

export const POST = apiRoute<{ id: string }>(
  async ({ params, requireSession, meta }) => {
    const s = requireSession();
    const area = await getServices().areas.restore({ id: s.userId, displayName: s.displayName }, parseAreaId(params.id), meta);
    return { area };
  },
  { auth: true },
);
