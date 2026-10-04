/**
 * TypeScript view of the govmap.gov.il JavaScript API (`window.govmap`), covering
 * the functions this app uses. Written against the public docs
 * (https://api.govmap.gov.il/docs/javascript-functions/*): createMap, draw,
 * displayGeometries, clearGeometriesByName, clearDrawings, setBackground,
 * zoomToXY and onEvent. Asynchronous calls return jQuery Deferred objects.
 */

export interface GovmapPoint {
  x: number;
  y: number;
}

export interface GovmapExtent {
  xmin: number;
  ymin: number;
  xmax: number;
  ymax: number;
}

/** Subset of jQuery's Deferred/Promise used by the govmap API. */
export interface GovmapDeferred<T> {
  progress(callback: (value: T) => void): GovmapDeferred<T>;
  done(callback: (value: T) => void): GovmapDeferred<T>;
  fail(callback: (error: unknown) => void): GovmapDeferred<T>;
}

export interface GovmapCreateMapOptions {
  /** Token issued by govmap for the page's domain (required). */
  token: string;
  layers?: string[];
  visibleLayers?: string[];
  showXY?: boolean;
  identifyOnClick?: boolean;
  isEmbeddedToggle?: boolean;
  background?: number | string;
  layersMode?: number;
  zoomButtons?: boolean;
  center?: GovmapPoint;
  level?: number;
  onLoad?: () => void;
  onError?: (error: unknown) => void;
}

/** RGBA colour as govmap expects it: [r, g, b, alpha 0..1]. */
export type GovmapColor = [number, number, number, number];

export interface GovmapSymbol {
  outlineColor?: GovmapColor;
  outlineWidth?: number;
  fillColor?: GovmapColor;
  /** Point symbols (not used here). */
  url?: string;
  width?: number;
  height?: number;
}

export interface GovmapDisplayGeometriesOptions {
  wkts: string[];
  /** Names identify geometries for `clearGeometriesByName`. */
  names: string[];
  geometryType: string | number;
  defaultSymbol?: GovmapSymbol;
  symbols?: GovmapSymbol[];
  clearExisting?: boolean;
  data?: {
    tooltips?: string[];
    headers?: string[];
    bubbles?: string[];
    bubbleUrl?: string;
  };
}

export interface GovmapDrawResponse {
  /** Drawn geometry as WKT in ITM (EPSG:2039). */
  wkt: string;
  data?: unknown;
}

export interface GovmapClickEvent {
  mapPoint: GovmapPoint;
}

export interface GovmapExtentChangeEvent {
  extent: GovmapExtent;
  level?: number;
}

export interface GovmapApi {
  createMap(elementId: string, options: GovmapCreateMapOptions): unknown;
  draw(drawType: string | number): GovmapDeferred<GovmapDrawResponse>;
  clearDrawings(): void;
  setDefaultTool?(): void;
  displayGeometries(options: GovmapDisplayGeometriesOptions): GovmapDeferred<unknown>;
  clearGeometriesByName(names: string[]): void;
  setBackground(background: number | string): void;
  zoomToXY(options: GovmapPoint & { level: number; marker?: boolean }): void;
  onEvent(event: string | number): GovmapDeferred<unknown>;
  unbindEvent?(event: string | number): void;
  drawType: Record<'Point' | 'Polyline' | 'Polygon' | 'Circle' | 'Rectangle' | 'FreehandPolygon', string | number>;
  geometryType: Record<'POINT' | 'POLYLINE' | 'POLYGON', string | number> & Record<string, string | number>;
  events: Record<'CLICK' | 'EXTENT_CHANGE', string | number> & Record<string, string | number>;
}

declare global {
  interface Window {
    govmap?: GovmapApi;
    jQuery?: unknown;
  }
}
