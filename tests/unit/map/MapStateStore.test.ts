import { describe, expect, it, vi } from 'vitest';
import type { AreaDto } from '@/lib/api/types';
import { MapStateStore } from '@/lib/map/MapStateStore';

function dto(id: string, version: number, ring: [number, number][], extra: Partial<AreaDto> = {}): AreaDto {
  return {
    id, ownerId: 'o', ownerName: 'O', name: id, description: '', areaSqKm: 1, vertexCount: ring.length - 1, version,
    createdAt: '', updatedAt: '', updatedById: 'o', updatedByName: 'O', deletedAt: null,
    geometry: { type: 'Polygon', coordinates: [ring] }, simplified: false, ...extra,
  };
}
const sq = (x: number, y: number): [number, number][] => [[x, y], [x + 0.01, y], [x + 0.01, y + 0.01], [x, y + 0.01], [x, y]];
const newStore = () => new MapStateStore({ engine: 'leaflet', view: { center: [0, 0], resolution: 10 } });

describe('MapStateStore', () => {
  it('notifies subscribers with a new immutable snapshot', () => {
    const store = newStore();
    const listener = vi.fn();
    store.subscribe(listener);
    const before = store.getState();
    store.upsertArea(dto('a', 1, sq(0, 0)));
    expect(listener).toHaveBeenCalledOnce();
    expect(store.getState()).not.toBe(before);
    expect(before.areas.size).toBe(0);
  });

  it('ignores stale (out-of-order) versions and simplified copies of full geometry', () => {
    const store = newStore();
    store.upsertArea(dto('a', 3, sq(0, 0), { name: 'v3' }));
    store.upsertArea(dto('a', 2, sq(0, 0), { name: 'v2' }));
    expect(store.getState().areas.get('a')!.name).toBe('v3');
    store.upsertArea(dto('a', 3, sq(0, 0), { name: 'v3s', simplified: true }));
    expect(store.getState().areas.get('a')!.simplified).toBe(false);
  });

  it('removes deleted areas and clears the selection', () => {
    const store = newStore();
    store.upsertArea(dto('a', 1, sq(0, 0)));
    store.update({ selectedId: 'a' });
    store.upsertArea(dto('a', 2, sq(0, 0), { deletedAt: 'now' }));
    expect(store.getState().areas.has('a')).toBe(false);
    expect(store.getState().selectedId).toBeNull();
  });

  it('mergeViewport drops areas missing from a complete result, keeps them when truncated', () => {
    const store = newStore();
    store.upsertArea(dto('gone', 1, sq(0, 0)));
    store.upsertArea(dto('far', 1, sq(10, 10)));
    const q = { minLng: -1, minLat: -1, maxLng: 1, maxLat: 1 };
    store.mergeViewport(q, [dto('new', 1, sq(0.5, 0.5))], true, { minLng: -20, minLat: -20, maxLng: 20, maxLat: 20 });
    expect([...store.getState().areas.keys()].sort()).toEqual(['far', 'gone', 'new']);
    store.mergeViewport(q, [dto('new', 1, sq(0.5, 0.5))], false, { minLng: -2, minLat: -2, maxLng: 2, maxLat: 2 });
    // "gone" was inside the complete query but not returned → deleted; "far" is outside the keep box → pruned.
    expect([...store.getState().areas.keys()]).toEqual(['new']);
  });

  it('tracks presence and drops sketches of users who leave', () => {
    const store = newStore();
    const user = { userId: 'u', displayName: 'U', color: '#000', connections: 1, editingAreaId: null, drawing: true };
    store.upsertPresence(user);
    store.setRemoteSketch({ userId: 'u', displayName: 'U', color: '#000', points: [[0, 0]], areaSqKm: 0 }, 'u');
    store.upsertPresence(user, true);
    expect(store.getState().presence.size).toBe(0);
    expect(store.getState().remoteSketches.size).toBe(0);
  });
});
