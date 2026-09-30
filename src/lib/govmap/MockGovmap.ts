import { GOVMAP_LEVEL_RESOLUTIONS } from './constants';
import type {
  GovmapApi,
  GovmapCreateMapOptions,
  GovmapDeferred,
  GovmapDisplayGeometriesOptions,
  GovmapDrawResponse,
  GovmapExtent,
  GovmapPoint,
} from './types';
import { WktCodec } from '@/lib/geo/WktCodec';

/** jQuery-Deferred look-alike: `progress` callbacks fire on every notify. */
export class MockDeferred<T> implements GovmapDeferred<T> {
  private readonly progressCbs: ((v: T) => void)[] = [];
  private readonly doneCbs: ((v: T) => void)[] = [];
  private readonly failCbs: ((e: unknown) => void)[] = [];

  progress(cb: (v: T) => void): this {
    this.progressCbs.push(cb);
    return this;
  }
  done(cb: (v: T) => void): this {
    this.doneCbs.push(cb);
    return this;
  }
  fail(cb: (e: unknown) => void): this {
    this.failCbs.push(cb);
    return this;
  }
  notify(value: T): void {
    for (const cb of this.progressCbs) cb(value);
  }
  resolve(value: T): void {
    for (const cb of this.doneCbs) cb(value);
  }
  reject(err: unknown): void {
    for (const cb of this.failCbs) cb(err);
  }
}

interface StoredGeometry {
  wkt: string;
  type: string | number;
  outline: string;
  fill: string;
  tooltip?: string;
}

/**
 * In-memory stand-in for `window.govmap`, used by unit tests and by
 * `GOVMAP_MODE=mock` (so the govmap engine can be exercised without a token or
 * network access). In a browser it renders geometries into an SVG in ITM space
 * and supports click / double-click drawing and wheel zoom; in Node it only records.
 */
export class MockGovmap implements GovmapApi {
  readonly drawType = { Point: 'point', Polyline: 'polyline', Polygon: 'polygon', Circle: 'circle', Rectangle: 'rectangle', FreehandPolygon: 'freehandPolygon' };
  readonly geometryType = { POINT: 'point', POLYLINE: 'polyline', POLYGON: 'polygon' };
  readonly events = { CLICK: 'click', EXTENT_CHANGE: 'extent-change', DOUBLE_CLICK: 'double-click' };

  /** Every API call, for assertions. */
  readonly calls: { method: string; args: unknown[] }[] = [];
  readonly geometries = new Map<string, StoredGeometry>();
  background: number | string = 0;
  center: GovmapPoint = { x: 180000, y: 660000 };
  level = 6;

  private readonly eventDeferreds = new Map<string | number, MockDeferred<unknown>>();
  private drawDeferred: MockDeferred<GovmapDrawResponse> | null = null;
  private drawPoints: GovmapPoint[] = [];
  private element: HTMLElement | null = null;
  private svg: SVGSVGElement | null = null;
  private size = { width: 800, height: 600 };

  createMap(elementId: string, options: GovmapCreateMapOptions): void {
    this.record('createMap', elementId, options);
    if (!options.token) throw new Error('token is required');
    if (options.center) this.center = { ...options.center };
    if (options.level !== undefined) this.level = options.level;
    if (options.background !== undefined) this.background = options.background;
    if (typeof document !== 'undefined') this.mountSvg(document.getElementById(elementId));
    setTimeout(() => {
      options.onLoad?.();
      this.emitExtent();
    }, 0);
  }

  draw(drawType: string | number): GovmapDeferred<GovmapDrawResponse> {
    this.record('draw', drawType);
    this.drawDeferred = new MockDeferred<GovmapDrawResponse>();
    this.drawPoints = [];
    this.render();
    return this.drawDeferred;
  }

  clearDrawings(): void {
    this.record('clearDrawings');
    this.drawDeferred = null;
    this.drawPoints = [];
    this.render();
  }

  setDefaultTool(): void {
    this.record('setDefaultTool');
    this.drawDeferred = null;
    this.drawPoints = [];
  }

  displayGeometries(options: GovmapDisplayGeometriesOptions): GovmapDeferred<unknown> {
    this.record('displayGeometries', options);
    if (options.clearExisting) this.geometries.clear();
    options.wkts.forEach((wkt, i) => {
      const symbol = options.symbols?.[i] ?? options.defaultSymbol ?? {};
      this.geometries.set(options.names[i] ?? `g${i}`, {
        wkt,
        type: options.geometryType,
        outline: rgba(symbol.outlineColor ?? [0, 0, 255, 1]),
        fill: rgba(symbol.fillColor ?? [0, 0, 255, 0.2]),
        tooltip: options.data?.tooltips?.[i],
      });
    });
    this.render();
    const d = new MockDeferred<unknown>();
    setTimeout(() => d.notify(true), 0);
    return d;
  }

  clearGeometriesByName(names: string[]): void {
    this.record('clearGeometriesByName', names);
    for (const n of names) this.geometries.delete(n);
    this.render();
  }

  setBackground(background: number | string): void {
    this.record('setBackground', background);
    this.background = background;
    this.render();
  }

  zoomToXY(options: GovmapPoint & { level: number }): void {
    this.record('zoomToXY', options);
    this.center = { x: options.x, y: options.y };
    this.level = options.level;
    this.render();
    this.emitExtent();
  }

  onEvent(event: string | number): GovmapDeferred<unknown> {
    this.record('onEvent', event);
    let d = this.eventDeferreds.get(event);
    if (!d) this.eventDeferreds.set(event, (d = new MockDeferred<unknown>()));
    return d;
  }

  // ---- test / simulation helpers -------------------------------------------------

  /** Simulates a user click at an ITM point (feeds an active draw like the real map). */
  click(point: GovmapPoint): void {
    if (this.drawDeferred) {
      this.drawPoints.push(point);
      this.render();
    }
    this.eventDeferreds.get(this.events.CLICK)?.notify({ mapPoint: point });
  }

  /** Simulates the double-click that completes a govmap draw. */
  completeDraw(): void {
    if (!this.drawDeferred || this.drawPoints.length < 3) return;
    const d = this.drawDeferred;
    const wkt = WktCodec.formatPolygon(this.drawPoints);
    this.drawDeferred = null;
    this.drawPoints = [];
    d.notify({ wkt });
    this.render();
  }

  get extent(): GovmapExtent {
    const res = GOVMAP_LEVEL_RESOLUTIONS[Math.max(0, Math.min(GOVMAP_LEVEL_RESOLUTIONS.length - 1, this.level))]!;
    const halfW = (this.size.width * res) / 2;
    const halfH = (this.size.height * res) / 2;
    return { xmin: this.center.x - halfW, ymin: this.center.y - halfH, xmax: this.center.x + halfW, ymax: this.center.y + halfH };
  }

  private emitExtent(): void {
    this.eventDeferreds.get(this.events.EXTENT_CHANGE)?.notify({ extent: this.extent, level: this.level });
  }

  private record(method: string, ...args: unknown[]): void {
    this.calls.push({ method, args });
  }

  // ---- browser rendering ---------------------------------------------------------

  private mountSvg(element: HTMLElement | null): void {
    if (!element) return;
    this.element = element;
    element.innerHTML = '';
    if (getComputedStyle(element).position === 'static') element.style.position = 'relative';
    const rect = element.getBoundingClientRect();
    this.size = { width: Math.max(1, Math.round(rect.width)) || 800, height: Math.max(1, Math.round(rect.height)) || 600 };
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', '100%');
    svg.setAttribute('height', '100%');
    svg.style.display = 'block';
    svg.dataset.testid = 'mock-govmap';
    element.appendChild(svg);
    this.svg = svg;

    // A double-click also fires two clicks; delay single clicks so dblclick can cancel them.
    let clickTimer: ReturnType<typeof setTimeout> | undefined;
    svg.addEventListener('click', (e) => {
      if (e.detail > 1) return;
      const p = this.toItm(e);
      clickTimer = setTimeout(() => this.click(p), 250);
    });
    svg.addEventListener('dblclick', (e) => {
      e.preventDefault();
      clearTimeout(clickTimer);
      // Like govmap: the double-click places the last vertex and completes the shape.
      if (this.drawDeferred) this.click(this.toItm(e));
      this.completeDraw();
    });
    svg.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.zoomToXY({ ...this.center, level: Math.max(0, Math.min(GOVMAP_LEVEL_RESOLUTIONS.length - 1, this.level + (e.deltaY < 0 ? 1 : -1))) });
    });
    new ResizeObserver(() => {
      const r = element.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) {
        this.size = { width: r.width, height: r.height };
        this.render();
        this.emitExtent();
      }
    }).observe(element);
    this.render();
  }

  private toItm(e: MouseEvent): GovmapPoint {
    const rect = this.svg!.getBoundingClientRect();
    const ext = this.extent;
    return {
      x: ext.xmin + ((e.clientX - rect.left) / rect.width) * (ext.xmax - ext.xmin),
      y: ext.ymax - ((e.clientY - rect.top) / rect.height) * (ext.ymax - ext.ymin),
    };
  }

  private render(): void {
    if (!this.svg) return;
    const ext = this.extent;
    const sx = (x: number) => ((x - ext.xmin) / (ext.xmax - ext.xmin)) * this.size.width;
    const sy = (y: number) => ((ext.ymax - y) / (ext.ymax - ext.ymin)) * this.size.height;
    const path = (wkt: string) => {
      try {
        return WktCodec.parsePolygonOuterRing(wkt.replace(/^LINESTRING/i, 'POLYGON(').replace(/\)$/, '))'))
          .map((p, i) => `${i ? 'L' : 'M'}${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`)
          .join(' ');
      } catch {
        return '';
      }
    };
    const ortho = String(this.background) === '1';
    const parts = [
      `<rect width="100%" height="100%" fill="${ortho ? '#3f4f3a' : '#eef1ea'}"/>`,
      `<text x="12" y="22" font-size="13" fill="${ortho ? '#fff' : '#555'}" font-family="sans-serif">govmap mock · ${ortho ? 'orthophoto' : 'street'} · level ${this.level}</text>`,
    ];
    for (const [name, g] of this.geometries) {
      const closed = String(g.type) === String(this.geometryType.POLYGON);
      parts.push(
        `<path data-name="${escapeAttr(name)}" d="${path(g.wkt)}${closed ? ' Z' : ''}" stroke="${g.outline}" fill="${closed ? g.fill : 'none'}" stroke-width="2"><title>${escapeAttr(g.tooltip ?? name)}</title></path>`,
      );
    }
    if (this.drawDeferred && this.drawPoints.length > 0) {
      const d = this.drawPoints.map((p, i) => `${i ? 'L' : 'M'}${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`).join(' ');
      parts.push(`<path d="${d}" stroke="#2563eb" stroke-dasharray="5 4" fill="none" stroke-width="2"/>`);
    }
    this.svg.innerHTML = parts.join('');
  }
}

function rgba([r, g, b, a]: [number, number, number, number]): string {
  return `rgba(${r},${g},${b},${a})`;
}

function escapeAttr(v: string): string {
  return v.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
