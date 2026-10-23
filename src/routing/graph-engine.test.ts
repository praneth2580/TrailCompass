import { describe, expect, it } from 'vitest';
import demoNetworkRaw from '../../public/assets/routing/demo-network.geojson?raw';
import type { Coordinate } from './routing-adapter';
import { haversineMeters } from './geo';
import {
  NoRoadPathError,
  OfflineGraphEngine,
  type NetworkFeatureCollection,
} from './graph-engine';
import type { NetworkControl, RoadTags } from './road-attributes';
import { MAX_SPEED_MPS, minCostPerMeter } from './routing-profiles';

function network(
  features: Array<{
    highway: string;
    coordinates: Coordinate[];
    tags?: RoadTags;
    id?: number;
  }>,
  extra: Partial<NetworkFeatureCollection> = {},
): NetworkFeatureCollection {
  return {
    type: 'FeatureCollection',
    features: features.map((f, i) => ({
      type: 'Feature',
      properties: { highway: f.highway, osm_id: f.id ?? i + 1, tags: f.tags },
      geometry: { type: 'LineString', coordinates: f.coordinates },
    })),
    ...extra,
  };
}

function signal(coordinate: Coordinate): NetworkControl {
  return { coordinate, kind: 'traffic_signals' };
}

describe('minCostPerMeter', () => {
  it('matches the cheapest class in each cost table', () => {
    expect(minCostPerMeter('shortest')).toBe(1);
    expect(minCostPerMeter('fastest')).toBeCloseTo(10 / MAX_SPEED_MPS);
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

  it('finds the cheaper motorway detour for "fastest" when allowed', () => {
    const route = engine.calculateRoute(start, goal, {
      profile: 'fastest',
      allowExpressways: true,
    });
    expect(route.coordinates).toContainEqual(detour);
  });

  it('keeps two-wheelers off the motorway by default', () => {
    const route = engine.calculateRoute(start, goal, { profile: 'fastest' });
    expect(route.coordinates).toEqual([start, goal]);
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

describe('OfflineGraphEngine two-wheeler access', () => {
  const start: Coordinate = [0, 0];
  const goal: Coordinate = [0.009, 0];
  const detour: Coordinate = [0.0045, 0.006];

  it('skips motorcycle=no ways and allows motorcycle=yes over access=no', () => {
    const engine = new OfflineGraphEngine();
    engine.loadFeatureCollection(
      network([
        {
          highway: 'residential',
          coordinates: [start, goal],
          tags: { motorcycle: 'no' },
        },
        {
          highway: 'residential',
          coordinates: [start, detour, goal],
          tags: { access: 'no', motorcycle: 'yes' },
        },
      ]),
    );
    const route = engine.calculateRoute(start, goal, { profile: 'shortest' });
    expect(route.coordinates).toContainEqual(detour);
  });

  it('treats a roundabout as oneway', () => {
    const engine = new OfflineGraphEngine();
    engine.loadFeatureCollection(
      network([
        {
          highway: 'primary',
          coordinates: [start, goal],
          tags: { junction: 'roundabout' },
        },
      ]),
    );
    expect(engine.calculateRoute(start, goal).coordinates).toEqual([
      start,
      goal,
    ]);
    expect(() => engine.calculateRoute(goal, start)).toThrow(NoRoadPathError);
  });
});

describe('OfflineGraphEngine time model', () => {
  const start: Coordinate = [0, 0];
  const goal: Coordinate = [0.009, 0];

  it('prefers a slightly longer road over one with several signals', () => {
    // Direct street: ~1 km with 3 signals (~111 s + 75 s).
    // Detour: ~1.17 km and no signals (~130 s).
    const s1: Coordinate = [0.00225, 0];
    const s2: Coordinate = [0.0045, 0];
    const s3: Coordinate = [0.00675, 0];
    const detour: Coordinate = [0.0045, 0.003];
    const engine = new OfflineGraphEngine();
    engine.loadFeatureCollection(
      network(
        [
          { highway: 'residential', coordinates: [start, s1, s2, s3, goal] },
          { highway: 'residential', coordinates: [start, detour, goal] },
        ],
        { controls: [signal(s1), signal(s2), signal(s3)] },
      ),
    );
    const fastest = engine.calculateRoute(start, goal, { profile: 'fastest' });
    expect(fastest.coordinates).toContainEqual(detour);
    const shortest = engine.calculateRoute(start, goal, {
      profile: 'shortest',
    });
    expect(shortest.coordinates).toContainEqual(s2);
  });

  it('charges a signal cluster once and sums ETA per edge', () => {
    // Two signals ~11 m apart = one junction.
    const a: Coordinate = [0.0045, 0];
    const b: Coordinate = [0.0046, 0];
    const engine = new OfflineGraphEngine();
    engine.loadFeatureCollection(
      network([{ highway: 'residential', coordinates: [start, a, b, goal] }], {
        controls: [signal(a), signal(b)],
      }),
    );
    const route = engine.calculateRoute(start, goal);
    const rideSeconds = route.distanceMeters / 9;
    expect(route.durationSeconds).toBe(Math.round(rideSeconds + 25));
  });

  it('rides a multi-lane road faster than a narrow one', () => {
    const wide = new OfflineGraphEngine();
    wide.loadFeatureCollection(
      network([
        { highway: 'primary', coordinates: [start, goal], tags: { lanes: '6' } },
      ]),
    );
    const narrow = new OfflineGraphEngine();
    narrow.loadFeatureCollection(
      network([
        { highway: 'primary', coordinates: [start, goal], tags: { lanes: '1' } },
      ]),
    );
    expect(wide.calculateRoute(start, goal).durationSeconds).toBeLessThan(
      narrow.calculateRoute(start, goal).durationSeconds,
    );
  });
});

describe('OfflineGraphEngine turn restrictions', () => {
  //        north (goal)
  //          |  way 2
  // west ── via ── east
  //  way 1     way 3 (to east, then way 4 up to goal)
  const west: Coordinate = [0, 0];
  const via: Coordinate = [0.005, 0];
  const goal: Coordinate = [0.005, 0.005];
  const east: Coordinate = [0.01, 0];
  const roads = [
    { highway: 'residential', coordinates: [west, via], id: 1 },
    { highway: 'residential', coordinates: [via, goal], id: 2 },
    { highway: 'residential', coordinates: [via, east], id: 3 },
    { highway: 'residential', coordinates: [east, goal], id: 4 },
  ];

  it('takes the direct left turn with no restriction', () => {
    const engine = new OfflineGraphEngine();
    engine.loadFeatureCollection(network(roads));
    expect(engine.calculateRoute(west, goal).coordinates).toEqual([
      west,
      via,
      goal,
    ]);
  });

  it('detours around a no_left_turn', () => {
    const engine = new OfflineGraphEngine();
    engine.loadFeatureCollection(
      network(roads, {
        restrictions: [{ fromWay: 1, via, toWay: 2, kind: 'no' }],
      }),
    );
    expect(engine.calculateRoute(west, goal).coordinates).toEqual([
      west,
      via,
      east,
      goal,
    ]);
  });

  it('obeys only_straight_on', () => {
    const engine = new OfflineGraphEngine();
    engine.loadFeatureCollection(
      network(roads, {
        restrictions: [{ fromWay: 1, via, toWay: 3, kind: 'only' }],
      }),
    );
    expect(engine.calculateRoute(west, goal).coordinates).toContainEqual(east);
    // Arriving on another way, the restriction doesn't apply.
    expect(engine.calculateRoute(east, west).coordinates).toEqual([
      east,
      via,
      west,
    ]);
  });
});
