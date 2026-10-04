import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ApiError } from '@/server/http/errors';
import { toApiError } from '@/server/http/apiHandler';
import { AreaCache } from '@/server/areas/AreaCache';
import { BBoxUtil } from '@/lib/geo/BBoxUtil';

describe('toApiError', () => {
  it('recognises ApiErrors across module copies via the global symbol brand', () => {
    const foreign = Object.assign(new Error('x'), { [Symbol.for('snapland.ApiError')]: true, status: 409, code: 'CONFLICT' });
    expect(ApiError.is(foreign)).toBe(true);
    expect(toApiError(foreign)).toBe(foreign);
  });

  it('maps zod errors to 422 with field paths', () => {
    const r = z.object({ name: z.string().min(1, 'Name is required') }).safeParse({ name: '' });
    const e = toApiError(r.error);
    expect(e.status).toBe(422);
    expect(e.details).toEqual({ issues: [{ path: 'name', message: 'Name is required' }] });
  });

  it.each([
    [{ code: 'P2010', meta: { code: '23514' } }, 422, 'INVALID_GEOMETRY'],
    [{ cause: { originalCode: 'XX000' } }, 422, 'INVALID_GEOMETRY'],
    [{ meta: { code: '57014' } }, 503, 'TIMEOUT'],
    [new Error('boom'), 500, 'INTERNAL'],
  ])('maps database/unknown errors (%#)', (err, status, code) => {
    const e = toApiError(err);
    expect(e.status).toBe(status);
    expect(e.code).toBe(code);
  });

  it('rate-limit errors carry Retry-After', () => {
    expect(ApiError.rateLimited(1500).headers).toEqual({ 'Retry-After': '2' });
  });
});

describe('AreaCache grid', () => {
  it('snaps viewports outward to a size-proportional grid', () => {
    const view = { minLng: 34.7812, minLat: 32.0712, maxLng: 34.8456, maxLat: 32.1101 };
    const snapped = AreaCache.snap(view);
    expect(BBoxUtil.contains(snapped, view)).toBe(true);
    expect(AreaCache.gridStep(view)).toBe(0.02);
    // A slightly panned view shares the same key.
    expect(AreaCache.snap({ ...view, minLng: 34.782, maxLng: 34.846 })).toEqual(snapped);
  });
});
