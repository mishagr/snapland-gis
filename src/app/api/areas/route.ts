import { NextResponse } from 'next/server';
import { createAreaSchema } from '@/lib/api/schemas';
import { BBoxUtil } from '@/lib/geo/BBoxUtil';
import { getServices } from '@/server/container';
import { apiRoute, corsPreflight } from '@/server/http/apiHandler';
import { ApiError } from '@/server/http/errors';

export const dynamic = 'force-dynamic';

/** GET /api/areas?bbox=minLng,minLat,maxLng,maxLat[&res=metresPerPixel] */
export const GET = apiRoute(
  async ({ req }) => {
    const bbox = BBoxUtil.parse(req.nextUrl.searchParams.get('bbox'));
    if (!bbox) throw ApiError.badRequest('Query parameter bbox=minLng,minLat,maxLng,maxLat is required');
    const resParam = req.nextUrl.searchParams.get('res');
    const resolution = resParam === null ? undefined : Number(resParam);
    if (resolution !== undefined && (!Number.isFinite(resolution) || resolution <= 0 || resolution > 1e6)) {
      throw ApiError.badRequest('res must be a positive number of metres per pixel');
    }
    const { cache, ...result } = await getServices().areas.list(bbox, resolution);
    return NextResponse.json(result, { headers: { 'X-Cache': cache } });
  },
  { auth: true },
);

export const POST = apiRoute(
  async ({ body, requireSession, meta }) => {
    const s = requireSession();
    const input = await body(createAreaSchema);
    const area = await getServices().areas.create({ id: s.userId, displayName: s.displayName }, input, meta);
    return NextResponse.json({ area }, { status: 201 });
  },
  { auth: true },
);

export const OPTIONS = corsPreflight;
