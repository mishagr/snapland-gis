import { describe, expect, it } from 'vitest';
import { CoordinateTransformer } from '@/lib/geo/CoordinateTransformer';

const t = new CoordinateTransformer();

describe('CoordinateTransformer', () => {
  // Reference values from PostGIS 3.4 / PROJ 9.4 (ST_Transform). PostGIS uses a
  // 3-parameter datum shift, we use the 7-parameter one: they agree to ~1 m.
  it('matches PostGIS for WGS84 -> ITM (Tel Aviv)', () => {
    const p = t.wgs84ToItm([34.7818, 32.0853]);
    expect(p.x).toBeCloseTo(179556.03, -1); // within 5 m
    expect(p.y).toBeCloseTo(665855.39, -1);
    expect(Math.hypot(p.x - 179556.03, p.y - 665855.39)).toBeLessThan(3);
  });

  it('matches PostGIS for ITM -> WGS84', () => {
    const [lng, lat] = t.itmToWgs84({ x: 192900, y: 704933 });
    expect(Math.abs(lng - 34.92205437) * 94_000).toBeLessThan(3); // ~94 km per degree of lng at 32°N
    expect(Math.abs(lat - 32.43807935) * 111_000).toBeLessThan(3);
  });

  it('round-trips with sub-millimetre error', () => {
    for (const p of [
      { x: 150000, y: 400000 },
      { x: 219529.584, y: 626907.39 },
      { x: 260000, y: 780000 },
    ]) {
      const back = t.wgs84ToItm(t.itmToWgs84(p));
      expect(Math.hypot(back.x - p.x, back.y - p.y)).toBeLessThan(1e-3);
    }
  });

  it('converts an ITM extent to a covering WGS84 bbox (all four corners)', () => {
    const extent = { xmin: 170000, ymin: 650000, xmax: 190000, ymax: 670000 };
    const bbox = t.itmExtentToBBox(extent);
    for (const corner of [
      { x: extent.xmin, y: extent.ymin },
      { x: extent.xmax, y: extent.ymax },
      { x: extent.xmin, y: extent.ymax },
      { x: extent.xmax, y: extent.ymin },
    ]) {
      const [lng, lat] = t.itmToWgs84(corner);
      expect(lng).toBeGreaterThanOrEqual(bbox.minLng);
      expect(lng).toBeLessThanOrEqual(bbox.maxLng);
      expect(lat).toBeGreaterThanOrEqual(bbox.minLat);
      expect(lat).toBeLessThanOrEqual(bbox.maxLat);
    }
    const back = t.bboxToItmExtent(bbox);
    expect(back.xmin).toBeLessThanOrEqual(extent.xmin + 1);
    expect(back.ymax).toBeGreaterThanOrEqual(extent.ymax - 1);
  });
});
