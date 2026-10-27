import { describe, expect, it, vi } from 'vitest';
import type { CalculatedRoute, Coordinate, RoutingAdapter } from '../routing/routing-adapter';
import { haversineMeters } from '../routing/geo';

// Drawing on the map is irrelevant here: every map call is a no-op.
vi.mock('./map.service', () => ({
  mapService: new Proxy({}, { get: () => () => undefined }),
}));
vi.mock('../routing/offline-adapter', () => ({
  offlineRoutingAdapter: {
    initialize: async () => ({ ready: true, label: 'test', message: 'Ready' }),
    subscribeProgress: () => () => undefined,
  },
}));
vi.mock('./route-library.service', () => ({ routeLibrary: {} }));

const { NavigationService } = await import('./navigation.service');

const goregaon: Coordinate = [72.8479, 19.1663];
const andheri: Coordinate = [72.8697, 19.1136];
const ganpatipule: Coordinate = [73.2665, 17.1448];
const chiplun: Coordinate = [73.5156, 17.5323];

/** Routes straight from start to end. */
const straightLines: RoutingAdapter = {
  calculateRoute: async (start, end): Promise<CalculatedRoute> => {
    const distanceMeters = haversineMeters(start, end);
    return {
      coordinates: [start, end],
      distanceMeters,
      durationSeconds: distanceMeters / 15,
      instructions: [{ text: 'Arrive at destination', distanceMeters, maneuver: 'arrive' }],
    };
  },
};

describe('NavigationService planned trip', () => {
  it('does not offer a route to an earlier destination for a new one', async () => {
    const nav = new NavigationService(straightLines);
    await nav.planRoute(goregaon, andheri);

    expect(nav.isPlannedTo(andheri)).toBe(true);
    // The Plan tab switched to Ganpatipule: this 11 km route must not be used.
    expect(nav.isPlannedTo(ganpatipule)).toBe(false);
  });

  it('still leads to its destination after stops are added', async () => {
    const nav = new NavigationService(straightLines);
    await nav.planRoute(goregaon, ganpatipule);

    expect(nav.isPlannedTo(ganpatipule)).toBe(true);
    expect(nav.isPlannedFor(ganpatipule, [])).toBe(true);
    expect(nav.isPlannedFor(ganpatipule, [chiplun])).toBe(false);
  });

  it('drops the finished route on arrival', async () => {
    const nav = new NavigationService(straightLines);
    await nav.planRoute(goregaon, andheri);
    nav.startNavigation();

    nav.updatePosition(andheri, 5);

    expect(nav.getState().status).toBe('arrived');
    expect(nav.getActiveCalculatedRoute()).toBeNull();
    expect(nav.isPlannedTo(andheri)).toBe(false);
  });

  it('treats an opened saved route as planned to its destination', () => {
    const nav = new NavigationService(straightLines);
    nav.loadSavedRoute({
      id: 'saved-1',
      name: 'Konkan coast',
      createdAt: '2026-10-27T00:00:00Z',
      updatedAt: '2026-10-27T00:00:00Z',
      start: goregaon,
      end: ganpatipule,
      waypoints: [chiplun],
      coordinates: [goregaon, chiplun, ganpatipule],
      distanceMeters: 330_000,
      durationSeconds: 8 * 3600,
      instructions: [],
    });

    expect(nav.isPlannedTo(ganpatipule)).toBe(true);
    expect(nav.isPlannedFor(ganpatipule, [chiplun])).toBe(true);
  });
});
