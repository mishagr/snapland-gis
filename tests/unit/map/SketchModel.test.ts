import { describe, expect, it } from 'vitest';
import { SketchModel } from '@/lib/map/SketchModel';

describe('SketchModel', () => {
  it('adds vertices, ignores exact duplicates, undoes', () => {
    const m = new SketchModel();
    expect(m.add([0, 0])).toBe(true);
    expect(m.add([0, 0])).toBe(false);
    m.add([0.01, 0]);
    m.undo();
    expect(m.vertices).toEqual([[0, 0]]);
  });

  it('reports live geodesic area including the hover point, and vertexCount without it', () => {
    const m = new SketchModel();
    m.add([34.78, 32.08]);
    m.add([34.79, 32.08]);
    m.setHover([34.79, 32.09]);
    const p = m.progress();
    expect(p.vertexCount).toBe(2);
    expect(p.points).toHaveLength(3);
    expect(p.areaSqKm).toBeGreaterThan(0.5);
    expect(m.progress(false).areaSqKm).toBe(0);
  });

  it('only closes into a valid simple ring', () => {
    const m = new SketchModel();
    m.add([0, 0]);
    m.add([1, 1]);
    expect(m.toRing()).toEqual({ ok: false, reason: 'Place at least 3 points' });
    m.add([1, 0]);
    m.add([0, 1]); // bow-tie
    expect(m.toRing().ok).toBe(false);
    m.undo();
    const r = m.toRing();
    expect(r.ok && r.ring).toEqual([[0, 0], [1, 1], [1, 0], [0, 0]]);
  });
});
