import { describe, expect, it } from 'vitest';
import { WktCodec, WktParseError } from '@/lib/geo/WktCodec';

describe('WktCodec', () => {
  it('parses a govmap-style polygon (outer ring only)', () => {
    const ring = WktCodec.parsePolygonOuterRing('POLYGON((178000 665000, 179000 665000,179000 666000, 178000 665000))');
    expect(ring).toEqual([
      { x: 178000, y: 665000 },
      { x: 179000, y: 665000 },
      { x: 179000, y: 666000 },
      { x: 178000, y: 665000 },
    ]);
  });

  it('ignores holes and Z values', () => {
    const ring = WktCodec.parsePolygonOuterRing('POLYGON Z ((0 0 5, 10 0 5, 10 10 5, 0 0 5), (1 1 0, 2 1 0, 2 2 0, 1 1 0))');
    expect(ring).toHaveLength(4);
    expect(ring[1]).toEqual({ x: 10, y: 0 });
  });

  it('formats closed polygons and points', () => {
    expect(WktCodec.formatPolygon([{ x: 1, y: 2 }, { x: 3, y: 4 }, { x: 5, y: 2 }], 0)).toBe('POLYGON((1 2, 3 4, 5 2, 1 2))');
    expect(WktCodec.formatPoint({ x: 1.234, y: 5.678 }, 1)).toBe('POINT(1.2 5.7)');
    expect(WktCodec.parsePoint('POINT (10 20)')).toEqual({ x: 10, y: 20 });
  });

  it('throws on malformed input', () => {
    expect(() => WktCodec.parsePolygonOuterRing('LINESTRING(0 0, 1 1)')).toThrow(WktParseError);
    expect(() => WktCodec.parsePolygonOuterRing('POLYGON((0 0, a b))')).toThrow(WktParseError);
  });
});
