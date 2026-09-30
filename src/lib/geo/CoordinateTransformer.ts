import proj4 from 'proj4';
import type { BBox, ItmExtent, ItmPoint, LngLat, Ring } from './types';

export const WGS84_EPSG = 'EPSG:4326';
export const ITM_EPSG = 'EPSG:2039';

/**
 * Israeli Transverse Mercator (Israel 1993 / Israeli TM Grid) with the 7-parameter
 * Helmert shift to WGS84 published by epsg.io. PostGIS ships a 3-parameter shift for
 * SRID 2039; the two agree to ~1 m. We never transform on the server (storage is
 * EPSG:4326), so the only requirement is that every client uses this one definition.
 */
export const ITM_PROJ4 =
  '+proj=tmerc +lat_0=31.7343936111111 +lon_0=35.2045169444444 +k=1.0000067 ' +
  '+x_0=219529.584 +y_0=626907.39 +ellps=GRS80 ' +
  '+towgs84=-24.0024,-17.1032,-17.8444,-0.33077,-1.85269,1.66969,5.4248 +units=m +no_defs';

proj4.defs(ITM_EPSG, ITM_PROJ4);

/** Converts between WGS84 (storage/API) and ITM (govmap, govmap orthophoto tiles). */
export class CoordinateTransformer {
  private readonly converter = proj4(ITM_EPSG, WGS84_EPSG);

  itmToWgs84(p: ItmPoint): LngLat {
    const [lng, lat] = this.converter.forward([p.x, p.y]) as [number, number];
    return [lng, lat];
  }

  wgs84ToItm([lng, lat]: LngLat): ItmPoint {
    const [x, y] = this.converter.inverse([lng, lat]) as [number, number];
    return { x, y };
  }

  ringItmToWgs84(ring: readonly ItmPoint[]): Ring {
    return ring.map((p) => this.itmToWgs84(p));
  }

  ringWgs84ToItm(ring: readonly LngLat[]): ItmPoint[] {
    return ring.map((p) => this.wgs84ToItm(p));
  }

  /**
   * An ITM rectangle is not a rectangle in WGS84 (grid convergence), so all four
   * corners are transformed and the envelope is returned; it always covers the view.
   */
  itmExtentToBBox(e: ItmExtent): BBox {
    const corners: LngLat[] = [
      this.itmToWgs84({ x: e.xmin, y: e.ymin }),
      this.itmToWgs84({ x: e.xmin, y: e.ymax }),
      this.itmToWgs84({ x: e.xmax, y: e.ymin }),
      this.itmToWgs84({ x: e.xmax, y: e.ymax }),
    ];
    return {
      minLng: Math.min(...corners.map((c) => c[0])),
      minLat: Math.min(...corners.map((c) => c[1])),
      maxLng: Math.max(...corners.map((c) => c[0])),
      maxLat: Math.max(...corners.map((c) => c[1])),
    };
  }

  bboxToItmExtent(b: BBox): ItmExtent {
    const corners = [
      this.wgs84ToItm([b.minLng, b.minLat]),
      this.wgs84ToItm([b.minLng, b.maxLat]),
      this.wgs84ToItm([b.maxLng, b.minLat]),
      this.wgs84ToItm([b.maxLng, b.maxLat]),
    ];
    return {
      xmin: Math.min(...corners.map((c) => c.x)),
      ymin: Math.min(...corners.map((c) => c.y)),
      xmax: Math.max(...corners.map((c) => c.x)),
      ymax: Math.max(...corners.map((c) => c.y)),
    };
  }
}

export const coordinateTransformer = new CoordinateTransformer();
