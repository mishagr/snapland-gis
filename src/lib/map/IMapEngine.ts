import type { BBox, LngLat, PolygonGeometry } from '@/lib/geo/types';

export type EngineKind = 'leaflet' | 'govmap';

/** Semantic base-layer category, so a switch of engine keeps "satellite" as satellite. */
export type BaseLayerCategory = 'street' | 'satellite';

export interface BaseLayerInfo {
  id: string;
  label: string;
  category: BaseLayerCategory;
  /** Projection the layer's tiles are in; switching between CRSs re-projects the map. */
  crs: 'EPSG:3857' | 'EPSG:2039';
  attribution?: string;
  /** Shown in the UI, e.g. that a layer's tile grid is unverified. */
  note?: string;
}

/** Engine-neutral view: centre + ground resolution (metres per pixel). */
export interface MapView {
  center: LngLat;
  resolution: number;
}

export interface RenderableArea {
  id: string;
  name: string;
  geometry: PolygonGeometry;
  color: string;
  label: string;
  selected: boolean;
  /** Another user is editing this area (advisory, drawn dashed). */
  lockedBy: string | null;
}

export interface RenderableSketch {
  userId: string;
  displayName: string;
  color: string;
  points: LngLat[];
  areaSqKm: number;
}

export interface SketchProgress {
  /** Placed vertices, plus the cursor position while previewing. */
  points: LngLat[];
  /** Placed vertices only. */
  vertexCount: number;
  areaSqKm: number;
  perimeterM: number;
}

export type MapEngineEvents = {
  viewportChange: (v: { bbox: BBox; view: MapView }) => void;
  areaClick: (areaId: string) => void;
  /** Own drawing in progress (vertices placed so far, live geodesic area). */
  sketchChange: (s: SketchProgress) => void;
  drawComplete: (ring: LngLat[]) => void;
  drawCancel: () => void;
  /** Shape editing produced a new candidate ring. */
  editChange: (s: SketchProgress & { ring: LngLat[]; valid: boolean }) => void;
  baseLayerChange: (id: string) => void;
  error: (err: Error) => void;
};

export interface EngineCapabilities {
  /** Vertices of an existing polygon can be dragged (otherwise editing = redraw). */
  vertexEditing: boolean;
  /** Vertex-by-vertex progress is reported while drawing. */
  liveSketch: boolean;
}

/**
 * Everything the workspace needs from a map implementation. Implementations own
 * their coordinate conversions; this interface speaks WGS84 only.
 */
export interface IMapEngine {
  readonly kind: EngineKind;
  readonly capabilities: EngineCapabilities;
  mount(container: HTMLElement, initial: { view: MapView; baseLayer: BaseLayerCategory }): Promise<void>;
  destroy(): void;
  getView(): MapView;
  setView(view: MapView): void;
  fitBounds(bbox: BBox): void;
  listBaseLayers(): BaseLayerInfo[];
  getBaseLayer(): string;
  setBaseLayer(id: string): Promise<void>;
  renderAreas(areas: RenderableArea[]): void;
  renderSketches(sketches: RenderableSketch[]): void;
  startDrawing(): void;
  /** Completes the current drawing (toolbar button / touch devices). */
  finishDrawing(): void;
  undoLastVertex(): void;
  cancelDrawing(): void;
  isDrawing(): boolean;
  startEditing(area: RenderableArea): void;
  /** Ends shape editing; returns the edited ring, or null when nothing changed / cancelled. */
  stopEditing(save: boolean): LngLat[] | null;
  on<K extends keyof MapEngineEvents>(event: K, handler: MapEngineEvents[K]): () => void;
}

/** Ground resolution ↔ Web-Mercator zoom at a latitude (256 px tiles). */
export const WEB_MERCATOR = {
  initialResolution: 156_543.033_928_041,
  resolutionAt(zoom: number, lat: number): number {
    return (this.initialResolution * Math.cos((lat * Math.PI) / 180)) / 2 ** zoom;
  },
  zoomFor(resolution: number, lat: number): number {
    return Math.log2((this.initialResolution * Math.cos((lat * Math.PI) / 180)) / resolution);
  },
};
