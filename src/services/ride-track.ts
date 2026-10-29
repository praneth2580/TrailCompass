import type { Coordinate } from '../routing/routing-adapter';
import { haversineMeters } from '../routing/geo';

/**
 * A recorded ride's track: the raw file the recorder writes, the ride's
 * statistics, a compact form to keep, and GPX for other apps.
 *
 * Raw lines (RideRecorderService.java writes the same):
 *   time,lat,lon,accuracy,altitude,speed,bearing,satellites
 *   #pause,time   #resume,time   #end,time
 */

/** One recorded position. `t` is ms since 1970. */
export interface TrackFix {
  t: number;
  lat: number;
  lon: number;
  acc?: number;
  alt?: number;
  speed?: number;
}

/** Fixes less precise than this don't count (as in RideRecorderService). */
const MAX_ACCURACY_M = 30;
/** Smaller moves are GPS drift while standing still. */
const MIN_STEP_M = 5;
/** Slower than this (3.6 km/h) is stopped, not riding. */
const MOVING_MPS = 1;
/** Speed and height only from good fixes. */
const GOOD_ACCURACY_M = 20;
/** 250 km/h: anything faster is a glitch. */
const MAX_PLAUSIBLE_MPS = 70;
/** Height changes smaller than this are GPS noise. */
const CLIMB_STEP_M = 10;
/** How far the kept track may stray from the recorded one. */
const SIMPLIFY_METERS = 3;

/** Splits the raw file into stretches between pauses. */
export function parseRawTrack(text: string): TrackFix[][] {
  const segments: TrackFix[][] = [[]];
  for (const line of text.split('\n')) {
    if (!line) continue;
    if (line.startsWith('#')) {
      if (line.startsWith('#pause') && segments[segments.length - 1]!.length > 0) segments.push([]);
      continue;
    }
    const [t, lat, lon, acc, alt, speed] = line.split(',');
    const fix: TrackFix = { t: Number(t), lat: Number(lat), lon: Number(lon) };
    if (![fix.t, fix.lat, fix.lon].every(Number.isFinite)) continue;
    if (acc) fix.acc = Number(acc);
    if (alt) fix.alt = Number(alt);
    if (speed) fix.speed = Number(speed);
    segments[segments.length - 1]!.push(fix);
  }
  return segments.filter((segment) => segment.length > 0);
}

/** A fix as a raw line, for the recorder that runs in a browser. */
export function rawLine(fix: TrackFix): string {
  const optional = (value: number | undefined, digits: number) => (value == null ? '' : value.toFixed(digits));
  return `${Math.round(fix.t)},${fix.lat.toFixed(7)},${fix.lon.toFixed(7)},${optional(fix.acc, 1)},${optional(fix.alt, 1)},${optional(fix.speed, 2)},,\n`;
}

/**
 * Distance as the ride goes: only precise fixes, and only moves bigger
 * than the GPS's own wobble.
 */
export class DistanceCounter {
  distanceMeters = 0;
  private last: TrackFix | null = null;

  /** Returns true when the fix becomes part of the track. */
  add(fix: TrackFix): boolean {
    const acc = fix.acc ?? 0;
    if (acc > MAX_ACCURACY_M) return false;
    if (!this.last) {
      this.last = fix;
      return true;
    }
    const step = haversineMeters([this.last.lon, this.last.lat], [fix.lon, fix.lat]);
    if (step < Math.max(MIN_STEP_M, acc)) return false;
    this.distanceMeters += step;
    this.last = fix;
    return true;
  }

  /** After a pause, the next fix starts afresh. */
  break(): void {
    this.last = null;
  }
}

export interface RideSummary {
  distanceMeters: number;
  movingSeconds: number;
  maxSpeedMps: number;
  climbMeters: number;
  /** The kept track, simplified, split at pauses. */
  segments: TrackFix[][];
  /** [west, south, east, north] */
  bbox: [number, number, number, number] | null;
}

export function summarizeTrack(raw: TrackFix[][]): RideSummary {
  const counter = new DistanceCounter();
  let movingSeconds = 0;
  let maxReported = 0;
  let maxDerived = 0;
  let climbMeters = 0;
  const segments: TrackFix[][] = [];

  for (const segment of raw) {
    counter.break();
    const kept: TrackFix[] = [];
    const reported: number[] = [];
    const derived: number[] = [];
    let climbFrom: number | null = null;
    for (const fix of segment) {
      const acc = fix.acc ?? 0;
      if (acc <= GOOD_ACCURACY_M) {
        // A lone spike doesn't count: the middle of three in a row.
        if (fix.speed != null) maxReported = Math.max(maxReported, middleOfLastThree(reported, fix.speed));
        if (fix.alt != null) {
          if (climbFrom == null || climbFrom - fix.alt >= CLIMB_STEP_M) climbFrom = fix.alt;
          else if (fix.alt - climbFrom >= CLIMB_STEP_M) {
            climbMeters += fix.alt - climbFrom;
            climbFrom = fix.alt;
          }
        }
      }
      const before = counter.distanceMeters;
      const previous = kept[kept.length - 1];
      if (!counter.add(fix)) continue;
      if (previous) {
        const seconds = (fix.t - previous.t) / 1000;
        const speed = seconds > 0 ? (counter.distanceMeters - before) / seconds : 0;
        if (speed >= MOVING_MPS) movingSeconds += seconds;
        maxDerived = Math.max(maxDerived, middleOfLastThree(derived, speed));
      }
      kept.push(fix);
    }
    if (kept.length > 0) segments.push(simplify(kept, SIMPLIFY_METERS));
  }

  // GPS-reported speed is accurate; worked-out speed is the fallback (browsers rarely report speed).
  const maxSpeed = maxReported > 0 ? maxReported : maxDerived;
  return {
    distanceMeters: counter.distanceMeters,
    movingSeconds: Math.round(movingSeconds),
    maxSpeedMps: maxSpeed <= MAX_PLAUSIBLE_MPS ? maxSpeed : 0,
    climbMeters: Math.round(climbMeters),
    segments,
    bbox: bboxOf(segments),
  };
}

function middleOfLastThree(values: number[], next: number): number {
  values.push(next);
  if (values.length > 3) values.shift();
  if (values.length < 3) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted[1]!;
  return middle <= MAX_PLAUSIBLE_MPS ? middle : 0;
}

function bboxOf(segments: TrackFix[][]): [number, number, number, number] | null {
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (const fix of segments.flat()) {
    west = Math.min(west, fix.lon);
    east = Math.max(east, fix.lon);
    south = Math.min(south, fix.lat);
    north = Math.max(north, fix.lat);
  }
  return Number.isFinite(west) ? [west, south, east, north] : null;
}

/** Douglas–Peucker: drops points within `tolerance` metres of the line through their neighbours. */
export function simplify(points: TrackFix[], tolerance: number): TrackFix[] {
  if (points.length <= 2) return points;
  const lat0 = (points[0]!.lat * Math.PI) / 180;
  const xy = points.map((p) => [p.lon * 111_320 * Math.cos(lat0), p.lat * 110_540] as const);
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack: Array<[number, number]> = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [first, last] = stack.pop()!;
    const [ax, ay] = xy[first]!;
    const [bx, by] = xy[last]!;
    const dx = bx - ax;
    const dy = by - ay;
    const length2 = dx * dx + dy * dy;
    let farthest = -1;
    let farthestDistance = tolerance;
    for (let i = first + 1; i < last; i++) {
      const [px, py] = xy[i]!;
      const t = length2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / length2)) : 0;
      const distance = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
      if (distance > farthestDistance) {
        farthest = i;
        farthestDistance = distance;
      }
    }
    if (farthest >= 0) {
      keep[farthest] = 1;
      stack.push([first, farthest], [farthest, last]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

/** A kept track, compact: per segment, Google-polyline-style numbers. */
export interface StoredTrack {
  v: 1;
  segments: Array<{ coords: string; times: string; ele?: string }>;
}

export function encodeTrack(segments: TrackFix[][], startedAt: number): StoredTrack {
  return {
    v: 1,
    segments: segments.map((segment) => {
      const withEle = segment.every((fix) => fix.alt != null);
      return {
        coords: encodeDeltas(segment.flatMap((fix) => [Math.round(fix.lat * 1e5), Math.round(fix.lon * 1e5)]), 2),
        times: encodeDeltas(segment.map((fix) => Math.round((fix.t - startedAt) / 1000)), 1),
        ...(withEle ? { ele: encodeDeltas(segment.map((fix) => Math.round(fix.alt!)), 1) } : {}),
      };
    }),
  };
}

export function decodeTrack(track: StoredTrack, startedAt: number): TrackFix[][] {
  return track.segments.map((segment) => {
    const coords = decodeDeltas(segment.coords, 2);
    const times = decodeDeltas(segment.times, 1);
    const ele = segment.ele ? decodeDeltas(segment.ele, 1) : null;
    return times.map((seconds, i) => ({
      t: startedAt + seconds * 1000,
      lat: coords[i * 2]! / 1e5,
      lon: coords[i * 2 + 1]! / 1e5,
      ...(ele ? { alt: ele[i]! } : {}),
    }));
  });
}

/**
 * Integers as the Google polyline format writes them: each the change
 * from the value `stride` places before, zigzag, in 5-bit chunks.
 */
function encodeDeltas(values: number[], stride: number): string {
  let out = '';
  values.forEach((value, i) => {
    let delta = value - (i >= stride ? values[i - stride]! : 0);
    delta = delta < 0 ? ~(delta * 2) : delta * 2;
    while (delta >= 0x20) {
      out += String.fromCharCode((0x20 | (delta & 0x1f)) + 63);
      delta = Math.floor(delta / 32);
    }
    out += String.fromCharCode(delta + 63);
  });
  return out;
}

function decodeDeltas(text: string, stride: number): number[] {
  const values: number[] = [];
  let i = 0;
  while (i < text.length) {
    let result = 0;
    let shift = 1;
    let byte: number;
    do {
      byte = text.charCodeAt(i++) - 63;
      result += (byte & 0x1f) * shift;
      shift *= 32;
    } while (byte >= 0x20);
    const delta = result % 2 === 1 ? -(result + 1) / 2 : result / 2;
    const n = values.length;
    values.push(delta + (n >= stride ? values[n - stride]! : 0));
  }
  return values;
}

/** GPX 1.1, for Strava, OsmAnd, Google Earth and the like. */
export function toGpx(name: string, segments: TrackFix[][]): string {
  const escape = (text: string) =>
    text.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]!);
  const first = segments[0]?.[0];
  const points = (segment: TrackFix[]) =>
    segment
      .map(
        (fix) =>
          `      <trkpt lat="${fix.lat.toFixed(6)}" lon="${fix.lon.toFixed(6)}">` +
          (fix.alt != null ? `<ele>${fix.alt.toFixed(0)}</ele>` : '') +
          `<time>${new Date(fix.t).toISOString()}</time></trkpt>`,
      )
      .join('\n');
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<gpx version="1.1" creator="TrailCompass" xmlns="http://www.topografix.com/GPX/1/1">',
    `  <metadata><name>${escape(name)}</name>${first ? `<time>${new Date(first.t).toISOString()}</time>` : ''}</metadata>`,
    `  <trk><name>${escape(name)}</name><type>motorcycling</type>`,
    ...segments.map((segment) => `    <trkseg>\n${points(segment)}\n    </trkseg>`),
    '  </trk>',
    '</gpx>',
    '',
  ].join('\n');
}

/** "Morning ride", "Evening ride"… by when it started. */
export function rideName(startedAt: Date): string {
  const hour = startedAt.getHours();
  if (hour >= 5 && hour < 12) return 'Morning ride';
  if (hour >= 12 && hour < 17) return 'Afternoon ride';
  if (hour >= 17 && hour < 21) return 'Evening ride';
  return 'Night ride';
}

/** Up to `max` evenly spaced points, for a thumbnail. */
export function previewLine(segments: TrackFix[][], max = 80): Coordinate[] {
  const all = segments.flat();
  const step = Math.max(1, Math.ceil(all.length / max));
  return all.filter((_, i) => i % step === 0 || i === all.length - 1).map((fix) => [fix.lon, fix.lat]);
}
