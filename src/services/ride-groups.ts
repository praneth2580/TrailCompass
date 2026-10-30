import type { Coordinate } from '../routing/routing-adapter';
import { haversineMeters, polylineLengthMeters, samplePolylineMeters } from '../routing/geo';
import type { TrackFix } from './ride-track';

/**
 * Sorting recorded rides: which ones ride the same route (same way, same
 * roads, same direction) and which places they start and end at. All
 * from the kept tracks, nothing online.
 */

/** Waiting around one spot (within this) isn't riding: at either end, or a break on the way. */
const STAY_RADIUS_M = 50;
/** Standing this long mid-ride is a break (fuel, tea), not traffic. */
const BREAK_MS = 5 * 60_000;
/** Shorter trips aren't compared. */
const MIN_TRIP_M = 200;
/** Ends of rides this close are the same place. */
export const PLACE_RADIUS_M = 400;
/** A ride's path is compared every this many metres, or sparser on long rides. */
const MIN_PATH_SPACING_M = 50;
const MAX_PATH_POINTS = 400;
/** The least a path is trusted to: a GPS fix and a bit. */
const MIN_TOLERANCE_M = 50;
/** Where a path passes a point twice (there and back), passes this much further off still count. */
const SAME_PASS_SLACK_M = 15;
/** Two rides are the same route when this share of each runs along the other. */
const SAME_ROUTE_SHARE = 0.8;
/** Nor when one is this much longer than the other. */
const MAX_LENGTH_RATIO = 1.4;

/** A ride as a trip from A to B: what grouping and comparing need. */
export interface RideTrip {
  id: string;
  /** Where it went, every few dozen metres, from setting off to arriving. */
  path: Coordinate[];
  lengthMeters: number;
  /** When the rider set off (ms), waiting at the start left out. */
  departedAt: number;
  /** Setting off to arriving, pauses and breaks left out. */
  seconds: number;
}

/**
 * The riding part of a ride: waiting at the start and end cut off, and
 * breaks of five minutes or more cut out (each break splits a stretch).
 */
export function tripSegments(segments: TrackFix[][]): TrackFix[][] {
  const flat = segments.flatMap((segment, index) => segment.map((fix) => ({ fix, index })));
  if (flat.length < 2) return [];
  const first = flat[0]!.fix;
  const last = flat[flat.length - 1]!.fix;
  const leftAt = flat.findIndex(({ fix }) => fixDistance(fix, first) > STAY_RADIUS_M);
  if (leftAt < 0) return [];
  let arrivedAt = flat.length - 1;
  while (arrivedAt > 0 && fixDistance(flat[arrivedAt]!.fix, last) <= STAY_RADIUS_M) arrivedAt--;
  const from = Math.max(0, leftAt - 1);
  const to = Math.min(flat.length - 1, arrivedAt + 1);
  if (to <= from) return [];

  const stretches: TrackFix[][] = [];
  for (let i = from; i <= to; i++) {
    if (i === from || flat[i]!.index !== flat[i - 1]!.index) stretches.push([]);
    stretches[stretches.length - 1]!.push(flat[i]!.fix);
  }
  return stretches.flatMap(splitAtBreaks);
}

/** Splits a stretch where the rider stayed within a few dozen metres for five minutes or more. */
function splitAtBreaks(stretch: TrackFix[]): TrackFix[][] {
  const parts: TrackFix[][] = [];
  let partStart = 0;
  let i = 0;
  while (i < stretch.length - 1) {
    let j = i + 1;
    while (j < stretch.length && fixDistance(stretch[i]!, stretch[j]!) <= STAY_RADIUS_M) j++;
    const leaving = j - 1;
    if (leaving > i && stretch[leaving]!.t - stretch[i]!.t >= BREAK_MS) {
      parts.push(stretch.slice(partStart, i + 1));
      partStart = leaving;
      i = leaving;
    } else {
      i++;
    }
  }
  parts.push(stretch.slice(partStart));
  return parts.filter((part) => part.length > 0);
}

/** The ride as a trip; null when it never really went anywhere. */
export function rideTrip(id: string, segments: TrackFix[][]): RideTrip | null {
  const parts = tripSegments(segments);
  const line = parts.flat().map((fix) => [fix.lon, fix.lat] as Coordinate);
  const lengthMeters = polylineLengthMeters(line);
  if (line.length < 2 || lengthMeters < MIN_TRIP_M) return null;
  const spacing = Math.max(MIN_PATH_SPACING_M, lengthMeters / (MAX_PATH_POINTS - 1));
  return {
    id,
    path: samplePolylineMeters(line, 0, lengthMeters, spacing).map((point) => point.coordinate),
    lengthMeters,
    departedAt: parts[0]![0]!.t,
    seconds: Math.round(parts.reduce((sum, part) => sum + part[part.length - 1]!.t - part[0]!.t, 0) / 1000),
  };
}

/**
 * A path in a flat local plane, indexed for "how far along is the point
 * nearest this one". Positions are metres from the path's start.
 */
export class PathIndex {
  readonly length: number;
  /** How far off the path a point may be and still be on it. */
  readonly tolerance: number;
  private readonly lon0: number;
  private readonly lat0: number;
  private readonly kx: number;
  /** Metres per degree, as haversineMeters measures. */
  private readonly ky = (Math.PI / 180) * 6_371_000;
  private readonly xy: Float64Array;
  private readonly along: Float64Array;
  private readonly cells = new Map<string, number[]>();
  readonly path: Coordinate[];

  constructor(path: Coordinate[], tolerance?: number) {
    this.path = path;
    const [lon0, lat0] = path[0] ?? [0, 0];
    this.lon0 = lon0;
    this.lat0 = lat0;
    this.kx = this.ky * Math.cos((lat0 * Math.PI) / 180);
    this.xy = new Float64Array(path.length * 2);
    this.along = new Float64Array(path.length);
    path.forEach((point, i) => {
      const [x, y] = this.toPlane(point);
      this.xy[i * 2] = x;
      this.xy[i * 2 + 1] = y;
      if (i > 0) this.along[i] = this.along[i - 1]! + Math.hypot(x - this.xy[i * 2 - 2]!, y - this.xy[i * 2 - 1]!);
    });
    this.length = this.along[path.length - 1] ?? 0;
    // Straight lines between path points cut corners by up to ~0.35 of their length.
    const spacing = path.length > 1 ? this.length / (path.length - 1) : 0;
    this.tolerance = tolerance ?? Math.max(MIN_TOLERANCE_M, 0.4 * spacing + 25);

    for (let i = 0; i + 1 < path.length; i++) {
      const [x0, x1] = minMax(this.xy[i * 2]!, this.xy[i * 2 + 2]!);
      const [y0, y1] = minMax(this.xy[i * 2 + 1]!, this.xy[i * 2 + 3]!);
      for (let cx = this.cell(x0 - this.tolerance); cx <= this.cell(x1 + this.tolerance); cx++) {
        for (let cy = this.cell(y0 - this.tolerance); cy <= this.cell(y1 + this.tolerance); cy++) {
          const key = `${cx}:${cy}`;
          const list = this.cells.get(key);
          if (list) list.push(i);
          else this.cells.set(key, [i]);
        }
      }
    }
  }

  /**
   * Where along the path `point` is, if it's on it. Where the path passes
   * by more than once (there and back), the place nearest `expected` wins.
   */
  locate(point: Coordinate, expected?: number): { along: number; distance: number } | null {
    const [px, py] = this.toPlane(point);
    const candidates: Array<{ along: number; distance: number }> = [];
    let nearest = Infinity;
    for (const i of this.cells.get(`${this.cell(px)}:${this.cell(py)}`) ?? []) {
      const ax = this.xy[i * 2]!;
      const ay = this.xy[i * 2 + 1]!;
      const dx = this.xy[i * 2 + 2]! - ax;
      const dy = this.xy[i * 2 + 3]! - ay;
      const length2 = dx * dx + dy * dy;
      const t = length2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / length2)) : 0;
      const distance = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
      if (distance > this.tolerance) continue;
      candidates.push({ along: this.along[i]! + t * Math.sqrt(length2), distance });
      nearest = Math.min(nearest, distance);
    }
    let best: { along: number; distance: number } | null = null;
    for (const candidate of candidates) {
      // Only passes about as near as the nearest: not the corner of the stretch before.
      if (candidate.distance > nearest + SAME_PASS_SLACK_M) continue;
      const score = expected == null ? candidate.distance : Math.abs(candidate.along - expected);
      const bestScore = best ? (expected == null ? best.distance : Math.abs(best.along - expected)) : Infinity;
      if (score < bestScore) best = candidate;
    }
    return best;
  }

  /** The point `along` metres from the start. */
  pointAt(along: number): Coordinate {
    const n = this.path.length;
    if (n === 0) return [0, 0];
    if (along <= 0) return this.path[0]!;
    if (along >= this.length) return this.path[n - 1]!;
    const i = this.segmentAt(along);
    const span = this.along[i + 1]! - this.along[i]!;
    const t = span > 0 ? (along - this.along[i]!) / span : 0;
    const a = this.path[i]!;
    const b = this.path[i + 1]!;
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  }

  /** The stretch of path between two positions. */
  slice(from: number, to: number): Coordinate[] {
    const start = Math.max(0, Math.min(from, to));
    const end = Math.min(this.length, Math.max(from, to));
    const line: Coordinate[] = [this.pointAt(start)];
    for (let i = this.segmentAt(start) + 1; i < this.path.length && this.along[i]! < end; i++) {
      if (this.along[i]! > start) line.push(this.path[i]!);
    }
    line.push(this.pointAt(end));
    return line;
  }

  private segmentAt(along: number): number {
    let lo = 0;
    let hi = this.path.length - 2;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.along[mid]! <= along) lo = mid;
      else hi = mid - 1;
    }
    return Math.max(0, lo);
  }

  private toPlane([lon, lat]: Coordinate): [number, number] {
    return [(lon - this.lon0) * this.kx, (lat - this.lat0) * this.ky];
  }

  private cell(value: number): number {
    return Math.floor(value / this.tolerance);
  }
}

/** The share of `path`'s points that lie on the indexed path; stops counting once below `atLeast`. */
function shareOn(path: Coordinate[], index: PathIndex, atLeast = 0): number {
  const allowedMisses = Math.floor(path.length * (1 - atLeast));
  let misses = 0;
  for (const point of path) {
    if (index.locate(point)) continue;
    if (++misses > allowedMisses) return 0;
  }
  return path.length > 0 ? 1 - misses / path.length : 0;
}

/** Whether `path` goes along the indexed path the same way, not against it. */
function sameDirection(path: Coordinate[], index: PathIndex): boolean {
  const positions: number[] = [];
  for (const share of [0.2, 0.5, 0.8]) {
    const located = index.locate(path[Math.round(share * (path.length - 1))]!, share * index.length);
    if (located) positions.push(located.along);
  }
  if (positions.length < 2) return false;
  return positions.every((along, i) => i === 0 || along > positions[i - 1]!);
}

/** Same roads, the same way, from about the same start to about the same end. */
export function sameRoute(a: RideTrip, b: RideTrip, indexOf: (trip: RideTrip) => PathIndex): boolean {
  if (Math.max(a.lengthMeters, b.lengthMeters) > MAX_LENGTH_RATIO * Math.min(a.lengthMeters, b.lengthMeters)) {
    return false;
  }
  const ia = indexOf(a);
  const ib = indexOf(b);
  if (haversineMeters(a.path[0]!, b.path[0]!) > Math.max(a.lengthMeters, b.lengthMeters) + ib.tolerance) {
    return false;
  }
  return (
    shareOn(a.path, ib, SAME_ROUTE_SHARE) >= SAME_ROUTE_SHARE &&
    shareOn(b.path, ia, SAME_ROUTE_SHARE) >= SAME_ROUTE_SHARE &&
    sameDirection(a.path, ib)
  );
}

/** Trips that ride the same route, each group oldest first. */
export function groupRoutes(trips: RideTrip[]): RideTrip[][] {
  const indexes = new Map<string, PathIndex>();
  const indexOf = (trip: RideTrip) => {
    let index = indexes.get(trip.id);
    if (!index) {
      index = new PathIndex(trip.path);
      indexes.set(trip.id, index);
    }
    return index;
  };
  const groups: RideTrip[][] = [];
  for (const trip of [...trips].sort((a, b) => a.departedAt - b.departedAt)) {
    // Compared with each route's first ride, so routes don't creep into each other.
    const group = groups.find((members) => sameRoute(trip, members[0]!, indexOf));
    if (group) group.push(trip);
    else groups.push([trip]);
  }
  return groups;
}

/** A place rides start or end at. */
export interface PlaceCluster {
  id: string;
  center: Coordinate;
  /** Trips that start here. */
  departures: string[];
  /** Trips that end here. */
  arrivals: string[];
}

/**
 * Gathers the starts and ends of trips into places. `seeds` (places the
 * rider named) stay where they are; others sit at the middle of their trips' ends.
 */
export function clusterPlaces(
  trips: RideTrip[],
  seeds: Array<{ id: string; coordinate: Coordinate }> = [],
  radius = PLACE_RADIUS_M,
): PlaceCluster[] {
  const places = seeds.map((seed) => ({
    id: seed.id,
    center: seed.coordinate,
    fixed: true,
    sum: [0, 0],
    count: 0,
    departures: [] as string[],
    arrivals: [] as string[],
  }));
  for (const trip of [...trips].sort((a, b) => a.departedAt - b.departedAt)) {
    for (const end of ['start', 'end'] as const) {
      const point = end === 'start' ? trip.path[0]! : trip.path[trip.path.length - 1]!;
      let nearest: (typeof places)[number] | null = null;
      let nearestMeters = radius;
      for (const place of places) {
        const meters = haversineMeters(point, place.center);
        if (meters <= nearestMeters) {
          nearest = place;
          nearestMeters = meters;
        }
      }
      if (!nearest) {
        nearest = { id: `${trip.id}:${end}`, center: point, fixed: false, sum: [0, 0], count: 0, departures: [], arrivals: [] };
        places.push(nearest);
      }
      (end === 'start' ? nearest.departures : nearest.arrivals).push(trip.id);
      nearest.sum = [nearest.sum[0]! + point[0], nearest.sum[1]! + point[1]];
      nearest.count += 1;
      if (!nearest.fixed) nearest.center = [nearest.sum[0]! / nearest.count, nearest.sum[1]! / nearest.count];
    }
  }
  return places.map(({ id, center, departures, arrivals }) => ({ id, center, departures, arrivals }));
}

function fixDistance(a: TrackFix, b: TrackFix): number {
  return haversineMeters([a.lon, a.lat], [b.lon, b.lat]);
}

function minMax(a: number, b: number): [number, number] {
  return a < b ? [a, b] : [b, a];
}
