import { describe, expect, it } from 'vitest';
import { GovmapClient } from '@/lib/govmap/GovmapClient';
import { MockGovmap } from '@/lib/govmap/MockGovmap';

describe('GovmapClient', () => {
  it('creates the map with the token and resolves once govmap reports load', async () => {
    const api = new MockGovmap();
    const client = new GovmapClient(api);
    await client.createMap('map', { token: 'abc', center: { x: 1, y: 2 }, level: 3 });
    const call = api.calls.find((c) => c.method === 'createMap')!;
    expect(call.args[0]).toBe('map');
    expect(call.args[1]).toMatchObject({ token: 'abc', center: { x: 1, y: 2 }, level: 3 });
  });

  it('rejects when govmap throws (e.g. missing token)', async () => {
    const client = new GovmapClient(new MockGovmap());
    await expect(client.createMap('map', { token: '' })).rejects.toThrow('token');
  });

  it('turns the draw deferred into a promise of WKT', async () => {
    const api = new MockGovmap();
    const client = new GovmapClient(api);
    const result = client.drawPolygon();
    expect(api.calls.at(-1)).toEqual({ method: 'draw', args: ['polygon'] });
    api.click({ x: 0, y: 0 });
    api.click({ x: 100, y: 0 });
    api.click({ x: 100, y: 100 });
    api.completeDraw();
    await expect(result).resolves.toBe('POLYGON((0.00 0.00, 100.00 0.00, 100.00 100.00, 0.00 0.00))');
  });

  it('resolves null when the draw is cancelled and resets the govmap tool', async () => {
    const api = new MockGovmap();
    const client = new GovmapClient(api);
    const result = client.drawPolygon();
    client.cancelDraw();
    await expect(result).resolves.toBeNull();
    expect(api.calls.map((c) => c.method)).toEqual(expect.arrayContaining(['setDefaultTool', 'clearDrawings']));
  });

  it('a new draw supersedes a pending one', async () => {
    const api = new MockGovmap();
    const client = new GovmapClient(api);
    const first = client.drawPolygon();
    const second = client.drawPolygon();
    await expect(first).resolves.toBeNull();
    api.click({ x: 0, y: 0 });
    api.click({ x: 10, y: 0 });
    api.click({ x: 10, y: 10 });
    api.completeDraw();
    await expect(second).resolves.toMatch(/^POLYGON/);
  });

  it('binds each govmap event once and fans it out to all subscribers', () => {
    const api = new MockGovmap();
    const client = new GovmapClient(api);
    const got: number[] = [];
    const off = client.onClick(() => got.push(1));
    client.onClick(() => got.push(2));
    api.click({ x: 5, y: 5 });
    off();
    api.click({ x: 5, y: 5 });
    expect(got).toEqual([1, 2, 2]);
    expect(api.calls.filter((c) => c.method === 'onEvent')).toHaveLength(1);
  });

  it('skips displayGeometries when there is nothing to draw', async () => {
    const api = new MockGovmap();
    await new GovmapClient(api).displayGeometries({ wkts: [], names: [], geometryType: 'polygon' });
    expect(api.calls).toHaveLength(0);
  });
});
