import type L from 'leaflet';
import type { LeafletBaseLayer } from './BaseLayerCatalog';
import type { CrsRegistry } from './CrsRegistry';

const FADE_MS = 250;

/**
 * Swaps base layers without visual jumps and without moving drawn geometry.
 *
 * Same projection: the new tile layer fades in over the old one, then the old one
 * is removed (a cross-fade; nothing is re-projected).
 *
 * Different projection (Web Mercator ↔ ITM): Leaflet supports one CRS per map, so
 * the switcher fades tiles out, records the view as centre + ground resolution,
 * replaces the map CRS, and re-opens the view at the zoom level of the new grid
 * with the closest resolution. `setView(..., { reset: true })` fires `viewreset`,
 * which makes every vector layer re-project its LatLngs into the new CRS, so
 * polygons land exactly where they were on the ground.
 */
export class LayerSwitcher {
  private current: { info: LeafletBaseLayer; tiles: L.TileLayer } | null = null;

  constructor(
    private readonly map: L.Map,
    private readonly crs: CrsRegistry,
  ) {}

  get currentLayer(): LeafletBaseLayer | null {
    return this.current?.info ?? null;
  }

  async switchTo(info: LeafletBaseLayer): Promise<void> {
    const prev = this.current;
    if (prev?.info.id === info.id) return;
    const tiles = info.create();
    this.current = { info, tiles };

    if (!prev || prev.info.crs === info.crs) {
      if (!prev) this.applyZoomRange(info);
      tiles.setOpacity(0);
      tiles.addTo(this.map);
      await this.fade(tiles, 0, 1);
      prev?.tiles.remove();
      return;
    }

    const container = this.map.getContainer();
    const center = this.map.getCenter();
    const resolution = this.crs.resolutionAt(prev.info.crs, this.map.getZoom(), center.lat);
    container.classList.add('crs-switching');
    await this.fade(prev.tiles, 1, 0);
    prev.tiles.remove();

    this.map.options.crs = this.crs.get(info.crs);
    this.applyZoomRange(info);
    const zoom = this.crs.zoomFor(info.crs, resolution, center.lat);
    this.map.setView(center, zoom, { animate: false, reset: true } as L.ZoomPanOptions);

    tiles.setOpacity(0);
    tiles.addTo(this.map);
    await this.fade(tiles, 0, 1);
    container.classList.remove('crs-switching');
  }

  private applyZoomRange(info: LeafletBaseLayer): void {
    const { min, max } = this.crs.zoomRange(info.crs);
    this.map.options.minZoom = min;
    this.map.options.maxZoom = max;
  }

  /** Opacity tween; resolves early when the tab is hidden (no rAF). */
  private fade(layer: L.TileLayer, from: number, to: number): Promise<void> {
    return new Promise((resolve) => {
      if (typeof document !== 'undefined' && document.hidden) {
        layer.setOpacity(to);
        resolve();
        return;
      }
      const start = performance.now();
      const step = (now: number) => {
        const t = Math.min(1, (now - start) / FADE_MS);
        layer.setOpacity(from + (to - from) * t);
        if (t < 1) requestAnimationFrame(step);
        else resolve();
      };
      requestAnimationFrame(step);
    });
  }
}
