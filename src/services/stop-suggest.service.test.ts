import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CalculatedRoute, Coordinate } from '../routing/routing-adapter';
import type { PlaceHit, PoiKind } from '../types/trip-stop';

const mocks = vi.hoisted(() => ({ findPois: vi.fn() }));

vi.mock('./poi-search.service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./poi-search.service')>()),
  findPois: mocks.findPois,
}));

const { suggestFoodStops, suggestFuelStops } = await import(
  './stop-suggest.service'
);

/** Metres per degree of longitude at 18°N. */
const M_PER_DEG = 105_870;

/** A straight ~318 km ride east along 18°N, a vertex every ~1 km. */
const route: CalculatedRoute = {
  coordinates: Array.from(
    { length: 301 },
    (_, i): Coordinate => [73 + i * 0.01, 18],
  ),
  distanceMeters: 318_000,
  durationSeconds: 5 * 3600,
  instructions: [],
};

function placeAtKm(kind: PoiKind, km: number, offMeters = 200): PlaceHit {
  return {
    id: `${kind}-${km}`,
    name: `${kind} at ${km}`,
    coordinate: [73 + (km * 1000) / M_PER_DEG, 18 + offMeters / 110_540],
    kind,
  };
}

/** Serve the places that fall inside each searched stretch. */
function serve(places: PlaceHit[]) {
  mocks.findPois.mockImplementation(
    async (options: { kind: PoiKind; route: Coordinate[] }) => {
      const lons = options.route.map((c) => c[0]);
      const west = Math.min(...lons);
      const east = Math.max(...lons);
      return places.filter(
        (p) =>
          p.kind === options.kind &&
          p.coordinate[0] >= west - 0.02 &&
          p.coordinate[0] <= east + 0.02,
      );
    },
  );
}

beforeEach(() => {
  mocks.findPois.mockReset();
});

describe('suggestFuelStops', () => {
  it('says no stop is needed when the trip fits in one tank leg', async () => {
    const outcome = await suggestFuelStops({ route, tankRangeKm: 500 });

    expect(outcome.suggestions).toEqual([]);
    expect(outcome.note).toMatch(/fits in one tank leg/);
    expect(mocks.findPois).not.toHaveBeenCalled();
  });

  it('chains legs from the pump actually picked', async () => {
    // 200 km tank → 140 km legs: search 70–147 km, then from the pick.
    serve([
      placeAtKm('fuel', 40),
      placeAtKm('fuel', 125),
      placeAtKm('fuel', 136, 2_000),
      placeAtKm('fuel', 250),
    ]);

    const outcome = await suggestFuelStops({ route, tankRangeKm: 200 });

    expect(outcome.suggestions.map((s) => s.place.id)).toEqual([
      'fuel-125',
      'fuel-250',
    ]);
    expect(outcome.suggestions[1]!.reason).toMatch(/after the last fill/);
    expect(outcome.note).toBeUndefined();
  });

  it('reports a leg with no station and keeps planning', async () => {
    serve([placeAtKm('fuel', 260)]);

    const outcome = await suggestFuelStops({ route, tankRangeKm: 200 });

    expect(outcome.suggestions.map((s) => s.place.id)).toEqual(['fuel-260']);
    expect(outcome.note).toMatch(/No station found near 140\.0 km/);
  });

  it('surfaces the network error when nothing could be found', async () => {
    mocks.findPois.mockRejectedValue(new Error("Couldn't reach OpenStreetMap"));

    await expect(
      suggestFuelStops({ route, tankRangeKm: 200 }),
    ).rejects.toThrow("Couldn't reach OpenStreetMap");
  });
});

describe('suggestFoodStops', () => {
  it('picks a place near where the meal falls', async () => {
    // Leave 10:00, 5 h ride: lunch target 13:00 → 60% of the way, ~191 km.
    serve([placeAtKm('food', 120), placeAtKm('food', 188), placeAtKm('food', 260)]);

    const outcome = await suggestFoodStops({
      route,
      departTime: '10:00',
      meals: ['lunch'],
    });

    expect(outcome.suggestions.map((s) => s.place.id)).toEqual(['food-188']);
  });

  it('explains when no meal falls during the trip', async () => {
    const outcome = await suggestFoodStops({
      route,
      departTime: '22:30',
      meals: ['lunch'],
    });

    expect(outcome.suggestions).toEqual([]);
    expect(outcome.note).toMatch(/None of the chosen meal times/);
  });
});
