import type { PublicConfig } from '@/lib/config/publicConfig';
import { CoordinateTransformer } from '@/lib/geo/CoordinateTransformer';
import { formatArea, GeodesicAreaCalculator } from '@/lib/geo/GeodesicAreaCalculator';
import { PolygonValidator } from '@/lib/geo/PolygonValidator';
import type { BBox, ItmExtent, LngLat } from '@/lib/geo/types';
import { WktCodec } from '@/lib/geo/WktCodec';
import type {
  BaseLayerCategory,
  BaseLayerInfo,
  EngineCapabilities,
  IMapEngine,
  MapEngineEvents,
  MapView,
  RenderableArea,
  RenderableSketch,
} from '@/lib/map/IMapEngine';
import { SketchModel } from '@/lib/map/SketchModel';
import { Emitter } from '@/lib/util/Emitter';
import { GOVMAP_BACKGROUNDS, GOVMAP_LEVEL_RESOLUTIONS } from './constants';
import { GovmapClient } from './GovmapClient';
import { GovmapLoader } from './GovmapLoader';
import { MockGovmap } from './MockGovmap';
import type { GovmapApi, GovmapColor, GovmapSymbol } from './types';

const BASE_LAYERS: (BaseLayerInfo & { background: number })[] = [
  { id: 'govmap-street', label: 'Street (govmap)', category: 'street', crs: 'EPSG:2039', background: GOVMAP_BACKGROUNDS.street },
  {
    id: 'govmap-orthophoto',
    label: 'Aerial photo (govmap תצ"א)',
    category: 'satellite',
    crs: 'EPSG:2039',
    background: GOVMAP_BACKGROUNDS.orthophoto,
  },
];

interface RenderedArea {
  geometry: RenderableArea['geometry'];
  styleKey: string;
}

const area = new GeodesicAreaCalculator();

/**
 * govmap.gov.il implementation. govmap works in ITM (EPSG:2039); this engine
 * converts at its boundary so the rest of the app only sees WGS84.
 *
 * - Drawing uses `govmap.draw(Polygon)`; the returned WKT is converted to WGS84.
 *   CLICK events during the draw feed a SketchModel for the live area and the
 *   real-time sketch stream (degrades gracefully if govmap swallows clicks while
 *   drawing: the area then appears when the shape is completed).
 * - Shapes are rendered with `displayGeometries`, named `area-<id>` so they can be
 *   removed/replaced individually with `clearGeometriesByName`.
 * - Clicks are hit-tested against our own polygons (point-in-polygon), which does
 *   not depend on govmap's identify/bubble machinery.
 * - Both backgrounds share the ITM grid, so switching them never moves a shape.
 */
export class GovmapEngine extends Emitter<MapEngineEvents> implements IMapEngine {
  readonly kind = 'govmap' as const;
  readonly capabilities: EngineCapabilities = { vertexEditing: false, liveSketch: true };

  private client!: GovmapClient;
  private readonly transformer = new CoordinateTransformer();
  private readonly sketch = new SketchModel();
  private container!: HTMLElement;
  private extent: ItmExtent | null = null;
  private baseLayerId = BASE_LAYERS[0]!.id;
  private drawing = false;
  private editing: { area: RenderableArea; result: LngLat[] | null } | null = null;
  private readonly rendered = new Map<string, RenderedArea>();
  private lastAreas: RenderableArea[] = [];
  private sketchNames: string[] = [];
  private lastSketches: RenderableSketch[] = [];
  private unsubscribers: (() => void)[] = [];

  constructor(
    private readonly config: PublicConfig,
    /** Injected in tests; otherwise resolved from config (live script or mock). */
    private readonly apiOverride?: GovmapApi,
  ) {
    super();
  }

  async mount(container: HTMLElement, initial: { view: MapView; baseLayer: BaseLayerCategory }): Promise<void> {
    this.container = container;
    container.id ||= `govmap-${Math.random().toString(36).slice(2)}`;
    const api = this.apiOverride ?? (await this.loadApi());
    this.client = new GovmapClient(api);
    const layer = BASE_LAYERS.find((l) => l.category === initial.baseLayer) ?? BASE_LAYERS[0]!;
    this.baseLayerId = layer.id;

    this.unsubscribers.push(
      this.client.onExtentChange((e) => {
        this.extent = e.extent;
        this.emitViewport();
      }),
      this.client.onClick((e) => this.handleClick(this.transformer.itmToWgs84(e.mapPoint))),
    );
    await this.client.createMap(container.id, {
      token: this.config.govmap.token || 'mock',
      layers: [],
      showXY: false,
      identifyOnClick: false,
      isEmbeddedToggle: false,
      layersMode: 1,
      zoomButtons: true,
      background: layer.background,
      center: this.transformer.wgs84ToItm(initial.view.center),
      level: GovmapEngine.levelFor(initial.view.resolution),
    });
  }

  private destroyed = false;

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.drawing) this.client?.cancelDraw();
    for (const off of this.unsubscribers) off();
    this.unsubscribers = [];
    if (this.container) this.container.innerHTML = '';
    this.removeAllListeners();
  }

  getView(): MapView {
    if (!this.extent) return { center: this.config.defaultCenter, resolution: this.config.defaultResolution };
    const e = this.extent;
    const center = this.transformer.itmToWgs84({ x: (e.xmin + e.xmax) / 2, y: (e.ymin + e.ymax) / 2 });
    const width = this.container.clientWidth || 800;
    return { center, resolution: (e.xmax - e.xmin) / width };
  }

  setView(view: MapView): void {
    this.client.zoomTo(this.transformer.wgs84ToItm(view.center), GovmapEngine.levelFor(view.resolution));
  }

  fitBounds(bbox: BBox): void {
    const e = this.transformer.bboxToItmExtent(bbox);
    const width = this.container.clientWidth || 800;
    const height = this.container.clientHeight || 600;
    const resolution = Math.max((e.xmax - e.xmin) / width, (e.ymax - e.ymin) / height) * 1.2;
    const center = this.transformer.itmToWgs84({ x: (e.xmin + e.xmax) / 2, y: (e.ymin + e.ymax) / 2 });
    this.setView({ center, resolution });
  }

  listBaseLayers(): BaseLayerInfo[] {
    return BASE_LAYERS.map(({ background: _b, ...info }) => info);
  }

  getBaseLayer(): string {
    return this.baseLayerId;
  }

  async setBaseLayer(id: string): Promise<void> {
    const layer = BASE_LAYERS.find((l) => l.id === id);
    if (!layer) throw new Error(`Unknown base layer ${id}`);
    this.client.setBackground(layer.background);
    this.baseLayerId = id;
    // Graphics live in the map's own ITM space and stay put, but re-display them in
    // case a background switch resets the graphics layer in some govmap versions.
    this.rendered.clear();
    this.renderAreas(this.lastAreas);
    this.renderSketches(this.lastSketches);
    this.emit('baseLayerChange', id);
  }

  renderAreas(areas: RenderableArea[]): void {
    this.lastAreas = areas;
    const visible = areas.filter((a) => a.id !== this.editing?.area.id);
    const next = new Map(visible.map((a) => [a.id, a]));
    const changed: RenderableArea[] = [];
    const removed: string[] = [];
    for (const [id, r] of this.rendered) {
      const a = next.get(id);
      if (!a) removed.push(id);
      else if (a.geometry !== r.geometry || styleKey(a) !== r.styleKey) {
        removed.push(id);
        changed.push(a);
      }
    }
    for (const a of visible) if (!this.rendered.has(a.id)) changed.push(a);

    this.client.clearGeometriesByName(removed.map(areaName));
    for (const id of removed) this.rendered.delete(id);
    if (changed.length === 0) return;
    for (const a of changed) this.rendered.set(a.id, { geometry: a.geometry, styleKey: styleKey(a) });
    void this.client
      .displayGeometries({
        wkts: changed.map((a) => WktCodec.formatPolygon(this.transformer.ringWgs84ToItm(a.geometry.coordinates[0]))),
        names: changed.map((a) => areaName(a.id)),
        geometryType: this.client.polygonType,
        clearExisting: false,
        defaultSymbol: symbolFor('#2563eb', false, false),
        symbols: changed.map((a) => symbolFor(a.color, a.selected, a.lockedBy !== null)),
        data: { tooltips: changed.map((a) => escapeText(a.label)) },
      })
      .catch((err: unknown) => this.emit('error', err instanceof Error ? err : new Error('govmap render failed')));
  }

  renderSketches(sketches: RenderableSketch[]): void {
    this.lastSketches = sketches;
    this.client.clearGeometriesByName(this.sketchNames);
    const drawable = sketches.filter((s) => s.points.length >= 2);
    this.sketchNames = drawable.map((s) => `sketch-${s.userId}`);
    if (drawable.length === 0) return;
    void this.client.displayGeometries({
      wkts: drawable.map((s) => WktCodec.formatLineString(this.transformer.ringWgs84ToItm([...s.points, ...(s.points.length >= 3 ? [s.points[0]!] : [])]))),
      names: this.sketchNames,
      geometryType: this.client.polylineType,
      clearExisting: false,
      symbols: drawable.map((s) => ({ outlineColor: hexToColor(s.color, 1), outlineWidth: 2 })),
      data: {
        tooltips: drawable.map((s) => escapeText(`${s.displayName} is drawing${s.areaSqKm > 0 ? ` · ${formatArea(s.areaSqKm)}` : ''}`)),
      },
    });
  }

  startDrawing(): void {
    this.beginDraw((ring) => this.emit('drawComplete', ring));
  }

  finishDrawing(): void {
    if (!this.drawing) return;
    // govmap completes a shape on double-click. The toolbar button can finish from the
    // vertices we tracked via CLICK events, when govmap reports them during drawing.
    const result = this.sketch.toRing();
    if (!result.ok) {
      this.emit('error', new Error(this.sketch.length === 0 ? 'Double-click on the map to finish the shape' : result.reason));
      return;
    }
    const onDone = this.onDrawDone;
    this.stopDraw();
    onDone?.(result.ring);
  }

  undoLastVertex(): void {
    this.emit('error', new Error('Undo is not available while drawing on govmap; cancel and redraw instead'));
  }

  cancelDrawing(): void {
    if (!this.drawing) return;
    this.stopDraw();
    this.emit('drawCancel');
  }

  isDrawing(): boolean {
    return this.drawing;
  }

  /** govmap has no vertex editing API: editing an existing shape means redrawing it. */
  startEditing(areaToEdit: RenderableArea): void {
    this.editing = { area: areaToEdit, result: null };
    this.renderAreas(this.lastAreas);
    this.beginDraw((ring) => {
      if (!this.editing) return;
      this.editing.result = ring;
      this.emit('editChange', {
        ring,
        points: ring.slice(0, -1),
        vertexCount: ring.length - 1,
        areaSqKm: area.areaSqKm(ring),
        perimeterM: area.lengthMeters(ring, true),
        valid: true,
      });
    });
  }

  stopEditing(save: boolean): LngLat[] | null {
    if (this.drawing) this.stopDraw();
    const result = save ? (this.editing?.result ?? null) : null;
    this.editing = null;
    this.renderAreas(this.lastAreas);
    return result;
  }

  // ---------------------------------------------------------------------------------

  private onDrawDone: ((ring: LngLat[]) => void) | null = null;

  private beginDraw(onDone: (ring: LngLat[]) => void): void {
    if (this.drawing) this.stopDraw();
    this.drawing = true;
    this.onDrawDone = onDone;
    this.sketch.clear();
    this.container.classList.add('is-drawing');
    void this.client
      .drawPolygon()
      .then((wkt) => {
        if (wkt === null || !this.drawing) return; // cancelled
        const ring = this.transformer.ringItmToWgs84(WktCodec.parsePolygonOuterRing(wkt));
        const closed = ring.length > 0 && (ring[0]![0] !== ring.at(-1)![0] || ring[0]![1] !== ring.at(-1)![1]) ? [...ring, ring[0]!] : ring;
        const done = this.onDrawDone;
        this.drawing = false;
        this.onDrawDone = null;
        this.sketch.clear();
        this.container.classList.remove('is-drawing');
        if (closed.length < 4 || PolygonValidator.hasSelfIntersection(closed)) {
          this.emit('error', new Error('The drawn shape is not a valid polygon'));
          this.emit('drawCancel');
          return;
        }
        done?.(closed);
      })
      .catch((err: unknown) => {
        this.stopDraw();
        this.emit('error', err instanceof Error ? err : new Error('govmap drawing failed'));
        this.emit('drawCancel');
      });
  }

  private stopDraw(): void {
    this.drawing = false;
    this.onDrawDone = null;
    this.sketch.clear();
    this.container.classList.remove('is-drawing');
    this.client.cancelDraw();
  }

  private handleClick(point: LngLat): void {
    if (this.drawing) {
      if (this.sketch.add(point)) this.emit('sketchChange', this.sketch.progress(false));
      return;
    }
    // Topmost (last rendered) polygon containing the click wins.
    const hit = [...this.lastAreas].reverse().find((a) => a.id !== this.editing?.area.id && pointInRing(point, a.geometry.coordinates[0]));
    if (hit) this.emit('areaClick', hit.id);
  }

  private emitViewport(): void {
    if (!this.extent) return;
    this.emit('viewportChange', { bbox: this.transformer.itmExtentToBBox(this.extent), view: this.getView() });
  }

  private async loadApi(): Promise<GovmapApi> {
    const { mode, scriptUrl } = this.config.govmap;
    if (mode === 'mock') return window.govmap instanceof MockGovmap ? window.govmap : GovmapLoader.install(new MockGovmap());
    if (mode === 'disabled') throw new Error('govmap is not configured (set GOVMAP_TOKEN)');
    return GovmapLoader.load(scriptUrl);
  }

  /** govmap zoom level whose resolution is closest (log scale) to `resolution` m/px. */
  static levelFor(resolution: number): number {
    let best = 0;
    GOVMAP_LEVEL_RESOLUTIONS.forEach((r, i) => {
      if (Math.abs(Math.log(r / resolution)) < Math.abs(Math.log(GOVMAP_LEVEL_RESOLUTIONS[best]! / resolution))) best = i;
    });
    return best;
  }
}

function areaName(id: string): string {
  return `area-${id}`;
}

function styleKey(a: RenderableArea): string {
  return `${a.label}|${a.color}|${a.selected}|${a.lockedBy ?? ''}`;
}

function symbolFor(color: string, selected: boolean, locked: boolean): GovmapSymbol {
  return {
    outlineColor: hexToColor(color, locked ? 0.6 : 1),
    outlineWidth: selected ? 4 : 2,
    fillColor: hexToColor(color, selected ? 0.35 : 0.18),
  };
}

function hexToColor(hex: string, alpha: number): GovmapColor {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return [37, 99, 235, alpha];
  return [parseInt(m[1]!, 16), parseInt(m[2]!, 16), parseInt(m[3]!, 16), alpha];
}

/** govmap may render tooltips as HTML; never pass user text through unescaped. */
function escapeText(v: string): string {
  return v.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** Ray casting in lng/lat (fine at map-click precision for non-polar polygons). */
export function pointInRing([x, y]: LngLat, ring: LngLat[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
