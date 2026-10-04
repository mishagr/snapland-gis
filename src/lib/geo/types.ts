/** Longitude/latitude pair in WGS84 degrees (GeoJSON axis order). */
export type LngLat = [lng: number, lat: number];

/** A linear ring; closed rings repeat the first position at the end. */
export type Ring = LngLat[];

/** GeoJSON Polygon restricted to a single outer ring (drawing tools never produce holes). */
export interface PolygonGeometry {
  type: 'Polygon';
  coordinates: [Ring];
}

/** Axis-aligned bounding box in WGS84 degrees. */
export interface BBox {
  minLng: number;
  minLat: number;
  maxLng: number;
  maxLat: number;
}

/** Point in the Israeli Transverse Mercator grid (EPSG:2039), metres. */
export interface ItmPoint {
  x: number;
  y: number;
}

/** Extent in ITM metres, as reported by govmap. */
export interface ItmExtent {
  xmin: number;
  ymin: number;
  xmax: number;
  ymax: number;
}
