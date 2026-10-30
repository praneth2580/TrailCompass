import { appDatabase } from '../database/database';
import { rideRepository, type RideRecord } from '../database/ride-repository';
import { routeRepository } from '../database/route-repository';
import { storageManager } from '../offline/storage-manager';
import { haversineMeters } from '../routing/geo';
import type { Coordinate } from '../routing/routing-adapter';
import { mapService } from './map.service';
import { nominatimReverse } from './nominatim-client';
import { clusterPlaces, groupRoutes, PLACE_RADIUS_M, rideTrip, type PlaceCluster, type RideTrip } from './ride-groups';
import { analyzeRoute, median, trafficLines, type RouteAnalysis, type SlowSpot } from './ride-insights';
import { decodePath, decodeTrack, encodePath, ridePeriod, type RidePeriod, type TrackFix } from './ride-track';

/**
 * The ride log sorted into routes and places, and what several rides of
 * a route say about it (ride-insights.ts). Each ride's trip (ride-groups.ts)
 * is worked out once from its track and kept in `rides/trips.json`.
 *
 * Places are named by the rider, else by the trip navigation went to, a
 * saved trip ending there, or OpenStreetMap (Nominatim, when online, the
 * point rounded to about 100 m); names found are kept for offline.
 */

/** A route: rides of the same roads, the same way. */
export interface RideRoute {
  /** Its first ride's id. */
  id: string;
  /** Newest first. */
  rides: RideRecord[];
  /** The rides' trips, in the same order. */
  trips: RideTrip[];
  /** One ride's path (the middle one by length), to draw and compare against. */
  path: Coordinate[];
  lengthMeters: number;
  startPlaceId: string;
  endPlaceId: string;
  /** "Home → Office", "Round trip from Lonavala". */
  name: string;
  /** A road or area only this route goes by, of those between the same places: "SV Road". */
  via: string | null;
  typicalSeconds: number;
  bestSeconds: number;
  lastRiddenAt: number;
}

/** Where rides start or end. */
export interface RidePlace {
  id: string;
  center: Coordinate;
  name: string;
  /** Named by the rider. */
  named: boolean;
  arrivals: number;
  departures: number;
}

export interface RideGroups {
  /** Every route, most ridden first. */
  routes: RideRoute[];
  places: RidePlace[];
  /** Rides kept, with or without a trip. */
  rideCount: number;
}

interface CachedTrip {
  path: string;
  lengthMeters: number;
  departedAt: number;
  seconds: number;
}

interface TripFile {
  v: typeof TRIP_FILE_VERSION;
  /** null: the ride went nowhere to compare. */
  trips: Record<string, CachedTrip | null>;
}

interface NamedPlace {
  id: string;
  coordinate: Coordinate;
  name: string;
}

type LookupKind = 'place' | 'road';

/** Bump when trips are worked out differently, to work them out again. */
const TRIP_FILE_VERSION = 1;
const TRIP_FILE = 'rides/trips.json';
const NAMED_PLACES_KEY = 'ride-places';
const LOOKUPS_KEY = 'place-lookups';
/** Detailed tracks kept in memory for analysis. */
const MAX_CACHED_TRACKS = 60;
/** Finished analyses kept, to go back and forth between periods. */
const MAX_CACHED_ANALYSES = 12;
/** Routes closer than this everywhere aren't told apart by a road. */
const MIN_VIA_APART_M = 150;

export class RideInsightsService {
  private tripFile: TripFile | null = null;
  private trips = new Map<string, RideTrip>();
  private loading: Promise<RideRecord[]> | null = null;
  private routeGroups: { key: string; groups: RideTrip[][] } | null = null;
  private named: NamedPlace[] | null = null;
  private tripPlaces: Array<{ coordinate: Coordinate; name: string }> | null = null;
  private lookups: Record<string, string> | null = null;
  private queue: Array<{ key: string; coordinate: Coordinate; kind: LookupKind }> = [];
  private looking = false;
  /** Lookups that failed this session: not tried again until the app restarts. */
  private failed = new Set<string>();
  private tracks = new Map<string, TrackFix[][]>();
  private analyses = new Map<string, Promise<RouteAnalysis>>();
  private listeners = new Set<() => void>();

  /** Names were found, or a place renamed: call groups() again. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** The ride log as routes and places. */
  async groups(): Promise<RideGroups> {
    const rides = await this.loadRides();
    await this.loadNames();
    const byId = new Map(rides.map((ride) => [ride.id, ride]));
    const trips = rides.flatMap((ride) => this.trips.get(ride.id) ?? []);

    const key = trips.map((trip) => trip.id).sort().join(',');
    if (this.routeGroups?.key !== key) this.routeGroups = { key, groups: groupRoutes(trips) };
    const clusters = clusterPlaces(trips, this.named!.map(({ id, coordinate }) => ({ id, coordinate })));
    const placeOf = new Map<string, { start: string; end: string }>();
    for (const cluster of clusters) {
      for (const id of cluster.departures) placeOf.set(id, { start: cluster.id, end: placeOf.get(id)?.end ?? '' });
      for (const id of cluster.arrivals) placeOf.set(id, { start: placeOf.get(id)?.start ?? '', end: cluster.id });
    }
    const places = clusters
      .filter((cluster) => cluster.arrivals.length + cluster.departures.length > 0)
      .map((cluster) => this.place(cluster, byId));
    const placeById = new Map(places.map((place) => [place.id, place]));

    const routes = this.routeGroups.groups.map((members): RideRoute => {
      const newestFirst = [...members].reverse();
      const byLength = [...members].sort((a, b) => a.lengthMeters - b.lengthMeters);
      const reference = byLength[Math.floor((byLength.length - 1) / 2)]!;
      const startPlaceId = mostCommon(members.map((trip) => placeOf.get(trip.id)!.start));
      const endPlaceId = mostCommon(members.map((trip) => placeOf.get(trip.id)!.end));
      const start = placeById.get(startPlaceId)!.name;
      const seconds = members.map((trip) => trip.seconds);
      return {
        id: members[0]!.id,
        rides: newestFirst.map((trip) => byId.get(trip.id)!),
        trips: newestFirst,
        path: reference.path,
        lengthMeters: reference.lengthMeters,
        startPlaceId,
        endPlaceId,
        name: startPlaceId === endPlaceId ? `Round trip from ${start}` : `${start} → ${placeById.get(endPlaceId)!.name}`,
        via: null,
        typicalSeconds: Math.round(median(seconds)),
        bestSeconds: Math.min(...seconds),
        lastRiddenAt: newestFirst[0]!.departedAt,
      };
    });
    this.nameVias(routes);
    routes.sort((a, b) => b.rides.length - a.rides.length || b.lastRiddenAt - a.lastRiddenAt);
    return { routes, places, rideCount: rides.length };
  }

  /**
   * How the route's rides went, those setting off in `period` only if
   * given. Reads their tracks, so it takes a moment the first time.
   */
  analyze(route: RideRoute, period: RidePeriod | null = null): Promise<RouteAnalysis> {
    const key = `${period}:${route.rides.map((ride) => ride.id).join(',')}`;
    let analysis = this.analyses.get(key);
    if (!analysis) {
      analysis = this.analyzeNow(route, period);
      this.analyses.set(key, analysis);
      analysis.catch(() => this.analyses.delete(key));
      if (this.analyses.size > MAX_CACHED_ANALYSES) this.analyses.delete(this.analyses.keys().next().value!);
    }
    return analysis;
  }

  private async analyzeNow(route: RideRoute, period: RidePeriod | null): Promise<RouteAnalysis> {
    const rides = route.rides.filter(
      (_, i) => period == null || ridePeriod(new Date(route.trips[i]!.departedAt)) === period,
    );
    const tracks = await Promise.all(rides.map(async (ride) => ({ id: ride.id, segments: await this.track(ride) })));
    return analyzeRoute(route.path, tracks);
  }

  /** The route drawn by its usual traffic, framed whole or on one slow spot. */
  showTraffic(route: RideRoute, analysis: RouteAnalysis, focus?: SlowSpot): void {
    mapService.setTrafficLines(trafficLines(route.path, analysis.stretches));
    const [west, south, east, north] = bbox(focus ? focus.line : route.path);
    // A slow spot is shown with some road either side.
    const pad = focus ? Math.max(0.002, (north - south) * 0.6, (east - west) * 0.6) : 0;
    mapService.fitBetweenPanels(west - pad, south - pad, east + pad, north + pad);
  }

  hideTraffic(): void {
    mapService.setTrafficLines(null);
  }

  /**
   * A name for the road or area at a point, if known; looked up online
   * (one at a time) if not. subscribe() hears when it's found.
   */
  nameAt(coordinate: Coordinate, kind: LookupKind): string | null {
    const key = lookupKey(coordinate, kind);
    const known = this.lookups?.[key];
    if (known != null) return known || null;
    this.lookUp(key, coordinate, kind);
    return null;
  }

  /** The name nameAt() found, without looking it up. */
  knownNameAt(coordinate: Coordinate, kind: LookupKind): string | null {
    return this.lookups?.[lookupKey(coordinate, kind)] || null;
  }

  /** Names a place for the rider; an empty name goes back to the place's own. */
  async renamePlace(place: RidePlace, name: string): Promise<void> {
    await this.loadNames();
    const rest = this.named!.filter((entry) => entry.id !== place.id);
    const trimmed = name.trim();
    this.named = trimmed ? [...rest, { id: place.id, coordinate: place.center, name: trimmed }] : rest;
    await appDatabase.setJson(NAMED_PLACES_KEY, this.named);
    this.emit();
  }

  /** Every ride, with its trip worked out (once, then kept). */
  private loadRides(): Promise<RideRecord[]> {
    this.loading ??= (async () => {
      const rides = await rideRepository.list();
      const file = await this.readTripFile();
      let changed = false;
      for (const ride of rides) {
        if (!(ride.id in file.trips)) {
          const trip = rideTrip(ride.id, await this.track(ride));
          file.trips[ride.id] = trip
            ? { path: encodePath(trip.path), lengthMeters: Math.round(trip.lengthMeters), departedAt: trip.departedAt, seconds: trip.seconds }
            : null;
          changed = true;
        }
        const cached = file.trips[ride.id];
        if (cached && !this.trips.has(ride.id)) this.trips.set(ride.id, { id: ride.id, ...cached, path: decodePath(cached.path) });
      }
      const ids = new Set(rides.map((ride) => ride.id));
      for (const id of Object.keys(file.trips)) {
        if (ids.has(id)) continue;
        delete file.trips[id];
        this.trips.delete(id);
        changed = true;
      }
      if (changed) await storageManager.writeTextFile(TRIP_FILE, JSON.stringify(file)).catch(() => undefined);
      return rides;
    })().finally(() => {
      this.loading = null;
    });
    return this.loading;
  }

  private async readTripFile(): Promise<TripFile> {
    if (this.tripFile) return this.tripFile;
    let file: TripFile | null = null;
    try {
      const parsed = JSON.parse((await storageManager.readTextFile(TRIP_FILE)) ?? 'null') as TripFile | null;
      if (parsed?.v === TRIP_FILE_VERSION && parsed.trips) file = parsed;
    } catch {
      // Worked out again.
    }
    this.tripFile = file ?? { v: TRIP_FILE_VERSION, trips: {} };
    return this.tripFile;
  }

  private async track(ride: RideRecord): Promise<TrackFix[][]> {
    const cached = this.tracks.get(ride.id);
    if (cached) return cached;
    const stored = await rideRepository.getTrack(ride.id);
    const segments = stored ? decodeTrack(stored, Date.parse(ride.startedAt)) : [];
    this.tracks.set(ride.id, segments);
    if (this.tracks.size > MAX_CACHED_TRACKS) this.tracks.delete(this.tracks.keys().next().value!);
    return segments;
  }

  private async loadNames(): Promise<void> {
    this.named ??= (await appDatabase.getJson<NamedPlace[]>(NAMED_PLACES_KEY)) ?? [];
    this.lookups ??= (await appDatabase.getJson<Record<string, string>>(LOOKUPS_KEY)) ?? {};
    // Saved trips' destinations, by the names they were planned with.
    this.tripPlaces ??= (await routeRepository.listRoutes().catch(() => [])).flatMap((route) =>
      route.places?.end ? [{ coordinate: route.end, name: route.places.end }] : [],
    );
  }

  private place(cluster: PlaceCluster, rides: Map<string, RideRecord>): RidePlace {
    const named = this.named!.find((entry) => entry.id === cluster.id);
    const base = { id: cluster.id, center: cluster.center, arrivals: cluster.arrivals.length, departures: cluster.departures.length };
    if (named) return { ...base, name: named.name, named: true };
    // The destination navigation was heading for, or a saved trip's.
    const navigated = cluster.arrivals.flatMap((id) => rides.get(id)?.routeName ?? []);
    const saved = this.tripPlaces!.find((place) => haversineMeters(place.coordinate, cluster.center) <= PLACE_RADIUS_M);
    const local = navigated.length > 0 ? mostCommon(navigated) : saved?.name;
    // Else looked up online, only for places ridden to or from more than once.
    const lookedUp = local
      ? null
      : base.arrivals + base.departures >= 2
        ? this.nameAt(cluster.center, 'place')
        : this.knownNameAt(cluster.center, 'place');
    const name = local ?? lookedUp ?? `${cluster.center[1].toFixed(3)}, ${cluster.center[0].toFixed(3)}`;
    return { ...base, name, named: false };
  }

  /** Routes between the same two places told apart by a road only one of them takes. */
  private nameVias(routes: RideRoute[]): void {
    const byEnds = new Map<string, RideRoute[]>();
    for (const route of routes) {
      const key = `${route.startPlaceId}>${route.endPlaceId}`;
      byEnds.set(key, [...(byEnds.get(key) ?? []), route]);
    }
    for (const siblings of byEnds.values()) {
      if (siblings.length < 2) continue;
      const roads = siblings.map((route) => {
        const others = siblings.filter((other) => other !== route);
        const point = farthestPoint(route.path, others.map((other) => other.path));
        return point ? this.nameAt(point, 'road') : null;
      });
      siblings.forEach((route, i) => {
        const road = roads[i];
        const unique = road && roads.filter((other) => other === road).length === 1;
        route.via = unique ? road : null;
      });
    }
  }

  private lookUp(key: string, coordinate: Coordinate, kind: LookupKind): void {
    if (this.failed.has(key) || this.queue.some((entry) => entry.key === key)) return;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
    this.queue.push({ key, coordinate, kind });
    void this.drainLookups();
  }

  private async drainLookups(): Promise<void> {
    if (this.looking) return;
    this.looking = true;
    try {
      for (let next = this.queue.shift(); next; next = this.queue.shift()) {
        const [lon, lat] = roundedForLookup(next.coordinate);
        try {
          const result = await nominatimReverse({
            lat,
            lon,
            // Street level: further out, Indian cities answer with a ward and little else.
            zoom: next.kind === 'place' ? '16' : '17',
            addressdetails: '1',
          });
          this.lookups = { ...this.lookups, [next.key]: lookupName(result, next.kind) };
          await appDatabase.setJson(LOOKUPS_KEY, this.lookups);
          this.emit();
        } catch {
          this.failed.add(next.key);
        }
      }
    } finally {
      this.looking = false;
    }
  }

  private emit(): void {
    for (const listener of [...this.listeners]) listener();
  }
}

function lookupName(result: Awaited<ReturnType<typeof nominatimReverse>>, kind: LookupKind): string {
  if (!result) return '';
  const address = result.address ?? {};
  // Indian cities map their municipal wards as suburbs: "K/E Ward" means little to a rider.
  const ward = address.suburb && /\bward\b/i.test(address.suburb);
  const area = (ward ? undefined : address.suburb) ?? address.village ?? address.town ?? address.hamlet ?? address.neighbourhood ?? address.quarter;
  if (kind === 'road') return address.road ?? address.neighbourhood ?? area ?? '';
  return area ?? address.suburb ?? address.city ?? address.county ?? result.name ?? '';
}

/** About 100 m: enough to name a neighbourhood or a road, without saying exactly where. */
function roundedForLookup([lon, lat]: Coordinate): [string, string] {
  return [lon.toFixed(3), lat.toFixed(3)];
}

function lookupKey(coordinate: Coordinate, kind: LookupKind): string {
  const [lon, lat] = roundedForLookup(coordinate);
  return `${kind}:${lat},${lon}`;
}

/** The point of `path` farthest from every other path; null when they run together all the way. */
function farthestPoint(path: Coordinate[], others: Coordinate[][]): Coordinate | null {
  const step = Math.max(1, Math.floor(path.length / 100));
  let best: Coordinate | null = null;
  let bestMeters = MIN_VIA_APART_M;
  for (let i = 0; i < path.length; i += step) {
    let nearest = Infinity;
    for (const other of others) {
      const otherStep = Math.max(1, Math.floor(other.length / 200));
      for (let j = 0; j < other.length && nearest > bestMeters; j += otherStep) {
        nearest = Math.min(nearest, haversineMeters(path[i]!, other[j]!));
      }
    }
    if (nearest > bestMeters) {
      best = path[i]!;
      bestMeters = nearest;
    }
  }
  return best;
}

function mostCommon<T>(values: T[]): T {
  const counts = new Map<T, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1])[0]![0];
}

function bbox(line: Coordinate[]): [number, number, number, number] {
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (const [lon, lat] of line) {
    west = Math.min(west, lon);
    east = Math.max(east, lon);
    south = Math.min(south, lat);
    north = Math.max(north, lat);
  }
  return [west, south, east, north];
}

export const rideInsights = new RideInsightsService();
