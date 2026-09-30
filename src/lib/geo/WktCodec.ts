import type { ItmPoint } from './types';

export class WktParseError extends Error {}

/**
 * Minimal WKT codec for the geometry govmap exchanges: POLYGON (outer ring used)
 * and POINT. Coordinates are planar (x y) in whatever CRS the caller uses.
 */
export class WktCodec {
  /** Parses `POLYGON((x y, ...), (hole...))` and returns the outer ring. Z/M values are ignored. */
  static parsePolygonOuterRing(wkt: string): ItmPoint[] {
    const match = /^\s*POLYGON\s*(?:Z|M|ZM)?\s*\(\s*\((.*?)\)/i.exec(wkt);
    if (!match?.[1]) throw new WktParseError('Expected a POLYGON WKT');
    return WktCodec.parsePositions(match[1]);
  }

  static parsePoint(wkt: string): ItmPoint {
    const match = /^\s*POINT\s*(?:Z|M|ZM)?\s*\(([^)]*)\)\s*$/i.exec(wkt);
    if (!match?.[1]) throw new WktParseError('Expected a POINT WKT');
    const [p] = WktCodec.parsePositions(match[1]);
    if (!p) throw new WktParseError('Empty POINT');
    return p;
  }

  static formatPolygon(ring: readonly ItmPoint[], digits = 2): string {
    const closed = WktCodec.close(ring);
    return `POLYGON((${closed.map((p) => `${p.x.toFixed(digits)} ${p.y.toFixed(digits)}`).join(', ')}))`;
  }

  static formatPoint(p: ItmPoint, digits = 2): string {
    return `POINT(${p.x.toFixed(digits)} ${p.y.toFixed(digits)})`;
  }

  static formatLineString(points: readonly ItmPoint[], digits = 2): string {
    return `LINESTRING(${points.map((p) => `${p.x.toFixed(digits)} ${p.y.toFixed(digits)}`).join(', ')})`;
  }

  private static parsePositions(body: string): ItmPoint[] {
    return body.split(',').map((pair) => {
      const nums = pair.trim().split(/\s+/).map(Number);
      const [x, y] = nums;
      if (nums.length < 2 || x === undefined || y === undefined || !Number.isFinite(x) || !Number.isFinite(y)) {
        throw new WktParseError(`Invalid WKT position "${pair.trim()}"`);
      }
      return { x, y };
    });
  }

  private static close(ring: readonly ItmPoint[]): ItmPoint[] {
    const first = ring[0];
    const last = ring[ring.length - 1];
    if (!first || !last) return [...ring];
    return first.x === last.x && first.y === last.y ? [...ring] : [...ring, first];
  }
}
