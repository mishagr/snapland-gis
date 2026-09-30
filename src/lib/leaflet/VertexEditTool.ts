import L from 'leaflet';
import { GeodesicAreaCalculator } from '@/lib/geo/GeodesicAreaCalculator';
import { PolygonValidator } from '@/lib/geo/PolygonValidator';
import type { LngLat, PolygonGeometry } from '@/lib/geo/types';
import type { SketchProgress } from '@/lib/map/IMapEngine';
import { toLatLng, toLngLat } from './latlng';

export interface EditToolHandlers {
  onChange(progress: SketchProgress & { ring: LngLat[]; valid: boolean }): void;
}

const calc = new GeodesicAreaCalculator();

/**
 * Edit an existing polygon in place: drag vertex handles to move them, drag a
 * midpoint handle to insert a vertex, right-click (long-press) a vertex to delete
 * it. The working ring is kept in WGS84; an invalid (self-crossing) shape is shown
 * in red and reported as `valid: false`.
 */
export class VertexEditTool {
  private readonly group = L.layerGroup();
  private readonly shape: L.Polygon;
  private ring: LngLat[] = []; // open ring (no closing vertex)
  private original = '';
  private handles: L.Marker[] = [];
  private active = false;

  constructor(
    private readonly map: L.Map,
    private readonly handlers: EditToolHandlers,
    private readonly color = '#f59e0b',
  ) {
    this.shape = L.polygon([], { color, weight: 3, dashArray: '4 4', fillOpacity: 0.2, interactive: false });
    this.group.addLayer(this.shape);
  }

  get isActive(): boolean {
    return this.active;
  }

  start(geometry: PolygonGeometry): void {
    const closed = geometry.coordinates[0];
    this.ring = closed.slice(0, -1).map(([lng, lat]) => [lng, lat] as LngLat);
    this.original = JSON.stringify(this.ring);
    this.active = true;
    this.group.addTo(this.map);
    this.rebuild();
    this.emit();
  }

  /** Returns the closed edited ring when it differs from the original, else null. */
  stop(): LngLat[] | null {
    if (!this.active) return null;
    this.active = false;
    this.clearHandles();
    this.group.remove();
    const changed = JSON.stringify(this.ring) !== this.original;
    return changed ? [...this.ring, this.ring[0]!] : null;
  }

  private rebuild(): void {
    this.clearHandles();
    this.redrawShape();
    this.ring.forEach((p, i) => {
      const vertex = L.marker(toLatLng(p), {
        draggable: true,
        icon: L.divIcon({ className: 'vertex-handle', iconSize: [14, 14] }),
        keyboard: false,
      });
      vertex.on('drag', (e) => {
        this.ring[i] = toLngLat((e.target as L.Marker).getLatLng());
        this.redrawShape();
        this.emit();
      });
      vertex.on('dragend', () => this.rebuild());
      vertex.on('contextmenu', (e) => {
        L.DomEvent.stop(e as unknown as Event);
        if (this.ring.length <= 3) return;
        this.ring.splice(i, 1);
        this.rebuild();
        this.emit();
      });
      this.handles.push(vertex.addTo(this.group));

      const next = this.ring[(i + 1) % this.ring.length]!;
      const mid = L.marker(toLatLng([(p[0] + next[0]) / 2, (p[1] + next[1]) / 2]), {
        draggable: true,
        icon: L.divIcon({ className: 'vertex-handle vertex-handle--mid', iconSize: [10, 10] }),
        keyboard: false,
      });
      let inserted = false;
      mid.on('dragstart', () => {
        this.ring.splice(i + 1, 0, toLngLat(mid.getLatLng()));
        inserted = true;
      });
      mid.on('drag', () => {
        if (!inserted) return;
        this.ring[i + 1] = toLngLat(mid.getLatLng());
        this.redrawShape();
        this.emit();
      });
      mid.on('dragend', () => this.rebuild());
      this.handles.push(mid.addTo(this.group));
    });
  }

  private redrawShape(): void {
    const valid = this.isValid();
    this.shape.setLatLngs(this.ring.map(toLatLng));
    this.shape.setStyle({ color: valid ? this.color : '#dc2626' });
  }

  private isValid(): boolean {
    return this.ring.length >= 3 && !PolygonValidator.hasSelfIntersection([...this.ring, this.ring[0]!]);
  }

  private emit(): void {
    const closed = [...this.ring, this.ring[0]!];
    this.handlers.onChange({
      points: [...this.ring],
      vertexCount: this.ring.length,
      ring: closed,
      areaSqKm: calc.areaSqKm(this.ring),
      perimeterM: calc.lengthMeters(this.ring, true),
      valid: this.isValid(),
    });
  }

  private clearHandles(): void {
    for (const h of this.handles) h.remove();
    this.handles = [];
  }
}
