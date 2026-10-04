import L from 'leaflet';
import 'proj4leaflet';
import { ITM_EPSG, ITM_PROJ4 } from '@/lib/geo/CoordinateTransformer';
import { WEB_MERCATOR } from '@/lib/map/IMapEngine';

export type CrsId = 'EPSG:3857' | 'EPSG:2039';

export interface ItmGrid {
  origin: [number, number];
  resolutions: number[];
}

/**
 * The two projections the Leaflet engine can display:
 * - EPSG:3857 Web Mercator (OSM, Esri) — Leaflet built-in;
 * - EPSG:2039 Israeli TM Grid (govmap orthophoto) — via proj4leaflet with the
 *   tile grid (origin + per-zoom resolutions) of the tile service.
 *
 * Views are exchanged as "centre + metres per pixel" so that switching CRS keeps
 * the same ground area on screen even though zoom numbers mean different things.
 */
export class CrsRegistry {
  private readonly itm: L.Proj.CRS | null;

  constructor(private readonly itmGrid: ItmGrid | null) {
    this.itm = itmGrid
      ? new L.Proj.CRS(ITM_EPSG, ITM_PROJ4, { origin: itmGrid.origin, resolutions: itmGrid.resolutions })
      : null;
  }

  get(id: CrsId): L.CRS {
    if (id === 'EPSG:2039') {
      if (!this.itm) throw new Error('ITM tile grid is not configured');
      return this.itm;
    }
    return L.CRS.EPSG3857;
  }

  zoomRange(id: CrsId): { min: number; max: number } {
    return id === 'EPSG:2039' ? { min: 0, max: (this.itmGrid?.resolutions.length ?? 1) - 1 } : { min: 2, max: 19 };
  }

  /** Ground metres per screen pixel at `zoom` (and latitude, for Mercator). */
  resolutionAt(id: CrsId, zoom: number, lat: number): number {
    if (id === 'EPSG:3857') return WEB_MERCATOR.resolutionAt(zoom, lat);
    const res = this.itmGrid!.resolutions;
    const i = Math.max(0, Math.min(res.length - 1, Math.round(zoom)));
    return res[i]!;
  }

  /** Integer zoom whose resolution is closest (in log space) to `resolution`. */
  zoomFor(id: CrsId, resolution: number, lat: number): number {
    const { min, max } = this.zoomRange(id);
    if (id === 'EPSG:3857') return clamp(Math.round(WEB_MERCATOR.zoomFor(resolution, lat)), min, max);
    const res = this.itmGrid!.resolutions;
    let best = 0;
    for (let i = 1; i < res.length; i++) {
      if (Math.abs(Math.log(res[i]! / resolution)) < Math.abs(Math.log(res[best]! / resolution))) best = i;
    }
    return clamp(best, min, max);
  }
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}
