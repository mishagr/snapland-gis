import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import { BBoxUtil } from '@/lib/geo/BBoxUtil';
import type { BBox } from '@/lib/geo/types';

export type CacheStatus = 'hit' | 'miss' | 'bypass';

/**
 * Read-through cache for viewport queries.
 *
 * - The requested bbox is snapped outward to a grid whose step scales with the
 *   viewport size, so users panning around the same region share cache entries;
 *   the query itself runs on the snapped bbox, so a hit always covers the viewport.
 * - Invalidation is O(1): every write bumps a generation counter that is part of
 *   every key; stale generations simply expire via TTL.
 * - Redis failures degrade to a direct database read (status `bypass`).
 */
export class AreaCache {
  constructor(
    private readonly redis: Redis,
    private readonly ttlSeconds: number,
    private readonly logger: Logger,
  ) {}

  /** Grid step (degrees) ≈ ¼ of the viewport span, rounded to 1/2/5 × 10ⁿ. */
  static gridStep(bbox: BBox): number {
    const span = Math.max(bbox.maxLng - bbox.minLng, bbox.maxLat - bbox.minLat) / 4;
    const pow = 10 ** Math.floor(Math.log10(Math.max(span, 1e-4)));
    const m = span / pow;
    const nice = m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10;
    return nice * pow;
  }

  static snap(bbox: BBox): BBox {
    return BBoxUtil.quantizeOutward(bbox, AreaCache.gridStep(bbox));
  }

  async getOrLoad<T>(
    bbox: BBox,
    variant: string,
    loader: (snapped: BBox) => Promise<T>,
  ): Promise<{ value: T; status: CacheStatus; bbox: BBox }> {
    const snapped = AreaCache.snap(bbox);
    if (this.ttlSeconds === 0) return { value: await loader(snapped), status: 'bypass', bbox: snapped };

    let key: string | undefined;
    try {
      const generation = (await this.redis.get('areas:gen')) ?? '0';
      key = `areas:q:${generation}:${variant}:${BBoxUtil.toString(snapped)}`;
      const cached = await this.redis.get(key);
      if (cached) return { value: JSON.parse(cached) as T, status: 'hit', bbox: snapped };
    } catch (err) {
      this.logger.warn({ err }, 'area cache read failed; bypassing');
      return { value: await loader(snapped), status: 'bypass', bbox: snapped };
    }

    const value = await loader(snapped);
    this.redis.set(key, JSON.stringify(value), 'EX', this.ttlSeconds).catch((err: unknown) => {
      this.logger.warn({ err }, 'area cache write failed');
    });
    return { value, status: 'miss', bbox: snapped };
  }

  async invalidate(): Promise<void> {
    try {
      await this.redis.incr('areas:gen');
    } catch (err) {
      // Entries expire within ttlSeconds anyway; stale reads are bounded by the TTL.
      this.logger.warn({ err }, 'area cache invalidation failed');
    }
  }
}
