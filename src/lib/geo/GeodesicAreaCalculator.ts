import * as geographiclib from 'geographiclib-geodesic';
import type { LngLat } from './types';

type GeographicLib = typeof geographiclib;
// UMD/CommonJS package: under Node's ESM loader its exports only exist on `default`;
// bundlers (Next, Vitest) expose them directly. Support both.
const { Geodesic } = (geographiclib as GeographicLib & { default?: GeographicLib }).default ?? geographiclib;

/**
 * Area/perimeter on the WGS84 ellipsoid using Karney's algorithm (GeographicLib),
 * the same algorithm PostGIS uses for `ST_Area(geography)`, so the live figure shown
 * while drawing matches the value the server persists.
 */
export class GeodesicAreaCalculator {
  private readonly geod = Geodesic.WGS84;

  /** Accepts open or closed rings; fewer than 3 distinct positions yields 0. */
  areaSqMeters(ring: readonly LngLat[]): number {
    const points = GeodesicAreaCalculator.open(ring);
    if (points.length < 3) return 0;
    const polygon = this.geod.Polygon(false);
    for (const [lng, lat] of points) polygon.AddPoint(lat, lng);
    const { area = 0 } = polygon.Compute(false, true);
    return Math.abs(area);
  }

  areaSqKm(ring: readonly LngLat[]): number {
    return this.areaSqMeters(ring) / 1_000_000;
  }

  /** Perimeter (closed) or length of the open path when `closed` is false. */
  lengthMeters(path: readonly LngLat[], closed = true): number {
    const points = GeodesicAreaCalculator.open(path);
    if (points.length < 2) return 0;
    const polygon = this.geod.Polygon(!closed);
    for (const [lng, lat] of points) polygon.AddPoint(lat, lng);
    return polygon.Compute(false, true).perimeter;
  }

  private static open(ring: readonly LngLat[]): readonly LngLat[] {
    const first = ring[0];
    const last = ring[ring.length - 1];
    if (ring.length > 1 && first && last && first[0] === last[0] && first[1] === last[1]) return ring.slice(0, -1);
    return ring;
  }
}

export const geodesicAreaCalculator = new GeodesicAreaCalculator();

/** Human-friendly area label: m² below 0.01 km², km² otherwise. */
export function formatArea(sqKm: number): string {
  if (sqKm < 0.01) return `${Math.round(sqKm * 1_000_000).toLocaleString('en-US')} m²`;
  if (sqKm < 100) return `${sqKm.toFixed(3)} km²`;
  return `${sqKm.toLocaleString('en-US', { maximumFractionDigits: 1 })} km²`;
}
