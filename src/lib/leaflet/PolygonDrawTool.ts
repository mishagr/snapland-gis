import L from 'leaflet';
import type { LngLat } from '@/lib/geo/types';
import type { SketchProgress } from '@/lib/map/IMapEngine';
import { SketchModel } from '@/lib/map/SketchModel';
import { toLatLng, toLngLat } from './latlng';

export interface DrawToolHandlers {
  onProgress(progress: SketchProgress): void;
  onComplete(ring: LngLat[]): void;
  onCancel(): void;
  onInvalid(reason: string): void;
}

/** Pixels within which a click on the first vertex closes the polygon. */
const CLOSE_TOLERANCE_PX = 10;

/**
 * Click-to-draw polygon tool (no plugins).
 *
 * Mouse: click adds a vertex, double-click or clicking the first vertex finishes.
 * Keyboard: Enter finishes, Backspace removes the last vertex, Escape cancels.
 * Touch: tap adds a vertex; the toolbar "Finish" button calls `finish()`.
 *
 * The shape lives in a WGS84 SketchModel; the Leaflet layers are only a projection
 * of it, so a base-layer/CRS switch mid-drawing keeps every vertex in place.
 */
export class PolygonDrawTool {
  private readonly model = new SketchModel();
  private readonly group = L.layerGroup();
  private readonly placed: L.Polyline;
  private readonly guide: L.Polyline;
  private readonly fill: L.Polygon;
  private markers: L.CircleMarker[] = [];
  private active = false;
  private frame = 0;

  constructor(
    private readonly map: L.Map,
    private readonly handlers: DrawToolHandlers,
    color = '#2563eb',
  ) {
    this.fill = L.polygon([], { color, weight: 0, fillOpacity: 0.15, interactive: false });
    this.placed = L.polyline([], { color, weight: 3, interactive: false });
    this.guide = L.polyline([], { color, weight: 2, dashArray: '6 6', opacity: 0.8, interactive: false });
    this.group.addLayer(this.fill).addLayer(this.placed).addLayer(this.guide);
  }

  get isActive(): boolean {
    return this.active;
  }

  start(): void {
    if (this.active) return;
    this.active = true;
    this.model.clear();
    this.group.addTo(this.map);
    this.map.doubleClickZoom.disable();
    this.map.getContainer().classList.add('is-drawing');
    this.map.on('click', this.onClick);
    this.map.on('dblclick', this.onDoubleClick);
    this.map.on('mousemove', this.onMove);
    this.map.on('viewreset', this.redraw);
    document.addEventListener('keydown', this.onKey);
    this.redraw();
  }

  /** Adds a vertex programmatically (clicks on existing polygons are forwarded here). */
  addVertex(latlng: L.LatLng): void {
    if (!this.active) return;
    const first = this.model.vertices[0];
    if (first && this.model.length >= 3) {
      const a = this.map.latLngToContainerPoint(latlng);
      const b = this.map.latLngToContainerPoint(toLatLng(first));
      if (a.distanceTo(b) <= CLOSE_TOLERANCE_PX) {
        this.finish();
        return;
      }
    }
    if (this.model.add(toLngLat(latlng))) this.changed();
  }

  undo(): void {
    if (!this.active || this.model.length === 0) return;
    this.model.undo();
    this.changed();
  }

  finish(): void {
    if (!this.active) return;
    const result = this.model.toRing();
    if (!result.ok) {
      this.handlers.onInvalid(result.reason);
      return;
    }
    this.stop();
    this.handlers.onComplete(result.ring);
  }

  cancel(): void {
    if (!this.active) return;
    this.stop();
    this.handlers.onCancel();
  }

  private stop(): void {
    this.active = false;
    cancelAnimationFrame(this.frame);
    this.map.off('click', this.onClick);
    this.map.off('dblclick', this.onDoubleClick);
    this.map.off('mousemove', this.onMove);
    this.map.off('viewreset', this.redraw);
    document.removeEventListener('keydown', this.onKey);
    this.map.doubleClickZoom.enable();
    this.map.getContainer().classList.remove('is-drawing');
    this.model.clear();
    this.clearMarkers();
    this.group.remove();
  }

  private readonly onClick = (e: L.LeafletMouseEvent) => this.addVertex(e.latlng);

  private readonly onDoubleClick = (e: L.LeafletMouseEvent) => {
    L.DomEvent.stop(e);
    // The two clicks of a double-click already added (up to) two vertices at almost
    // the same spot; drop the duplicate before finishing.
    const pts = this.model.vertices;
    if (pts.length >= 2) {
      const a = this.map.latLngToContainerPoint(toLatLng(pts[pts.length - 1]!));
      const b = this.map.latLngToContainerPoint(toLatLng(pts[pts.length - 2]!));
      if (a.distanceTo(b) < 6) this.model.undo();
    }
    this.finish();
  };

  private readonly onMove = (e: L.LeafletMouseEvent) => {
    this.model.setHover(toLngLat(e.latlng));
    cancelAnimationFrame(this.frame);
    this.frame = requestAnimationFrame(() => this.changed());
  };

  private readonly onKey = (e: KeyboardEvent) => {
    const target = e.target as HTMLElement | null;
    if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;
    if (e.key === 'Escape') this.cancel();
    else if (e.key === 'Enter') this.finish();
    else if (e.key === 'Backspace' || (e.key === 'z' && (e.ctrlKey || e.metaKey))) {
      e.preventDefault();
      this.undo();
    }
  };

  private changed(): void {
    this.redraw();
    this.handlers.onProgress(this.model.progress());
  }

  private readonly redraw = (): void => {
    const pts = this.model.vertices.map(toLatLng);
    const hover = this.model.preview(true).length > pts.length ? toLatLng(this.model.preview(true).at(-1)!) : null;
    this.placed.setLatLngs(pts);
    this.fill.setLatLngs(hover ? [...pts, hover] : pts);
    this.guide.setLatLngs(hover && pts.length > 0 ? [pts[pts.length - 1]!, hover, ...(pts.length >= 2 ? [pts[0]!] : [])] : []);
    // Markers follow their LatLngs through zoom/CRS changes; rebuild only when vertices change.
    if (this.markers.length === pts.length && pts.length > 0 && this.markers[0]!.options.fillColor === this.firstColor(pts.length)) return;
    this.clearMarkers();
    this.markers = pts.map((p, i) =>
      L.circleMarker(p, {
        radius: i === 0 ? 6 : 4,
        color: '#fff',
        weight: 2,
        fillColor: i === 0 ? this.firstColor(pts.length) : '#2563eb',
        fillOpacity: 1,
        interactive: false,
      }).addTo(this.group),
    );
  };

  /** The first vertex turns green once clicking it would close a valid polygon. */
  private firstColor(count: number): string {
    return count >= 3 ? '#16a34a' : '#2563eb';
  }

  private clearMarkers(): void {
    for (const m of this.markers) m.remove();
    this.markers = [];
  }
}
