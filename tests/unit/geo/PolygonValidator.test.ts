import { describe, expect, it } from 'vitest';
import { PolygonValidator } from '@/lib/geo/PolygonValidator';

const v = new PolygonValidator();
const poly = (coords: number[][]) => ({ type: 'Polygon', coordinates: [coords] });
const square = [[34.78, 32.08], [34.79, 32.08], [34.79, 32.09], [34.78, 32.09], [34.78, 32.08]];

describe('PolygonValidator', () => {
  it('accepts a simple square and reports geodesic area', () => {
    const r = v.validate(poly(square));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.vertexCount).toBe(4);
      expect(r.areaSqKm).toBeCloseTo(1.04685, 4);
    }
  });

  it('closes open rings, drops duplicates, orients counter-clockwise', () => {
    const clockwiseOpen = [[34.78, 32.08], [34.78, 32.09], [34.78, 32.09], [34.79, 32.09], [34.79, 32.08]];
    const r = v.validate(poly(clockwiseOpen));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ring = r.polygon.coordinates[0];
    expect(ring).toHaveLength(5);
    expect(ring[0]).toEqual(ring[4]);
    expect(PolygonValidator.signedArea(ring)).toBeGreaterThan(0);
  });

  it('rounds to 7 decimals', () => {
    const r = v.validate(poly([[34.781234567, 32.08], [34.79, 32.08], [34.79, 32.09]]));
    expect(r.ok && r.polygon.coordinates[0][0]![0]).toBe(34.7812346);
  });

  it.each([
    ['not an object', null, 'NOT_POLYGON'],
    ['wrong type', { type: 'LineString', coordinates: [] }, 'NOT_POLYGON'],
    ['holes', { type: 'Polygon', coordinates: [square, square] }, 'HOLES_NOT_SUPPORTED'],
    ['NaN coordinate', poly([[NaN, 1], [2, 2], [3, 1]]), 'INVALID_COORDINATE'],
    ['string coordinate', poly([['1', 1], [2, 2], [3, 1]] as unknown as number[][]), 'INVALID_COORDINATE'],
    ['latitude out of range', poly([[1, 91], [2, 2], [3, 1]]), 'INVALID_COORDINATE'],
    ['two vertices', poly([[1, 1], [2, 2], [1, 1]]), 'TOO_FEW_VERTICES'],
  ])('rejects %s', (_label, input, code) => {
    const r = v.validate(input);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.map((i) => i.code)).toContain(code);
  });

  it('rejects a bow-tie (self-intersection)', () => {
    const r = v.validate(poly([[0, 0], [1, 1], [1, 0], [0, 1], [0, 0]]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues[0]!.code).toBe('SELF_INTERSECTION');
  });

  it('rejects a zero-width spike (collinear fold-back)', () => {
    const r = v.validate(poly([[0, 0], [1, 0], [2, 0], [1, 0.0], [1, 1], [0, 0]]));
    expect(r.ok).toBe(false);
  });

  it('rejects collinear (zero area) rings', () => {
    const r = v.validate(poly([[0, 0], [1, 0], [2, 0], [0, 0]]));
    expect(r.ok).toBe(false);
  });

  it('rejects too many vertices', () => {
    const small = new PolygonValidator({ maxVertices: 5 });
    const ring = Array.from({ length: 8 }, (_, i) => [Math.cos(i) * 0.01, Math.sin(i) * 0.01]);
    const r = small.validate(poly(ring));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues[0]!.code).toBe('TOO_MANY_VERTICES');
  });

  it('enforces optional bounds and max area', () => {
    const israel = new PolygonValidator({ bounds: { minLng: 34, minLat: 29, maxLng: 36, maxLat: 34 } });
    expect(israel.validate(poly(square)).ok).toBe(true);
    expect(israel.validate(poly([[0, 0], [0.1, 0], [0.1, 0.1]])).ok).toBe(false);
    const tiny = new PolygonValidator({ maxAreaSqKm: 0.5 });
    expect(tiny.validate(poly(square)).ok).toBe(false);
  });

  it('rejects polygons wider than 180° of longitude', () => {
    const r = v.validate(poly([[-170, 0], [170, 0], [170, 1], [-170, 1]]));
    expect(r.ok).toBe(false);
  });
});
