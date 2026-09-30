import L from 'leaflet';
import type { PublicConfig } from '@/lib/config/publicConfig';
import { formatArea } from '@/lib/geo/GeodesicAreaCalculator';
import type { BBox, LngLat } from '@/lib/geo/types';
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
import { Emitter } from '@/lib/util/Emitter';
import { BaseLayerCatalog } from './BaseLayerCatalog';
import { CrsRegistry } from './CrsRegistry';
import { escapeHtml, toLatLng } from './latlng';
import { LayerSwitcher } from './LayerSwitcher';
import { PolygonDrawTool } from './PolygonDrawTool';
import { VertexEditTool } from './VertexEditTool';

interface RenderedArea {
  /** Compared by reference: the store replaces geometry objects only when they change. */
  geometry: RenderableArea['geometry'];
  styleKey: string;
  layer: L.Polygon;
}

/**
 * Leaflet implementation: OpenStreetMap + satellite imagery, with an optional
 * govmap orthophoto layer in the Israeli TM grid. Areas are drawn on a canvas
 * renderer (10k+ polygons stay responsive) and diffed by signature so only
 * changed polygons are touched on each render.
 */
export class LeafletEngine extends Emitter<MapEngineEvents> implements IMapEngine {
  readonly kind = 'leaflet' as const;
  readonly capabilities: EngineCapabilities = { vertexEditing: true, liveSketch: true };

  private map!: L.Map;
  private crs!: CrsRegistry;
  private catalog!: BaseLayerCatalog;
  private switcher!: LayerSwitcher;
  private drawTool!: PolygonDrawTool;
  private editTool!: VertexEditTool;
  private readonly areaLayers = new Map<string, RenderedArea>();
  private readonly areaGroup = L.featureGroup();
  private readonly sketchGroup = L.layerGroup();
  private editingAreaId: string | null = null;
  private readonly renderer = L.canvas({ padding: 0.5, tolerance: 4 });

  constructor(private readonly config: PublicConfig) {
    super();
  }

  async mount(container: HTMLElement, initial: { view: MapView; baseLayer: BaseLayerCategory }): Promise<void> {
    this.catalog = new BaseLayerCatalog(this.config);
    this.crs = new CrsRegistry(this.config.govmapOrtho ? { origin: this.config.govmapOrtho.origin, resolutions: this.config.govmapOrtho.resolutions } : null);
    const first = this.catalog.defaultFor(initial.baseLayer);
    const center = toLatLng(initial.view.center);
    this.map = L.map(container, {
      crs: this.crs.get(first.crs),
      center,
      zoom: this.crs.zoomFor(first.crs, initial.view.resolution, center.lat),
      zoomControl: true,
      attributionControl: true,
      renderer: this.renderer,
      zoomSnap: 1,
    });
    L.control.scale({ metric: true, imperial: false }).addTo(this.map);
    this.areaGroup.addTo(this.map);
    this.sketchGroup.addTo(this.map);

    this.switcher = new LayerSwitcher(this.map, this.crs);
    await this.switcher.switchTo(first);

    this.drawTool = new PolygonDrawTool(this.map, {
      onProgress: (p) => this.emit('sketchChange', p),
      onComplete: (ring) => this.emit('drawComplete', ring),
      onCancel: () => this.emit('drawCancel'),
      onInvalid: (reason) => this.emit('error', new Error(reason)),
    });
    this.editTool = new VertexEditTool(this.map, { onChange: (p) => this.emit('editChange', p) });

    this.map.on('moveend', () => this.emitViewport());
    this.emitViewport();
  }

  private destroyed = false;

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.drawTool?.cancel();
    this.editTool?.stop();
    this.map?.remove();
    this.areaLayers.clear();
    this.removeAllListeners();
  }

  getView(): MapView {
    const c = this.map.getCenter();
    const crsId = this.switcher.currentLayer?.crs ?? 'EPSG:3857';
    return { center: [c.lng, c.lat], resolution: this.crs.resolutionAt(crsId, this.map.getZoom(), c.lat) };
  }

  setView(view: MapView): void {
    const crsId = this.switcher.currentLayer?.crs ?? 'EPSG:3857';
    const center = toLatLng(view.center);
    this.map.setView(center, this.crs.zoomFor(crsId, view.resolution, center.lat), { animate: false });
  }

  fitBounds(b: BBox): void {
    this.map.fitBounds(L.latLngBounds([b.minLat, b.minLng], [b.maxLat, b.maxLng]), { padding: [40, 40], maxZoom: 17 });
  }

  listBaseLayers(): BaseLayerInfo[] {
    return this.catalog.list().map(({ create: _create, ...info }) => info);
  }

  getBaseLayer(): string {
    return this.switcher.currentLayer?.id ?? '';
  }

  async setBaseLayer(id: string): Promise<void> {
    const layer = this.catalog.get(id);
    if (!layer) throw new Error(`Unknown base layer ${id}`);
    await this.switcher.switchTo(layer);
    this.emit('baseLayerChange', id);
    this.emitViewport();
  }

  renderAreas(areas: RenderableArea[]): void {
    const seen = new Set<string>();
    for (const area of areas) {
      if (area.id === this.editingAreaId) continue; // the edit tool shows it
      seen.add(area.id);
      const styleKey = `${area.label}|${area.color}|${area.selected}|${area.lockedBy ?? ''}`;
      const existing = this.areaLayers.get(area.id);
      if (existing && existing.geometry === area.geometry) {
        if (existing.styleKey !== styleKey) {
          existing.layer.setStyle(this.areaStyle(area));
          existing.layer.setTooltipContent(escapeHtml(area.label));
          existing.styleKey = styleKey;
        }
        continue;
      }
      existing?.layer.remove();
      const layer = L.polygon(area.geometry.coordinates[0].slice(0, -1).map(toLatLng), {
        renderer: this.renderer,
        ...this.areaStyle(area),
      });
      layer.bindTooltip(escapeHtml(area.label), { sticky: true, direction: 'top', className: 'area-tooltip' });
      layer.on('click', (e) => {
        L.DomEvent.stopPropagation(e);
        // While drawing, a click on an existing polygon still places a vertex.
        if (this.drawTool.isActive) this.drawTool.addVertex(e.latlng);
        else this.emit('areaClick', area.id);
      });
      layer.addTo(this.areaGroup);
      this.areaLayers.set(area.id, { geometry: area.geometry, styleKey, layer });
    }
    for (const [id, rendered] of this.areaLayers) {
      if (!seen.has(id)) {
        rendered.layer.remove();
        this.areaLayers.delete(id);
      }
    }
  }

  private areaStyle(area: RenderableArea): L.PathOptions {
    return {
      color: area.color,
      weight: area.selected ? 4 : 2,
      opacity: 0.95,
      fillOpacity: area.selected ? 0.35 : 0.18,
      dashArray: area.lockedBy ? '6 4' : undefined,
    };
  }

  renderSketches(sketches: RenderableSketch[]): void {
    this.sketchGroup.clearLayers();
    for (const s of sketches) {
      if (s.points.length === 0) continue;
      const latlngs = s.points.map(toLatLng);
      const style = { color: s.color, weight: 2, dashArray: '4 6', interactive: false, renderer: this.renderer };
      const shape = latlngs.length >= 3 ? L.polygon(latlngs, { ...style, fillOpacity: 0.1 }) : L.polyline(latlngs, style);
      shape.addTo(this.sketchGroup);
      const label = `${escapeHtml(s.displayName)} is drawing${s.areaSqKm > 0 ? ` · ${formatArea(s.areaSqKm)}` : ''}`;
      L.tooltip({ permanent: true, direction: 'right', className: 'sketch-label', offset: [8, 0] })
        .setLatLng(latlngs[latlngs.length - 1]!)
        .setContent(label)
        .addTo(this.sketchGroup);
    }
  }

  startDrawing(): void {
    this.drawTool.start();
  }

  finishDrawing(): void {
    this.drawTool.finish();
  }

  undoLastVertex(): void {
    this.drawTool.undo();
  }

  cancelDrawing(): void {
    this.drawTool.cancel();
  }

  isDrawing(): boolean {
    return this.drawTool.isActive;
  }

  startEditing(area: RenderableArea): void {
    this.editingAreaId = area.id;
    this.areaLayers.get(area.id)?.layer.remove();
    this.areaLayers.delete(area.id);
    this.editTool.start(area.geometry);
  }

  stopEditing(save: boolean): LngLat[] | null {
    this.editingAreaId = null;
    const ring = this.editTool.stop();
    return save ? ring : null;
  }

  private emitViewport(): void {
    const b = this.map.getBounds();
    const bbox: BBox = {
      minLng: Math.max(-180, b.getWest()),
      minLat: Math.max(-90, b.getSouth()),
      maxLng: Math.min(180, b.getEast()),
      maxLat: Math.min(90, b.getNorth()),
    };
    this.emit('viewportChange', { bbox, view: this.getView() });
  }
}
