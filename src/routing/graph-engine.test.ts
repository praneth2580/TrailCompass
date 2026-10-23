import { describe, expect, it } from 'vitest';
import demoNetworkRaw from '../../public/assets/routing/demo-network.geojson?raw';
import type { Coordinate } from './routing-adapter';
import { haversineMeters } from './geo';
import {
  OfflineGraphEngine,
  type NetworkFeatureCollection,
} from './graph-engine';
import { minCostPerMeter } from './routing-profiles';

function network(
  features: Array<{ highway: string; coordinates: Coordinate[] }>,
): NetworkFeatureCollection {
  return {
    type: 'FeatureCollection',
    features: features.map((f, i) => ({
      type: 'Feature',
      properties: { highway: f.highway, osm_id: i + 1 },
      geometry: { type: 'LineString', coordinates: f.coordinates },
    })),
  };
}

describe('minCostPerMeter', () => {
  it('matches the cheapest class in each cost table', () => {
    expect(minCostPerMeter('shortest')).toBe(1);
    expect(minCostPerMeter('fastest')).toBeCloseTo(10 / 28);
    expect(minCostPerMeter('less_traffic')).toBe(0.85);
  });
});

describe('OfflineGraphEngine A*', () => {
  // Start and goal ~1 km apart on the equator. A direct residential street
  // and a ~1.7 km motorway detour. Under "fastest" the motorway is cheaper
  // (~596 vs ~1113), but its first node looked worse to the old unscaled
  // straight-line heuristic, so the search used to settle on the street.
  const start: Coordinate = [0, 0];
  const goal: Coordinate = [0.009, 0];
  const detour: Coordinate = [0.0045, 0.006];
  const engine = new OfflineGraphEngine();
  engine.loadFeatureCollection(
    network([
      { highway: 'residential', coordinates: [start, goal] },
      { highway: 'motorway', coordinates: [start, detour, goal] },
    ]),
  );

  it('finds the cheaper motorway detour for "fastest"', () => {
    const route = engine.calculateRoute(start, goal, { profile: 'fastest' });
    expect(route.coordinates).toContainEqual(detour);
  });

  it('takes the direct street for "shortest"', () => {
    const route = engine.calculateRoute(start, goal, { profile: 'shortest' });
    expect(route.coordinates).toEqual([start, goal]);
  });
});

describe('OfflineGraphEngine snapping', () => {
  const demo = JSON.parse(demoNetworkRaw) as NetworkFeatureCollection;
  const engine = new OfflineGraphEngine();
  engine.loadFeatureCollection(demo);

  const allCoordinates = demo.features.flatMap((f) =>
    f.geometry.type === 'LineString'
      ? (f.geometry.coordinates as Coordinate[])
      : [],
  );

  function bruteForceNearest(point: Coordinate): number {
    return Math.min(...allCoordinates.map((c) => haversineMeters(point, c)));
  }

  it('grid snap matches a full scan across and around the demo area', () => {
    // bbox 2.294–2.305 E, 48.856–48.8625 N, sampled with a margin outside it.
    for (let lon = 2.285; lon <= 2.314; lon += 0.0017) {
      for (let lat = 48.85; lat <= 48.868; lat += 0.0013) {
        const point: Coordinate = [lon, lat];
        const snapped = engine.nearestRoadCoordinate(point, 5_000);
        expect(snapped).not.toBeNull();
        // Segments under 0.2 m are skipped as nodes, hence the tolerance.
        expect(haversineMeters(point, snapped!)).toBeCloseTo(
          bruteForceNearest(point),
          0,
        );
      }
    }
  });

  it('returns null beyond the snap limit', () => {
    expect(engine.nearestRoadCoordinate([2.9, 48.86], 5_000)).toBeNull();
  });
});
