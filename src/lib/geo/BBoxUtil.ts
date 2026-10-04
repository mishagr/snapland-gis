import type { BBox, LngLat } from './types';

/** Pure helpers for WGS84 bounding boxes. */
export class BBoxUtil {
  /** Parses `minLng,minLat,maxLng,maxLat`; returns null when malformed or out of range. */
  static parse(value: string | null | undefined): BBox | null {
    if (!value) return null;
    const parts = value.split(',').map((p) => Number(p.trim()));
    if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null;
    const [minLng, minLat, maxLng, maxLat] = parts as [number, number, number, number];
    const bbox = { minLng, minLat, maxLng, maxLat };
    return BBoxUtil.isValid(bbox) ? bbox : null;
  }

  static isValid(b: BBox): boolean {
    return (
      b.minLng >= -180 && b.maxLng <= 180 && b.minLat >= -90 && b.maxLat <= 90 &&
      b.minLng < b.maxLng && b.minLat < b.maxLat
    );
  }

  static toString(b: BBox): string {
    return `${b.minLng},${b.minLat},${b.maxLng},${b.maxLat}`;
  }

  static fromPositions(positions: readonly LngLat[]): BBox {
    let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity;
    for (const [lng, lat] of positions) {
      if (lng < minLng) minLng = lng;
      if (lng > maxLng) maxLng = lng;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
    }
    return { minLng, minLat, maxLng, maxLat };
  }

  static intersects(a: BBox, b: BBox): boolean {
    return a.minLng <= b.maxLng && a.maxLng >= b.minLng && a.minLat <= b.maxLat && a.maxLat >= b.minLat;
  }

  static contains(outer: BBox, inner: BBox): boolean {
    return (
      outer.minLng <= inner.minLng && outer.maxLng >= inner.maxLng &&
      outer.minLat <= inner.minLat && outer.maxLat >= inner.maxLat
    );
  }

  /**
   * Snaps a bbox outward to a grid of `step` degrees. Nearby viewports then share
   * one cache key, trading a slightly larger result for a much better hit rate.
   */
  static quantizeOutward(b: BBox, step: number): BBox {
    const snap = (v: number, fn: (x: number) => number) => Number((fn(v / step) * step).toFixed(6));
    return {
      minLng: Math.max(-180, snap(b.minLng, Math.floor)),
      minLat: Math.max(-90, snap(b.minLat, Math.floor)),
      maxLng: Math.min(180, snap(b.maxLng, Math.ceil)),
      maxLat: Math.min(90, snap(b.maxLat, Math.ceil)),
    };
  }

  /** Expands the bbox by a fraction of its size on every side (pre-fetch margin). */
  static pad(b: BBox, ratio: number): BBox {
    const dx = (b.maxLng - b.minLng) * ratio;
    const dy = (b.maxLat - b.minLat) * ratio;
    return {
      minLng: Math.max(-180, b.minLng - dx),
      minLat: Math.max(-90, b.minLat - dy),
      maxLng: Math.min(180, b.maxLng + dx),
      maxLat: Math.min(90, b.maxLat + dy),
    };
  }
}
