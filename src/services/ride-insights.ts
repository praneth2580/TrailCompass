import type { Coordinate } from '../routing/routing-adapter';
import { PathIndex, tripSegments } from './ride-groups';
import { ridePeriod, type RidePeriod, type TrackFix } from './ride-track';

/**
 * What several rides of one route say about it: how long it usually
 * takes, when it's quickest to leave, and where traffic slows you. The
 * route is cut into short stretches; each ride's time on each stretch
 * comes from its track, and the stretch's typical speed is the middle of those.
 */

/** How the route is cut up: stretches of this length, or longer on long routes. */
const MIN_STRETCH_M = 100;
const MAX_STRETCH_M = 1_000;
const TARGET_STRETCHES = 150;
/** A ride counts on a stretch when it was tracked along at least this share of it. */
const MIN_STRETCH_SHARE = 0.5;
/** GPS wobbling back along the route by up to this is standing still, not going back. */
const WOBBLE_BACK_M = 40;
/** Slower than this, a stretch is slow whatever the road. */
const SLOW_KMH = 20;
/** Or slower than this share of the route's usual cruising speed. */
const SLOW_SHARE_OF_CRUISE = 0.45;
/** Slow stretches costing less than this aren't worth listing. */
const MIN_LOST_SECONDS = 30;
const MAX_SLOW_SPOTS = 5;

/** A stretch's usual traffic, by its typical speed. */
export type TrafficLevel = 'clear' | 'moderate' | 'slow' | 'jammed';

/** The lower bound (km/h) of each level, fastest first. */
export const TRAFFIC_LEVELS: Array<{ level: TrafficLevel; minKmh: number }> = [
  { level: 'clear', minKmh: 35 },
  { level: 'moderate', minKmh: 20 },
  { level: 'slow', minKmh: 10 },
  { level: 'jammed', minKmh: 0 },
];

/**
 * Status colours (good → critical), for the map and its key; grey where
 * no ride was tracked. On the light map they sit on a dark casing.
 */
export const TRAFFIC_COLORS: Record<TrafficLevel | 'none', string> = {
  clear: '#0ca30c',
  moderate: '#fab219',
  slow: '#ec835a',
  jammed: '#d03b3b',
  none: '#8b939c',
};

export function trafficLevel(kmh: number): TrafficLevel {
  return TRAFFIC_LEVELS.find(({ minKmh }) => kmh >= minKmh)?.level ?? 'jammed';
}

/** One ride of the route: its id and its kept track. */
export interface RouteRide {
  id: string;
  segments: TrackFix[][];
}

/** A short stretch of the route. Positions are metres from its start. */
export interface RouteStretch {
  from: number;
  to: number;
  /** Rides tracked along it. */
  rides: number;
  /** The middle of their times on it; null with none. */
  typicalSeconds: number | null;
  bestSeconds: number | null;
  speedKmh: number | null;
  level: TrafficLevel | null;
}

/** A run of slow stretches. */
export interface SlowSpot {
  from: number;
  to: number;
  /** Its middle, to name it and show it. */
  center: Coordinate;
  line: Coordinate[];
  typicalSeconds: number;
  bestSeconds: number;
  speedKmh: number;
  /** Usual time lost here against the route's cruising speed. */
  lostSeconds: number;
  rides: number;
}

export interface RideTiming {
  id: string;
  /** When the rider set off (ms). */
  departedAt: number;
  /** Setting off to arriving, pauses and breaks left out. */
  seconds: number;
}

export interface RouteAnalysis {
  lengthMeters: number;
  /** The rides, newest first. */
  rides: RideTiming[];
  typicalSeconds: number;
  bestSeconds: number;
  slowestSeconds: number;
  stretches: RouteStretch[];
  /** Worst first. */
  slowSpots: SlowSpot[];
  /** By the hour the rides set off, earliest hour first. */
  byHour: Array<{ hour: number; typicalSeconds: number; rides: number }>;
}

/** How several rides went along `reference` (one of them, as a path). */
export function analyzeRoute(reference: Coordinate[], rides: RouteRide[]): RouteAnalysis {
  const index = new PathIndex(reference);
  const count = Math.max(1, Math.round(index.length / clamp(index.length / TARGET_STRETCHES, MIN_STRETCH_M, MAX_STRETCH_M)));
  const size = index.length / count;
  const samples: number[][] = Array.from({ length: count }, () => []);
  const timings: RideTiming[] = [];

  for (const ride of rides) {
    const parts = tripSegments(ride.segments);
    if (parts.length === 0) continue;
    timings.push({
      id: ride.id,
      departedAt: parts[0]![0]!.t,
      seconds: Math.round(parts.reduce((sum, part) => sum + part[part.length - 1]!.t - part[0]!.t, 0) / 1000),
    });
    const seconds = new Float64Array(count);
    const meters = new Float64Array(count);
    const spend = (from: number, to: number, dt: number) => {
      if (to - from < 1) {
        seconds[Math.min(count - 1, Math.floor(from / size))]! += dt;
        return;
      }
      for (let k = Math.floor(from / size); k < count && k * size < to; k++) {
        const overlap = Math.min(to, (k + 1) * size) - Math.max(from, k * size);
        if (overlap <= 0) continue;
        seconds[k]! += (dt * overlap) / (to - from);
        meters[k]! += overlap;
      }
    };

    let expected = 0;
    for (const part of parts) {
      let previous: { along: number; t: number } | null = null;
      for (const fix of part) {
        const located = index.locate([fix.lon, fix.lat], expected);
        if (!located) {
          // Off the route: a detour's time isn't put on any stretch.
          previous = null;
          continue;
        }
        if (previous && located.along >= previous.along - WOBBLE_BACK_M) {
          const to = Math.max(previous.along, located.along);
          spend(previous.along, to, (fix.t - previous.t) / 1000);
          previous = { along: to, t: fix.t };
        } else {
          previous = { along: located.along, t: fix.t };
        }
        expected = previous.along;
      }
    }

    for (let k = 0; k < count; k++) {
      if (meters[k]! >= MIN_STRETCH_SHARE * size && seconds[k]! > 0) samples[k]!.push((size * seconds[k]!) / meters[k]!);
    }
  }

  const stretches: RouteStretch[] = samples.map((times, k) => {
    const typical = times.length > 0 ? median(times) : null;
    const speedKmh = typical ? (size / typical) * 3.6 : null;
    return {
      from: k * size,
      to: (k + 1) * size,
      rides: times.length,
      typicalSeconds: typical,
      bestSeconds: times.length > 0 ? Math.min(...times) : null,
      speedKmh,
      level: speedKmh == null ? null : trafficLevel(speedKmh),
    };
  });

  const tripSeconds = timings.map((timing) => timing.seconds);
  const hours = new Map<number, number[]>();
  for (const timing of timings) {
    const hour = new Date(timing.departedAt).getHours();
    hours.set(hour, [...(hours.get(hour) ?? []), timing.seconds]);
  }

  return {
    lengthMeters: index.length,
    rides: timings.sort((a, b) => b.departedAt - a.departedAt),
    typicalSeconds: tripSeconds.length > 0 ? Math.round(median(tripSeconds)) : 0,
    bestSeconds: tripSeconds.length > 0 ? Math.min(...tripSeconds) : 0,
    slowestSeconds: tripSeconds.length > 0 ? Math.max(...tripSeconds) : 0,
    stretches,
    slowSpots: findSlowSpots(stretches, index),
    byHour: [...hours]
      .sort(([a], [b]) => a - b)
      .map(([hour, times]) => ({ hour, typicalSeconds: Math.round(median(times)), rides: times.length })),
  };
}

/** Runs of slow stretches, worst (most time lost) first. */
function findSlowSpots(stretches: RouteStretch[], index: PathIndex): SlowSpot[] {
  const speeds = stretches.flatMap((stretch) => (stretch.speedKmh == null ? [] : [stretch.speedKmh]));
  if (speeds.length === 0) return [];
  const cruiseKmh = quantile(speeds, 0.75);
  const isSlow = (stretch: RouteStretch) =>
    stretch.speedKmh != null && (stretch.speedKmh < SLOW_KMH || stretch.speedKmh < SLOW_SHARE_OF_CRUISE * cruiseKmh);

  const runs: RouteStretch[][] = [];
  let run: RouteStretch[] = [];
  stretches.forEach((stretch, k) => {
    // One quicker stretch between two slow ones doesn't end the run.
    const bridged = !isSlow(stretch) && run.length > 0 && stretches[k + 1] != null && isSlow(stretches[k + 1]!);
    if (isSlow(stretch) || bridged) {
      run.push(stretch);
    } else if (run.length > 0) {
      runs.push(run);
      run = [];
    }
  });
  if (run.length > 0) runs.push(run);

  return runs
    .map((members) => {
      const tracked = members.filter((stretch) => stretch.typicalSeconds != null);
      const typicalSeconds = sum(tracked.map((stretch) => stretch.typicalSeconds!));
      const from = members[0]!.from;
      const to = members[members.length - 1]!.to;
      const cruiseSeconds = ((to - from) / cruiseKmh) * 3.6;
      return {
        from,
        to,
        center: index.pointAt((from + to) / 2),
        line: index.slice(from, to),
        typicalSeconds: Math.round(typicalSeconds),
        bestSeconds: Math.round(sum(tracked.map((stretch) => stretch.bestSeconds!))),
        speedKmh: typicalSeconds > 0 ? ((to - from) / typicalSeconds) * 3.6 : 0,
        lostSeconds: Math.round(Math.max(0, typicalSeconds - cruiseSeconds)),
        rides: Math.min(...tracked.map((stretch) => stretch.rides)),
      };
    })
    .filter((spot) => spot.lostSeconds >= MIN_LOST_SECONDS)
    .sort((a, b) => b.lostSeconds - a.lostSeconds)
    .slice(0, MAX_SLOW_SPOTS);
}

/** The route as lines of one traffic level each, for the map; `null` where no ride was tracked. */
export function trafficLines(
  reference: Coordinate[],
  stretches: RouteStretch[],
): Array<{ level: TrafficLevel | null; line: Coordinate[] }> {
  const index = new PathIndex(reference);
  const lines: Array<{ level: TrafficLevel | null; from: number; to: number }> = [];
  for (const stretch of stretches) {
    const last = lines[lines.length - 1];
    if (last && last.level === stretch.level) last.to = stretch.to;
    else lines.push({ level: stretch.level, from: stretch.from, to: stretch.to });
  }
  return lines.map(({ level, from, to }) => ({ level, line: index.slice(from, to) }));
}

/**
 * Ways between the same two places side by side at the same time of day,
 * quickest first: a way ridden only in the rush can't fairly be set
 * against one that also has quiet rides. Parts of the day with fewer
 * than two ways are left out.
 */
export function compareByPeriod<Way>(
  ways: Array<{ way: Way; trips: Array<{ departedAt: number; seconds: number }> }>,
): Array<{ period: RidePeriod; ways: Array<{ way: Way; typicalSeconds: number; rides: number }> }> {
  const periods: RidePeriod[] = ['morning', 'afternoon', 'evening', 'night'];
  return periods.flatMap((period) => {
    const ridden = ways
      .flatMap(({ way, trips }) => {
        const seconds = trips.filter((trip) => ridePeriod(new Date(trip.departedAt)) === period).map((trip) => trip.seconds);
        return seconds.length > 0 ? [{ way, typicalSeconds: Math.round(median(seconds)), rides: seconds.length }] : [];
      })
      .sort((a, b) => a.typicalSeconds - b.typicalSeconds);
    return ridden.length > 1 ? [{ period, ways: ridden }] : [];
  });
}

export function median(values: number[]): number {
  return quantile(values, 0.5);
}

function quantile(values: number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (sorted.length - 1) * q;
  const below = Math.floor(at);
  const above = Math.ceil(at);
  return sorted[below]! + (sorted[above]! - sorted[below]!) * (at - below);
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
