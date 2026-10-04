import { describe, expect, it } from 'vitest';
import { BBoxUtil } from '@/lib/geo/BBoxUtil';

describe('BBoxUtil', () => {
  it('parses valid bbox strings and rejects bad ones', () => {
    expect(BBoxUtil.parse('34.7,32.0,34.9,32.2')).toEqual({ minLng: 34.7, minLat: 32, maxLng: 34.9, maxLat: 32.2 });
    expect(BBoxUtil.parse('34.9,32.0,34.7,32.2')).toBeNull(); // inverted
    expect(BBoxUtil.parse('1,2,3')).toBeNull();
    expect(BBoxUtil.parse('a,b,c,d')).toBeNull();
    expect(BBoxUtil.parse('-181,0,1,1')).toBeNull();
    expect(BBoxUtil.parse(null)).toBeNull();
  });

  it('quantizes outward so the result always covers the input', () => {
    const b = { minLng: 34.7812, minLat: 32.0853, maxLng: 34.8123, maxLat: 32.1011 };
    const q = BBoxUtil.quantizeOutward(b, 0.05);
    expect(BBoxUtil.contains(q, b)).toBe(true);
    expect(q).toEqual({ minLng: 34.75, minLat: 32.05, maxLng: 34.85, maxLat: 32.15 });
  });

  it('detects intersection', () => {
    const a = { minLng: 0, minLat: 0, maxLng: 1, maxLat: 1 };
    expect(BBoxUtil.intersects(a, { minLng: 0.5, minLat: 0.5, maxLng: 2, maxLat: 2 })).toBe(true);
    expect(BBoxUtil.intersects(a, { minLng: 1.5, minLat: 0, maxLng: 2, maxLat: 1 })).toBe(false);
  });

  it('builds a bbox from positions and pads it', () => {
    const b = BBoxUtil.fromPositions([[1, 2], [3, 5], [2, 1]]);
    expect(b).toEqual({ minLng: 1, minLat: 1, maxLng: 3, maxLat: 5 });
    expect(BBoxUtil.pad(b, 0.5)).toEqual({ minLng: 0, minLat: -1, maxLng: 4, maxLat: 7 });
  });
});
