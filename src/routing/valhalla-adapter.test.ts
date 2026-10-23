import { describe, expect, it, vi } from 'vitest';
import type { Coordinate } from './routing-adapter';

/** Encode [lon, lat] pairs as a precision-6 polyline (Valhalla's format). */
function encodePolyline6(coordinates: Coordinate[]): string {
  let out = '';
  let prevLat = 0;
  let prevLon = 0;
  const encodeValue = (value: number) => {
    let v = value < 0 ? ~(value << 1) : value << 1;
    while (v >= 0x20) {
      out += String.fromCharCode((0x20 | (v & 0x1f)) + 63);
      v >>= 5;
    }
    out += String.fromCharCode(v + 63);
  };
  for (const [lon, lat] of coordinates) {
    const latE6 = Math.round(lat * 1e6);
    const lonE6 = Math.round(lon * 1e6);
    encodeValue(latE6 - prevLat);
    encodeValue(lonE6 - prevLon);
    prevLat = latE6;
    prevLon = lonE6;
  }
  return out;
}

const start: Coordinate = [2.3, 48.86];
const stop: Coordinate = [2.31, 48.86];
const end: Coordinate = [2.31, 48.87];

vi.mock('@jansoft/mbujkanji-valhalla-wasm', () => ({
  createRouter: () => ({
    init: async () => {},
    loadTiles: async () => {},
    loadTilesFromUrl: async () => {},
    route: async () => ({
      trip: {
        summary: { length: 1.85, time: 200 },
        legs: [
          {
            shape: encodePolyline6([start, stop]),
            summary: { length: 0.73, time: 80 },
            maneuvers: [
              { instruction: 'Head east', length: 0.73, type: 1 },
              { instruction: 'You have arrived at your stop', length: 0, type: 5 },
            ],
          },
          {
            shape: encodePolyline6([stop, end]),
            summary: { length: 1.12, time: 120 },
            maneuvers: [
              { instruction: 'Head north', length: 1.12, type: 1 },
              { instruction: 'You have arrived', length: 0, type: 4 },
            ],
          },
        ],
      },
    }),
  }),
}));

describe('ValhallaOfflineAdapter', () => {
  it('keeps every leg of a route with stops', async () => {
    const { ValhallaOfflineAdapter } = await import('./valhalla-adapter');
    const adapter = new ValhallaOfflineAdapter();
    expect(await adapter.tryInitialize('tiles.tar')).toBe(true);

    const route = await adapter.calculateRoute(start, end, [stop]);

    // Shared joint point appears once.
    expect(route.coordinates).toHaveLength(3);
    expect(route.coordinates[0]![0]).toBeCloseTo(start[0], 6);
    expect(route.coordinates[2]![1]).toBeCloseTo(end[1], 6);
    expect(route.distanceMeters).toBeCloseTo(1850);
    expect(route.durationSeconds).toBe(200);
    expect(route.instructions.map((i) => i.text)).toEqual([
      'Head east',
      'You have arrived at your stop',
      'Head north',
      'You have arrived',
    ]);
  });
});
