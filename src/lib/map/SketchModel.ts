import { GeodesicAreaCalculator } from '@/lib/geo/GeodesicAreaCalculator';
import { PolygonValidator } from '@/lib/geo/PolygonValidator';
import type { LngLat } from '@/lib/geo/types';
import type { SketchProgress } from './IMapEngine';

const area = new GeodesicAreaCalculator();

/**
 * Engine-independent state of a polygon being drawn: ordered vertices plus an
 * optional hover position. Stored in WGS84, so a sketch survives base-layer and
 * CRS switches untouched; each engine only re-projects it for display.
 */
export class SketchModel {
  private points: LngLat[] = [];
  private hover: LngLat | null = null;

  get vertices(): readonly LngLat[] {
    return this.points;
  }

  get length(): number {
    return this.points.length;
  }

  add(p: LngLat): boolean {
    const last = this.points[this.points.length - 1];
    if (last && last[0] === p[0] && last[1] === p[1]) return false;
    this.points.push([p[0], p[1]]);
    return true;
  }

  undo(): LngLat | undefined {
    return this.points.pop();
  }

  setHover(p: LngLat | null): void {
    this.hover = p;
  }

  clear(): void {
    this.points = [];
    this.hover = null;
  }

  /** Placed vertices, plus the hover point when previewing. */
  preview(includeHover = true): LngLat[] {
    return includeHover && this.hover ? [...this.points, this.hover] : [...this.points];
  }

  progress(includeHover = true): SketchProgress {
    const pts = this.preview(includeHover);
    return {
      points: pts,
      vertexCount: this.points.length,
      areaSqKm: pts.length >= 3 ? area.areaSqKm(pts) : 0,
      perimeterM: pts.length >= 2 ? area.lengthMeters(pts, pts.length >= 3) : 0,
    };
  }

  /** Closed ring when the placed vertices form a valid simple polygon, else a reason. */
  toRing(): { ok: true; ring: LngLat[] } | { ok: false; reason: string } {
    if (this.points.length < 3) return { ok: false, reason: 'Place at least 3 points' };
    const ring = [...this.points, this.points[0]!];
    if (PolygonValidator.hasSelfIntersection(ring)) return { ok: false, reason: 'Edges cross each other' };
    return { ok: true, ring };
  }
}
