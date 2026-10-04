import type {
  GovmapApi,
  GovmapClickEvent,
  GovmapCreateMapOptions,
  GovmapDeferred,
  GovmapDisplayGeometriesOptions,
  GovmapExtentChangeEvent,
  GovmapPoint,
} from './types';

/**
 * Promise-based, typed wrapper around the `govmap` global. It is the only class
 * that touches the raw API, so API differences are absorbed in one place and
 * everything above it can be tested against a mock.
 */
export class GovmapClient {
  private readonly listeners = new Map<string | number, Set<(payload: unknown) => void>>();
  private drawToken = 0;
  private resolvePendingDraw: ((wkt: string | null) => void) | null = null;

  constructor(private readonly api: GovmapApi) {}

  /** Creates the map and resolves once it reports it is ready (onLoad or first extent), or after `timeoutMs`. */
  createMap(elementId: string, options: GovmapCreateMapOptions, timeoutMs = 8_000): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(done, timeoutMs);
      const unsubscribe = this.onExtentChange(() => {
        unsubscribe();
        done();
      });
      try {
        this.api.createMap(elementId, {
          ...options,
          onLoad: () => {
            options.onLoad?.();
            done();
          },
          onError: (err) => {
            options.onError?.(err);
            if (!settled) {
              settled = true;
              clearTimeout(timer);
              reject(err instanceof Error ? err : new Error('govmap failed to create the map (check the token and domain)'));
            }
          },
        });
      } catch (err) {
        settled = true;
        clearTimeout(timer);
        reject(err);
      }
    });
  }

  /**
   * Puts the map in polygon-drawing mode. Resolves with the drawn WKT (ITM), or
   * null when cancelled via `cancelDraw()` or superseded by another draw.
   */
  drawPolygon(): Promise<string | null> {
    this.resolvePendingDraw?.(null);
    const token = ++this.drawToken;
    return new Promise((resolve, reject) => {
      this.resolvePendingDraw = resolve;
      const settle = (fn: () => void) => {
        if (token !== this.drawToken) return;
        this.drawToken++;
        this.resolvePendingDraw = null;
        fn();
      };
      const onResult = (response: { wkt?: string } | undefined) =>
        settle(() => (response?.wkt ? resolve(response.wkt) : reject(new Error('govmap draw returned no geometry'))));
      const deferred = this.api.draw(this.api.drawType.Polygon);
      deferred.progress(onResult);
      deferred.done?.(onResult);
      deferred.fail?.((err) => settle(() => reject(err instanceof Error ? err : new Error('govmap draw failed'))));
    });
  }

  cancelDraw(): void {
    this.drawToken++;
    const resolve = this.resolvePendingDraw;
    this.resolvePendingDraw = null;
    resolve?.(null);
    this.api.setDefaultTool?.();
    this.api.clearDrawings();
  }

  async displayGeometries(options: GovmapDisplayGeometriesOptions): Promise<void> {
    if (options.wkts.length === 0) return;
    await this.settle(this.api.displayGeometries(options));
  }

  clearGeometriesByName(names: string[]): void {
    if (names.length > 0) this.api.clearGeometriesByName(names);
  }

  setBackground(id: number | string): void {
    this.api.setBackground(id);
  }

  zoomTo(point: GovmapPoint, level: number): void {
    this.api.zoomToXY({ x: point.x, y: point.y, level, marker: false });
  }

  get polygonType(): string | number {
    return this.api.geometryType.POLYGON;
  }

  get polylineType(): string | number {
    return this.api.geometryType.POLYLINE;
  }

  onExtentChange(callback: (e: GovmapExtentChangeEvent) => void): () => void {
    return this.subscribe(this.api.events.EXTENT_CHANGE, callback as (p: unknown) => void);
  }

  onClick(callback: (e: GovmapClickEvent) => void): () => void {
    return this.subscribe(this.api.events.CLICK, callback as (p: unknown) => void);
  }

  /** govmap binds one deferred per event type; fan it out to any number of subscribers. */
  private subscribe(event: string | number, callback: (payload: unknown) => void): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
      const listeners = set;
      this.api.onEvent(event).progress((payload) => {
        for (const l of listeners) l(payload);
      });
    }
    set.add(callback);
    return () => set.delete(callback);
  }

  /** Deferreds may never call back for fire-and-forget calls; do not wait forever. */
  private settle(deferred: GovmapDeferred<unknown> | undefined, timeoutMs = 3_000): Promise<void> {
    return new Promise((resolve) => {
      if (!deferred || typeof deferred.progress !== 'function') return resolve();
      const timer = setTimeout(resolve, timeoutMs);
      const finish = () => {
        clearTimeout(timer);
        resolve();
      };
      deferred.progress(finish);
      deferred.done?.(finish);
      deferred.fail?.(finish);
    });
  }
}
