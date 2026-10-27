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
const { downloadPolicy } = await import('./download-policy.service');

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

describe('NavigationService background planning', () => {
  /** Routes like straightLines, but only once release() is called. */
  function heldRoutes() {
    const calls: Coordinate[][] = [];
    let release = () => {};
    const adapter: RoutingAdapter = {
      calculateRoute: (start, end, options) => {
        calls.push([start, end]);
        const signal = Array.isArray(options) ? undefined : options?.signal;
        return new Promise((resolve, reject) => {
          signal?.addEventListener('abort', () =>
            reject(new DOMException('Aborted', 'AbortError')),
          );
          release = () => resolve(straightLines.calculateRoute(start, end));
        });
      },
    };
    return { adapter, calls, release: () => release() };
  }

  it('pauses a plan and resumes the same trip', async () => {
    const held = heldRoutes();
    const nav = new NavigationService(held.adapter);
    const results: string[] = [];
    nav.onPlanSettled((result) => results.push(result));

    const first = nav.planRoute(goregaon, ganpatipule, [chiplun]);
    await vi.waitFor(() => expect(held.calls).toHaveLength(1));
    expect(nav.isPlanningRoute()).toBe(true);

    nav.pausePlanning();
    expect(await first).toBe('cancelled');
    expect(nav.isPlanningRoute()).toBe(false);
    expect(nav.getState().message).toBe('Route planning paused');

    const resumed = nav.resumePlanning();
    await vi.waitFor(() => expect(held.calls).toHaveLength(2));
    held.release();

    expect(await resumed).toBe('ready');
    expect(held.calls[1]).toEqual([goregaon, ganpatipule]);
    expect(nav.isPlannedFor(ganpatipule, [chiplun])).toBe(true);
    expect(results).toEqual(['cancelled', 'ready']);
  });

  it('has nothing to resume before a plan', () => {
    expect(new NavigationService(straightLines).resumePlanning()).toBeNull();
  });

  it('says when road downloads are waiting for Wi-Fi', async () => {
    downloadPolicy.setSetting('wifi');
    downloadPolicy.setNetwork('cellular');
    const waitsForWifi: RoutingAdapter = {
      calculateRoute: async (start, end) => {
        await downloadPolicy.waitForRoads();
        return straightLines.calculateRoute(start, end);
      },
    };
    const nav = new NavigationService(waitsForWifi);

    const plan = nav.planRoute(goregaon, andheri);
    await vi.waitFor(() =>
      expect(nav.getState().progress?.label).toMatch(/^Waiting for Wi-Fi/),
    );
    downloadPolicy.setNetwork('wifi');

    expect(await plan).toBe('ready');
    downloadPolicy.setSetting('any');
  });
});
