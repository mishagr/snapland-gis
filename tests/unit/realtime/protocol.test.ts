import { describe, expect, it } from 'vitest';
import { clientMessageSchema, MAX_SKETCH_POINTS } from '@/lib/realtime/protocol';

describe('clientMessageSchema', () => {
  it('accepts every client message type', () => {
    for (const msg of [
      { type: 'viewport', bbox: { minLng: 34, minLat: 31, maxLng: 35, maxLat: 32 } },
      { type: 'sketch', points: [[34.1, 31.1], [34.2, 31.2]], areaSqKm: 0 },
      { type: 'sketch:end' },
      { type: 'editing', areaId: '4f1c1b9e-2b8e-4a55-9a36-1b1f1d9f2c11' },
      { type: 'editing', areaId: null },
      { type: 'ping', t: 1 },
    ]) {
      expect(clientMessageSchema.safeParse(msg).success).toBe(true);
    }
  });

  it.each([
    ['unknown type', { type: 'hack' }],
    ['inverted bbox', { type: 'viewport', bbox: { minLng: 35, minLat: 31, maxLng: 34, maxLat: 32 } }],
    ['out of range point', { type: 'sketch', points: [[200, 0]], areaSqKm: 0 }],
    ['too many points', { type: 'sketch', points: Array.from({ length: MAX_SKETCH_POINTS + 1 }, () => [0, 0]), areaSqKm: 0 }],
    ['non-uuid area', { type: 'editing', areaId: 'x' }],
  ])('rejects %s', (_label, msg) => {
    expect(clientMessageSchema.safeParse(msg).success).toBe(false);
  });
});
