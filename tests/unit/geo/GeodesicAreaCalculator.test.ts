import { describe, expect, it } from 'vitest';
import { GeodesicAreaCalculator, formatArea } from '@/lib/geo/GeodesicAreaCalculator';
import type { LngLat } from '@/lib/geo/types';

const calc = new GeodesicAreaCalculator();

describe('GeodesicAreaCalculator', () => {
  // Reference: PostGIS ST_Area(geography) (GeographicLib) on the same polygons.
  it('matches PostGIS for a 1°x1° cell at 31°N', () => {
    const ring: LngLat[] = [[34, 31], [35, 31], [35, 32], [34, 32], [34, 31]];
    expect(calc.areaSqKm(ring)).toBeCloseTo(10533.59204602826, 6);
  });

  it('matches PostGIS for a ~1 km² square in Tel Aviv', () => {
    const ring: LngLat[] = [[34.78, 32.08], [34.79, 32.08], [34.79, 32.09], [34.78, 32.09]];
    expect(calc.areaSqMeters(ring)).toBeCloseTo(1046850.557182312, 3);
  });

  it('is orientation-independent and accepts open or closed rings', () => {
    const ccw: LngLat[] = [[0, 0], [0.01, 0], [0.01, 0.01], [0, 0.01]];
    const cw = [...ccw].reverse();
    expect(calc.areaSqMeters(ccw)).toBeCloseTo(calc.areaSqMeters(cw), 6);
    expect(calc.areaSqMeters([...ccw, ccw[0]!])).toBeCloseTo(calc.areaSqMeters(ccw), 6);
  });

  it('shows why planar math is wrong: equal-degree cells shrink towards the poles', () => {
    const cell = (lat: number): LngLat[] => [[0, lat], [1, lat], [1, lat + 1], [0, lat + 1]];
    expect(calc.areaSqKm(cell(0))).toBeGreaterThan(calc.areaSqKm(cell(60)) * 1.9);
  });

  it('returns 0 for degenerate input', () => {
    expect(calc.areaSqMeters([])).toBe(0);
    expect(calc.areaSqMeters([[1, 1], [2, 2]])).toBe(0);
  });

  it('measures open paths and perimeters', () => {
    const path: LngLat[] = [[34.78, 32.08], [34.79, 32.08]];
    expect(calc.lengthMeters(path, false)).toBeGreaterThan(940);
    expect(calc.lengthMeters(path, false)).toBeLessThan(950);
  });

  it('formats areas for display', () => {
    expect(formatArea(0.0012)).toBe('1,200 m²');
    expect(formatArea(1.23456)).toBe('1.235 km²');
    expect(formatArea(10533.59)).toBe('10,533.6 km²');
  });
});
