import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Coordinate } from './routing-adapter';
import type { NetworkFeatureCollection } from './graph-engine';

const mocks = vi.hoisted(() => ({
  loadBackboneNetwork: vi.fn(),
  loadLocalArea: vi.fn(),
  loadOsmNetworkForRoute: vi.fn(),
}));

vi.mock('./backbone-loader', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./backbone-loader')>()),
  loadBackboneNetwork: mocks.loadBackboneNetwork,
}));

vi.mock('./osm-network-loader', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./osm-network-loader')>()),
  loadLocalArea: mocks.loadLocalArea,
  loadOsmNetworkForRoute: mocks.loadOsmNetworkForRoute,
}));

const { OfflineRoutingAdapter } = await import('./offline-adapter');

function road(
  id: number,
  highway: string,
  coordinates: Coordinate[],
): NetworkFeatureCollection['features'][number] {
  return {
    type: 'Feature',
    properties: { highway, osm_id: id },
    geometry: { type: 'LineString', coordinates },
  };
}

function collection(
  features: NetworkFeatureCollection['features'],
): NetworkFeatureCollection {
  return { type: 'FeatureCollection', features };
}

// ~111 km trip along the equator. The only road leaves the straight line
// and loops ~33 km north (think inland highway around a creek), so a
// straight-line corridor never connects.
const start: Coordinate = [0, 0];
const end: Coordinate = [1, 0];
const inlandWest: Coordinate = [0, 0.3];
const inlandEast: Coordinate = [1, 0.3];

describe('OfflineRoutingAdapter long trips', () => {
  beforeEach(() => {
    vi.stubGlobal('window', globalThis);
    // No Valhalla tiles, no demo network.
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    mocks.loadBackboneNetwork.mockResolvedValue(
      collection([road(1, 'trunk', [start, inlandWest, inlandEast, end])]),
    );
    mocks.loadLocalArea.mockImplementation(async (point: Coordinate) =>
      collection([
        road(100 + point[0], 'residential', [
          point,
          [point[0] + 0.001, point[1]],
        ]),
      ]),
    );
  });

  it('routes through the backbone when detail legs refine cleanly', async () => {
    mocks.loadOsmNetworkForRoute.mockImplementation(
      async (
        _from: Coordinate,
        _to: Coordinate,
        _wps: Coordinate[],
        _progress: unknown,
        _signal: unknown,
        options: { guide?: Coordinate[] } = {},
      ) => collection([road(200, 'primary', options.guide ?? [])]),
    );
    const adapter = new OfflineRoutingAdapter();
    const route = await adapter.calculateRoute(start, end, {
      profile: 'fastest',
    });

    expect(route.coordinates).toContainEqual(inlandWest);
    expect(route.coordinates).toContainEqual(inlandEast);
    // 33 + 111 + 33 km along the road, not the 111 km straight line.
    expect(route.distanceMeters).toBeGreaterThan(170_000);
    // Detail corridors follow the backbone path, not the straight line.
    const guides = mocks.loadOsmNetworkForRoute.mock.calls.map(
      (call) => (call[5] as { guide?: Coordinate[] } | undefined)?.guide,
    );
    expect(guides.every((g) => g && g.length >= 2)).toBe(true);
    expect(guides.flat()).toContainEqual(inlandWest);
  });

  it('keeps the backbone path for a leg whose detail download fails', async () => {
    mocks.loadOsmNetworkForRoute.mockRejectedValue(new Error('Overpass down'));
    const adapter = new OfflineRoutingAdapter();
    const route = await adapter.calculateRoute(start, end);
    expect(route.coordinates).toContainEqual(inlandWest);
    expect(route.durationSeconds).toBeGreaterThan(0);
  });
});
