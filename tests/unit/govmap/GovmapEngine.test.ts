import { describe, expect, it, vi } from 'vitest';
import type { PublicConfig } from '@/lib/config/publicConfig';
import { CoordinateTransformer } from '@/lib/geo/CoordinateTransformer';
import type { LngLat, PolygonGeometry } from '@/lib/geo/types';
import { WktCodec } from '@/lib/geo/WktCodec';
import { GOVMAP_LEVEL_RESOLUTIONS } from '@/lib/govmap/constants';
import { GovmapEngine, pointInRing } from '@/lib/govmap/GovmapEngine';
import { MockGovmap } from '@/lib/govmap/MockGovmap';
import type { RenderableArea } from '@/lib/map/IMapEngine';

const config: PublicConfig = {
  defaultEngine: 'govmap',
  defaultCenter: [34.7818, 32.0853],
  defaultResolution: 13,
  debugHandle: false,
  govmap: { mode: 'live', token: 'test-token', scriptUrl: 'unused' },
  govmapOrtho: null,
};

/** Just enough of an HTMLElement for the engine (no DOM in unit tests). */
function fakeContainer() {
  return { id: '', clientWidth: 800, clientHeight: 600, innerHTML: '', classList: { add: vi.fn(), remove: vi.fn() } } as unknown as HTMLElement;
}

const square: PolygonGeometry = {
  type: 'Polygon',
  coordinates: [[[34.78, 32.08], [34.79, 32.08], [34.79, 32.09], [34.78, 32.09], [34.78, 32.08]]],
};

function area(overrides: Partial<RenderableArea> = {}): RenderableArea {
  return { id: 'a1', name: 'Field', geometry: square, color: '#e6194b', label: 'Field <b>', selected: false, lockedBy: null, ...overrides };
}

async function mounted() {
  const api = new MockGovmap();
  const engine = new GovmapEngine(config, api);
  await engine.mount(fakeContainer(), { view: { center: config.defaultCenter, resolution: 13 }, baseLayer: 'satellite' });
  return { api, engine };
}

const flush = () => new Promise((r) => setTimeout(r, 5));
const t = new CoordinateTransformer();

describe('GovmapEngine', () => {
  it('creates the map in ITM at the closest govmap level and requested background', async () => {
    const { api, engine } = await mounted();
    const opts = api.calls.find((c) => c.method === 'createMap')!.args[1] as { center: { x: number; y: number }; level: number; background: number; token: string };
    expect(opts.token).toBe('test-token');
    expect(opts.level).toBe(5); // 13.23 m/px
    expect(opts.background).toBe(1); // satellite → orthophoto
    expect(opts.center.x).toBeCloseTo(t.wgs84ToItm(config.defaultCenter).x, 3);
    expect(engine.getBaseLayer()).toBe('govmap-orthophoto');
  });

  it('reports viewport changes as WGS84 bbox + ground resolution', async () => {
    const { api, engine } = await mounted();
    const events: { bbox: { minLng: number }; view: { resolution: number } }[] = [];
    engine.on('viewportChange', (e) => events.push(e));
    api.zoomToXY({ x: 180000, y: 665000, level: 7 });
    expect(events).toHaveLength(1);
    expect(events[0]!.view.resolution).toBeCloseTo(GOVMAP_LEVEL_RESOLUTIONS[7], 6);
    expect(events[0]!.bbox.minLng).toBeGreaterThan(34);
  });

  it('renders areas as ITM WKT with escaped tooltips, and only re-renders what changed', async () => {
    const { api, engine } = await mounted();
    engine.renderAreas([area()]);
    await flush();
    const display = api.calls.filter((c) => c.method === 'displayGeometries');
    expect(display).toHaveLength(1);
    const opts = display[0]!.args[0] as { wkts: string[]; names: string[]; data: { tooltips: string[] } };
    expect(opts.names).toEqual(['area-a1']);
    expect(opts.data.tooltips[0]).toBe('Field &lt;b&gt;');
    const back = t.ringItmToWgs84(WktCodec.parsePolygonOuterRing(opts.wkts[0]!));
    expect(back[0]![0]).toBeCloseTo(34.78, 6);
    expect(back[0]![1]).toBeCloseTo(32.08, 6);

    engine.renderAreas([area()]); // identical → no calls
    expect(api.calls.filter((c) => c.method === 'displayGeometries')).toHaveLength(1);

    engine.renderAreas([area({ selected: true })]); // style change → replace
    expect(api.calls.filter((c) => c.method === 'clearGeometriesByName').at(-1)!.args[0]).toEqual(['area-a1']);
    expect(api.calls.filter((c) => c.method === 'displayGeometries')).toHaveLength(2);

    engine.renderAreas([]); // removal
    expect(api.geometries.size).toBe(0);
  });

  it('streams sketch progress from clicks during govmap draw and emits the completed ring in WGS84', async () => {
    const { api, engine } = await mounted();
    const progress: number[] = [];
    let completed: LngLat[] | null = null;
    engine.on('sketchChange', (s) => progress.push(s.vertexCount));
    engine.on('drawComplete', (ring) => (completed = ring));
    engine.startDrawing();
    for (const p of [[34.78, 32.08], [34.79, 32.08], [34.79, 32.09]] as LngLat[]) api.click(t.wgs84ToItm(p));
    expect(progress).toEqual([1, 2, 3]);
    api.completeDraw();
    await flush();
    expect(completed).not.toBeNull();
    expect(completed!).toHaveLength(4);
    expect(completed![0]![0]).toBeCloseTo(34.78, 6);
    expect(engine.isDrawing()).toBe(false);
  });

  it('can finish from the toolbar using the tracked vertices', async () => {
    const { api, engine } = await mounted();
    const done = vi.fn();
    engine.on('drawComplete', done);
    engine.startDrawing();
    for (const p of [[34.78, 32.08], [34.79, 32.08], [34.79, 32.09]] as LngLat[]) api.click(t.wgs84ToItm(p));
    engine.finishDrawing();
    expect(done).toHaveBeenCalledOnce();
    expect(api.calls.map((c) => c.method)).toContain('clearDrawings');
  });

  it('cancels drawing', async () => {
    const { engine } = await mounted();
    const cancelled = vi.fn();
    engine.on('drawCancel', cancelled);
    engine.startDrawing();
    engine.cancelDrawing();
    expect(cancelled).toHaveBeenCalledOnce();
    expect(engine.isDrawing()).toBe(false);
  });

  it('hit-tests clicks against rendered areas', async () => {
    const { api, engine } = await mounted();
    const clicked = vi.fn();
    engine.on('areaClick', clicked);
    engine.renderAreas([area()]);
    api.click(t.wgs84ToItm([34.785, 32.085]));
    api.click(t.wgs84ToItm([34.8, 32.1]));
    expect(clicked).toHaveBeenCalledTimes(1);
    expect(clicked).toHaveBeenCalledWith('a1');
  });

  it('switches background without touching geometry positions', async () => {
    const { api, engine } = await mounted();
    const changed = vi.fn();
    engine.on('baseLayerChange', changed);
    engine.renderAreas([area()]);
    await flush();
    const wktBefore = api.geometries.get('area-a1')!.wkt;
    await engine.setBaseLayer('govmap-street');
    expect(api.background).toBe(0);
    expect(api.geometries.get('area-a1')!.wkt).toBe(wktBefore);
    expect(changed).toHaveBeenCalledWith('govmap-street');
  });

  it('edits by redrawing: stopEditing(true) returns the new ring', async () => {
    const { api, engine } = await mounted();
    engine.renderAreas([area()]);
    engine.startEditing(area());
    expect(api.geometries.has('area-a1')).toBe(false); // hidden while editing
    for (const p of [[34.7, 32.0], [34.72, 32.0], [34.72, 32.02]] as LngLat[]) api.click(t.wgs84ToItm(p));
    api.completeDraw();
    await flush();
    const ring = engine.stopEditing(true);
    expect(ring).toHaveLength(4);
    expect(api.geometries.has('area-a1')).toBe(true);
  });

  it('maps resolutions to govmap levels', () => {
    expect(GovmapEngine.levelFor(800)).toBe(0);
    expect(GovmapEngine.levelFor(13)).toBe(5);
    expect(GovmapEngine.levelFor(1)).toBe(8);
    expect(GovmapEngine.levelFor(0.01)).toBe(11);
  });

  it('pointInRing', () => {
    const ring = square.coordinates[0];
    expect(pointInRing([34.785, 32.085], ring)).toBe(true);
    expect(pointInRing([34.795, 32.085], ring)).toBe(false);
  });
});
