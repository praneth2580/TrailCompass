import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RideRecord } from '../database/ride-repository';
import type { Coordinate } from '../routing/routing-adapter';
import { alongLine, at, DAY, START } from './ride-test-helpers';
import { encodeTrack, ridePeriod, type StoredTrack } from './ride-track';

const store = vi.hoisted(() => ({
  rides: [] as RideRecord[],
  tracks: new Map<string, StoredTrack>(),
  files: new Map<string, string>(),
  prefs: new Map<string, unknown>(),
  savedTrips: [] as unknown[],
  reverse: vi.fn(),
  getTrack: vi.fn(),
  setTrafficLines: vi.fn(),
  fitBetweenPanels: vi.fn(),
}));

vi.mock('./map.service', () => ({
  mapService: { setTrafficLines: store.setTrafficLines, fitBetweenPanels: store.fitBetweenPanels },
}));
vi.mock('./nominatim-client', () => ({ nominatimReverse: store.reverse }));
vi.mock('../offline/storage-manager', () => ({
  storageManager: {
    readTextFile: async (path: string) => store.files.get(path) ?? null,
    writeTextFile: async (path: string, text: string) => {
      store.files.set(path, text);
      return path;
    },
  },
}));
vi.mock('../database/database', () => ({
  appDatabase: {
    getJson: async (key: string) => store.prefs.get(key) ?? null,
    setJson: async (key: string, value: unknown) => void store.prefs.set(key, value),
  },
}));
vi.mock('../database/route-repository', () => ({
  routeRepository: { listRoutes: async () => store.savedTrips },
}));
vi.mock('../database/ride-repository', () => ({
  rideRepository: { list: async () => store.rides, getTrack: store.getTrack },
}));

const { RideInsightsService } = await import('./ride-insights.service');

const road: Coordinate[] = [at(0, 0), at(0, 5000)];
const otherRoad: Coordinate[] = [at(0, 0), at(1500, 500), at(1500, 4500), at(0, 5000)];

function addRide(id: string, line: Coordinate[], startAt: number, routeName?: string): void {
  const fixes = alongLine(line, startAt);
  store.rides.push({
    id,
    name: 'Morning ride',
    startedAt: new Date(startAt).toISOString(),
    endedAt: new Date(fixes[fixes.length - 1]!.t).toISOString(),
    distanceMeters: 5000,
    movingSeconds: 500,
    recordedSeconds: 500,
    maxSpeedMps: 10,
    climbMeters: 0,
    bbox: [72.8, 19, 72.81, 19.05],
    preview: line,
    source: 'gps',
    ...(routeName ? { routeName } : {}),
  } as RideRecord);
  store.tracks.set(id, encodeTrack([fixes], startAt));
}

/** Waits for the queued name lookups, then the groups they make. */
async function groupsWithNames(service: InstanceType<typeof RideInsightsService>) {
  await service.groups();
  await vi.waitFor(async () => {
    const before = store.reverse.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(store.reverse.mock.calls.length).toBe(before);
  });
  return service.groups();
}

beforeEach(() => {
  store.rides.length = 0;
  store.savedTrips.length = 0;
  store.tracks.clear();
  store.files.clear();
  store.prefs.clear();
  store.reverse.mockReset();
  store.getTrack.mockReset();
  store.getTrack.mockImplementation(async (id: string) => store.tracks.get(id) ?? null);
  store.reverse.mockResolvedValue({ address: { suburb: 'Goregaon West' } });
});

describe('groups', () => {
  it('sorts rides into routes, each way apart', async () => {
    addRide('a', road, START);
    addRide('b', road, START + DAY);
    addRide('back', [...road].reverse(), START + 2 * DAY);
    const { routes, places } = await new RideInsightsService().groups();

    expect(routes.map((route) => route.rides.map((ride) => ride.id))).toEqual([['b', 'a'], ['back']]);
    expect(places).toHaveLength(2);
    expect(routes[0]!.startPlaceId).toBe(routes[1]!.endPlaceId);
  });

  it('names a place from the trip navigation went to, or a saved trip', async () => {
    addRide('a', road, START, 'Office');
    addRide('b', road, START + DAY);
    store.savedTrips.push({ end: at(0, 0), places: { end: 'Home' } });
    addRide('back', [...road].reverse(), START + 2 * DAY);

    const { routes } = await new RideInsightsService().groups();
    expect(routes[0]!.name).toBe('Home → Office');
    expect(routes[1]!.name).toBe('Office → Home');
    expect(store.reverse).not.toHaveBeenCalled();
  });

  it('asks OpenStreetMap about a place to within about 100 m, and keeps the answer', async () => {
    addRide('a', road, START);
    addRide('b', road, START + DAY);
    const service = new RideInsightsService();
    const { routes } = await groupsWithNames(service);

    expect(routes[0]!.name).toBe('Goregaon West → Goregaon West');
    expect(store.reverse).toHaveBeenCalledTimes(2);
    for (const [params] of store.reverse.mock.calls as Array<[{ lat: string; lon: string }]>) {
      expect(params.lat).toMatch(/^\d+\.\d{3}$/);
      expect(params.lon).toMatch(/^\d+\.\d{3}$/);
    }

    // Another start of the app: no need to ask again.
    store.reverse.mockClear();
    await groupsWithNames(new RideInsightsService());
    expect(store.reverse).not.toHaveBeenCalled();
  });

  it('prefers the name riders use to a municipal ward', async () => {
    addRide('a', road, START);
    addRide('b', road, START + DAY);
    // As Nominatim answers in Mumbai.
    store.reverse.mockResolvedValue({ name: '', address: { suburb: 'K/E Ward', neighbourhood: 'Gufa Tekdi', city: 'Mumbai' } });
    const { routes } = await groupsWithNames(new RideInsightsService());
    expect(routes[0]!.name).toBe('Gufa Tekdi → Gufa Tekdi');
  });

  it('keeps a ward over nothing better than the city', async () => {
    addRide('a', road, START);
    addRide('b', road, START + DAY);
    store.reverse.mockResolvedValue({ name: 'K/E Ward', address: { suburb: 'K/E Ward', city: 'Mumbai' } });
    const { places } = await groupsWithNames(new RideInsightsService());
    expect(places[0]!.name).toBe('K/E Ward');
  });

  it('does not ask online about places ridden only once', async () => {
    addRide('once', road, START);
    await groupsWithNames(new RideInsightsService());
    expect(store.reverse).not.toHaveBeenCalled();
  });

  it('works each ride out once, and forgets deleted rides', async () => {
    addRide('a', road, START);
    addRide('b', road, START + DAY);
    await new RideInsightsService().groups();
    expect(store.getTrack).toHaveBeenCalledTimes(2);

    store.getTrack.mockClear();
    const reopened = new RideInsightsService();
    expect((await reopened.groups()).routes).toHaveLength(1);
    expect(store.getTrack).not.toHaveBeenCalled();

    store.rides.pop();
    expect((await reopened.groups()).routes[0]!.rides.map((ride) => ride.id)).toEqual(['a']);
    expect(Object.keys((JSON.parse(store.files.get('rides/trips.json')!) as { trips: object }).trips)).toEqual(['a']);
  });

  it('tells two ways between the same places apart by a road only one takes', async () => {
    addRide('a', road, START);
    addRide('b', otherRoad, START + DAY);
    store.reverse.mockImplementation(async (params: { zoom: string; lon: string }) =>
      params.zoom === '17'
        ? { address: { road: Number(params.lon) > 72.805 ? 'Link Road' : 'SV Road' } }
        : { address: { suburb: 'Goregaon West' } },
    );
    const { routes } = await groupsWithNames(new RideInsightsService());
    expect(routes.map((route) => route.via).sort()).toEqual(['Link Road', 'SV Road']);
  });

  it('falls back on the neighbourhood where the road has no name', async () => {
    addRide('a', road, START);
    addRide('b', otherRoad, START + DAY);
    store.reverse.mockImplementation(async (params: { zoom: string; lon: string }) =>
      params.zoom === '17'
        ? { name: '', address: { suburb: 'K/E Ward', neighbourhood: Number(params.lon) > 72.805 ? 'Gufa Tekdi' : 'Azad Nagar' } }
        : { address: { suburb: 'Goregaon West' } },
    );
    const { routes } = await groupsWithNames(new RideInsightsService());
    expect(routes.map((route) => route.via).sort()).toEqual(['Azad Nagar', 'Gufa Tekdi']);
  });
});

describe('renamePlace', () => {
  it('keeps the rider’s name for the place, and can go back', async () => {
    addRide('a', road, START, 'Office');
    addRide('b', road, START + DAY, 'Office');
    const service = new RideInsightsService();
    const office = (await service.groups()).places.find((place) => place.name === 'Office')!;

    await service.renamePlace(office, ' Work ');
    const renamed = await service.groups();
    expect(renamed.places.find((place) => place.id === office.id)).toMatchObject({ name: 'Work', named: true, arrivals: 2 });
    expect(renamed.routes[0]!.name.endsWith('→ Work')).toBe(true);

    await service.renamePlace({ ...office, name: 'Work', named: true }, '');
    expect((await service.groups()).places.find((place) => place.id === office.id)?.named).toBe(false);
  });
});

describe('analyze', () => {
  it('looks at one part of the day, and draws the traffic', async () => {
    addRide('morning', road, START);
    addRide('later', road, START + DAY + 7 * 3_600_000);
    const service = new RideInsightsService();
    const [route] = (await service.groups()).routes;
    const period = ridePeriod(new Date(START));

    expect((await service.analyze(route!)).rides).toHaveLength(2);
    const some = await service.analyze(route!, period);
    expect(some.rides.map((ride) => ride.id)).toContain('morning');
    expect(some.rides.length).toBeLessThanOrEqual(2);

    // Asked again as place names come in: the same answer, not worked out afresh.
    expect(await service.analyze(route!, period)).toBe(some);

    service.showTraffic(route!, some);
    expect(store.setTrafficLines).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ level: 'clear' })]));
    expect(store.fitBetweenPanels).toHaveBeenCalled();
    service.hideTraffic();
    expect(store.setTrafficLines).toHaveBeenLastCalledWith(null);
  });
});
