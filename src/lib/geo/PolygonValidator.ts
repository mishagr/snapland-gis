import { GeodesicAreaCalculator } from './GeodesicAreaCalculator';
import type { BBox, LngLat, PolygonGeometry, Ring } from './types';

export type PolygonIssueCode =
  | 'NOT_POLYGON'
  | 'HOLES_NOT_SUPPORTED'
  | 'INVALID_COORDINATE'
  | 'TOO_FEW_VERTICES'
  | 'TOO_MANY_VERTICES'
  | 'CROSSES_ANTIMERIDIAN'
  | 'SELF_INTERSECTION'
  | 'TOO_SMALL'
  | 'TOO_LARGE'
  | 'OUT_OF_BOUNDS';

export interface PolygonIssue {
  code: PolygonIssueCode;
  message: string;
}

export type PolygonValidationResult =
  | { ok: true; polygon: PolygonGeometry; vertexCount: number; areaSqKm: number }
  | { ok: false; issues: PolygonIssue[] };

export interface PolygonValidatorOptions {
  maxVertices: number;
  minAreaSqMeters: number;
  maxAreaSqKm: number;
  /** Optional region the whole polygon must fall inside. */
  bounds?: BBox;
  /** Decimal places kept (7 ≈ 1 cm). */
  precision: number;
}

const DEFAULTS: PolygonValidatorOptions = {
  maxVertices: 1000,
  minAreaSqMeters: 1,
  maxAreaSqKm: 50_000,
  precision: 7,
};

/**
 * Validates and normalises untrusted polygon input (API bodies, WS messages).
 *
 * Normalisation: rounds coordinates, drops consecutive duplicates, closes the ring
 * and orients it counter-clockwise (RFC 7946). Validation rejects anything PostGIS
 * would consider invalid for our use: bad numbers, <3 vertices, self-intersections,
 * degenerate or absurdly large areas. The database re-checks with ST_IsValid.
 */
export class PolygonValidator {
  private readonly opts: PolygonValidatorOptions;
  private readonly area = new GeodesicAreaCalculator();

  constructor(options: Partial<PolygonValidatorOptions> = {}) {
    this.opts = { ...DEFAULTS, ...options };
  }

  validate(input: unknown): PolygonValidationResult {
    const shape = this.readShape(input);
    if ('issue' in shape) return { ok: false, issues: [shape.issue] };

    const ring = this.normalise(shape.ring);
    const vertexCount = ring.length - 1;
    const issues: PolygonIssue[] = [];

    if (vertexCount < 3) {
      return { ok: false, issues: [{ code: 'TOO_FEW_VERTICES', message: 'A polygon needs at least 3 distinct vertices' }] };
    }
    if (vertexCount > this.opts.maxVertices) {
      issues.push({ code: 'TOO_MANY_VERTICES', message: `A polygon may have at most ${this.opts.maxVertices} vertices` });
      return { ok: false, issues };
    }
    const lngs = ring.map((p) => p[0]);
    if (Math.max(...lngs) - Math.min(...lngs) > 180) {
      issues.push({ code: 'CROSSES_ANTIMERIDIAN', message: 'Polygons spanning more than 180° of longitude are not supported' });
    }
    if (this.opts.bounds && !ring.every(([lng, lat]) => this.inside(lng, lat, this.opts.bounds!))) {
      issues.push({ code: 'OUT_OF_BOUNDS', message: 'Polygon is outside the supported region' });
    }
    if (PolygonValidator.hasSelfIntersection(ring)) {
      issues.push({ code: 'SELF_INTERSECTION', message: 'Polygon edges must not cross each other' });
    }

    const areaSqKm = this.area.areaSqKm(ring);
    if (areaSqKm * 1_000_000 < this.opts.minAreaSqMeters) {
      issues.push({ code: 'TOO_SMALL', message: `Polygon area must be at least ${this.opts.minAreaSqMeters} m²` });
    } else if (areaSqKm > this.opts.maxAreaSqKm) {
      issues.push({ code: 'TOO_LARGE', message: `Polygon area must not exceed ${this.opts.maxAreaSqKm} km²` });
    }

    if (issues.length > 0) return { ok: false, issues };
    return { ok: true, polygon: { type: 'Polygon', coordinates: [ring] }, vertexCount, areaSqKm };
  }

  private readShape(input: unknown): { ring: LngLat[] } | { issue: PolygonIssue } {
    const notPolygon = { issue: { code: 'NOT_POLYGON' as const, message: 'Geometry must be a GeoJSON Polygon' } };
    if (typeof input !== 'object' || input === null) return notPolygon;
    const { type, coordinates } = input as { type?: unknown; coordinates?: unknown };
    if (type !== 'Polygon' || !Array.isArray(coordinates) || coordinates.length === 0) return notPolygon;
    if (coordinates.length > 1) {
      return { issue: { code: 'HOLES_NOT_SUPPORTED', message: 'Polygons with holes are not supported' } };
    }
    const outer: unknown = coordinates[0];
    if (!Array.isArray(outer)) return notPolygon;
    // Cheap guard before per-point work: bound the payload we are willing to inspect.
    if (outer.length > this.opts.maxVertices + 2) {
      return { issue: { code: 'TOO_MANY_VERTICES', message: `A polygon may have at most ${this.opts.maxVertices} vertices` } };
    }
    const ring: LngLat[] = [];
    for (const pos of outer) {
      if (!Array.isArray(pos) || pos.length < 2) return { issue: this.badCoordinate() };
      const [lng, lat] = pos as unknown[];
      if (typeof lng !== 'number' || typeof lat !== 'number' || !Number.isFinite(lng) || !Number.isFinite(lat)) {
        return { issue: this.badCoordinate() };
      }
      if (lng < -180 || lng > 180 || lat < -90 || lat > 90) return { issue: this.badCoordinate() };
      ring.push([lng, lat]);
    }
    return { ring };
  }

  private badCoordinate(): PolygonIssue {
    return { code: 'INVALID_COORDINATE', message: 'Coordinates must be finite [lng, lat] pairs within WGS84 range' };
  }

  /** Round, drop consecutive duplicates, close, orient CCW. */
  private normalise(input: Ring): Ring {
    const factor = 10 ** this.opts.precision;
    const round = (v: number) => Math.round(v * factor) / factor;
    const ring: Ring = [];
    for (const [lng, lat] of input) {
      const p: LngLat = [round(lng), round(lat)];
      const prev = ring[ring.length - 1];
      if (!prev || prev[0] !== p[0] || prev[1] !== p[1]) ring.push(p);
    }
    // Remove the closing position (if any) so the ring is handled uniformly.
    while (ring.length > 1 && PolygonValidator.same(ring[0]!, ring[ring.length - 1]!)) ring.pop();
    if (PolygonValidator.signedArea(ring) < 0) ring.reverse();
    if (ring.length > 0) ring.push([ring[0]![0], ring[0]![1]]);
    return ring;
  }

  private inside(lng: number, lat: number, b: BBox): boolean {
    return lng >= b.minLng && lng <= b.maxLng && lat >= b.minLat && lat <= b.maxLat;
  }

  private static same(a: LngLat, b: LngLat): boolean {
    return a[0] === b[0] && a[1] === b[1];
  }

  /** Shoelace formula in degree space; only the sign (orientation) is used. */
  static signedArea(ring: readonly LngLat[]): number {
    let sum = 0;
    for (let i = 0; i < ring.length; i++) {
      const [x1, y1] = ring[i]!;
      const [x2, y2] = ring[(i + 1) % ring.length]!;
      sum += x1 * y2 - x2 * y1;
    }
    return sum / 2;
  }

  /**
   * O(n²) segment test on a closed ring (n ≤ 1000 → ≤ 500k pairs, a few ms).
   * Adjacent edges share a vertex and are skipped; everything else that touches,
   * crosses or overlaps counts as an intersection.
   */
  static hasSelfIntersection(closedRing: readonly LngLat[]): boolean {
    const n = closedRing.length - 1; // number of edges
    for (let i = 0; i < n; i++) {
      const a1 = closedRing[i]!;
      const a2 = closedRing[i + 1]!;
      for (let j = i + 1; j < n; j++) {
        const adjacent = j === i + 1 || (i === 0 && j === n - 1);
        if (adjacent) {
          // Adjacent edges share one vertex; they are only invalid when they fold back onto each other.
          const [prev, shared, next] = j === i + 1 ? [a1, a2, closedRing[j + 1]!] : [closedRing[n - 1]!, a1, a2];
          if (PolygonValidator.foldsBack(prev, shared, next)) return true;
          continue;
        }
        if (PolygonValidator.segmentsIntersect(a1, a2, closedRing[j]!, closedRing[j + 1]!)) return true;
      }
    }
    return false;
  }

  private static orientation(p: LngLat, q: LngLat, r: LngLat): number {
    const v = (q[1] - p[1]) * (r[0] - q[0]) - (q[0] - p[0]) * (r[1] - q[1]);
    if (Math.abs(v) < 1e-18) return 0;
    return v > 0 ? 1 : 2;
  }

  /** Collinear consecutive edges pointing back the way they came (a zero-width spike). */
  private static foldsBack(prev: LngLat, shared: LngLat, next: LngLat): boolean {
    if (PolygonValidator.orientation(prev, shared, next) !== 0) return false;
    const dot = (prev[0] - shared[0]) * (next[0] - shared[0]) + (prev[1] - shared[1]) * (next[1] - shared[1]);
    return dot > 0;
  }

  private static within(p: LngLat, q: LngLat, r: LngLat): boolean {
    return (
      r[0] <= Math.max(p[0], q[0]) && r[0] >= Math.min(p[0], q[0]) &&
      r[1] <= Math.max(p[1], q[1]) && r[1] >= Math.min(p[1], q[1])
    );
  }

  private static segmentsIntersect(p1: LngLat, q1: LngLat, p2: LngLat, q2: LngLat): boolean {
    const o1 = PolygonValidator.orientation(p1, q1, p2);
    const o2 = PolygonValidator.orientation(p1, q1, q2);
    const o3 = PolygonValidator.orientation(p2, q2, p1);
    const o4 = PolygonValidator.orientation(p2, q2, q1);
    if (o1 !== o2 && o3 !== o4) return true;
    if (o1 === 0 && PolygonValidator.within(p1, q1, p2)) return true;
    if (o2 === 0 && PolygonValidator.within(p1, q1, q2)) return true;
    if (o3 === 0 && PolygonValidator.within(p2, q2, p1)) return true;
    if (o4 === 0 && PolygonValidator.within(p2, q2, q1)) return true;
    return false;
  }
}

export const polygonValidator = new PolygonValidator();
