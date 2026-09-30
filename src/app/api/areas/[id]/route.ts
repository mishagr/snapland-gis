import { deleteAreaSchema, updateAreaSchema } from '@/lib/api/schemas';
import { getServices } from '@/server/container';
import { apiRoute, corsPreflight } from '@/server/http/apiHandler';
import { parseAreaId } from '@/server/http/params';

export const dynamic = 'force-dynamic';

type Params = { id: string };

export const GET = apiRoute<Params>(async ({ params }) => ({ area: await getServices().areas.get(parseAreaId(params.id)) }), {
  auth: true,
});

export const PATCH = apiRoute<Params>(
  async ({ params, body, requireSession, meta }) => {
    const s = requireSession();
    const input = await body(updateAreaSchema);
    const area = await getServices().areas.update({ id: s.userId, displayName: s.displayName }, parseAreaId(params.id), input, meta);
    return { area };
  },
  { auth: true },
);

/** DELETE /api/areas/:id[?expectedVersion=n] — soft delete, owner only. */
export const DELETE = apiRoute<Params>(
  async ({ params, req, requireSession, meta }) => {
    const s = requireSession();
    const raw = req.nextUrl.searchParams.get('expectedVersion');
    const { expectedVersion } = deleteAreaSchema.parse({ expectedVersion: raw === null ? undefined : Number(raw) });
    const area = await getServices().areas.delete({ id: s.userId, displayName: s.displayName }, parseAreaId(params.id), expectedVersion, meta);
    return { area };
  },
  { auth: true },
);

export const OPTIONS = corsPreflight;
