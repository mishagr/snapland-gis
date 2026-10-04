import { getServices } from '@/server/container';
import { apiRoute } from '@/server/http/apiHandler';
import { parseAreaId } from '@/server/http/params';

export const dynamic = 'force-dynamic';

export const GET = apiRoute<{ id: string }>(
  async ({ params }) => ({ versions: await getServices().areas.versions(parseAreaId(params.id)) }),
  { auth: true },
);
