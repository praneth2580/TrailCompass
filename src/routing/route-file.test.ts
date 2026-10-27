import { describe, expect, it } from 'vitest';
import { parseRouteFile, serializeRouteFile } from './route-file';
import type { SavedRoute } from '../types/route';

function trip(places?: unknown): SavedRoute {
  return {
    id: 'konkan',
    name: 'Konkan coast',
    createdAt: '2026-10-24T09:00:00Z',
    updatedAt: '2026-10-24T09:00:00Z',
    start: [72.85, 19.17],
    end: [73.27, 17.15],
    waypoints: [[73.42, 18.08], [73.52, 17.53]],
    coordinates: [[72.85, 19.17], [73.42, 18.08], [73.52, 17.53], [73.27, 17.15]],
    distanceMeters: 331_000,
    durationSeconds: 26_700,
    instructions: [],
    ...(places ? { places: places as SavedRoute['places'] } : {}),
  };
}

const named = {
  end: 'Ganpatipule',
  endNotes: 'Ratnagiri, Maharashtra',
  stops: [
    { name: 'Mahad', kind: 'manual', notes: 'Raigad, Maharashtra' },
    { name: 'HP Petrol Pump, Chiplun', kind: 'fuel' },
  ],
};

describe('route files keep stop names', () => {
  it('reads back the names of the destination and stops', () => {
    expect(parseRouteFile(serializeRouteFile(trip(named))).places).toEqual(named);
  });

  it('drops stop names that no longer match the stops', () => {
    const places = parseRouteFile(
      serializeRouteFile(trip({ ...named, stops: named.stops.slice(0, 1) })),
    ).places;
    expect(places).toEqual({ end: 'Ganpatipule', endNotes: 'Ratnagiri, Maharashtra' });
  });

  it('ignores names of an unknown kind or shape', () => {
    const odd = { end: 42, stops: [{ name: 'A', kind: 'rocket' }, { name: 'B', kind: 'fuel' }] };
    expect(parseRouteFile(serializeRouteFile(trip(odd))).places).toBeUndefined();
  });

  it('reads older files without names', () => {
    expect(parseRouteFile(serializeRouteFile(trip())).places).toBeUndefined();
  });
});
