import type { Coordinate } from '../routing/routing-adapter';
import type { PolylineProjection } from '../routing/geo';
import { toRad, turnAngleDegrees } from '../routing/geo';

/** Below this speed (~7 km/h) the GPS course is mostly noise. */
const COURSE_MIN_SPEED_MPS = 2;
/** A course this far from the road's direction means riding the other way. */
const AGAINST_ROUTE_DEG = 100;

/**
 * Which way the rider arrow (and the navigation camera) points. On the
 * route it follows the road, unless the GPS course says the rider is going
 * the other way; off it, the GPS course while moving. Null means no
 * direction is known, and the last one should stay.
 */
export function riderHeadingDegrees(input: {
  courseDegrees?: number | null;
  speedMps?: number | null;
  routeBearingDegrees?: number | null;
}): number | null {
  const moving = input.speedMps == null || input.speedMps >= COURSE_MIN_SPEED_MPS;
  const course =
    moving && isFiniteNumber(input.courseDegrees) ? input.courseDegrees : null;
  const road = isFiniteNumber(input.routeBearingDegrees)
    ? input.routeBearingDegrees
    : null;
  if (road == null) return course;
  if (course != null && Math.abs(turnAngleDegrees(road, course)) > AGAINST_ROUTE_DEG) {
    return course;
  }
  return road;
}

/** Navigation zoom by speed (m/s): street detail when slow, more road ahead when fast. */
const NAV_ZOOM_BY_SPEED: Array<[speedMps: number, zoom: number]> = [
  [4, 17], // ~15 km/h
  [11, 16.4], // ~40 km/h
  [19.5, 15.7], // ~70 km/h
  [28, 15], // ~100 km/h
];

export function navigationZoomForSpeed(speedMps: number | null | undefined): number {
  const speed = isFiniteNumber(speedMps) ? Math.max(0, speedMps) : 0;
  const first = NAV_ZOOM_BY_SPEED[0]!;
  if (speed <= first[0]) return first[1];
  for (let i = 1; i < NAV_ZOOM_BY_SPEED.length; i++) {
    const [s1, z1] = NAV_ZOOM_BY_SPEED[i]!;
    if (speed <= s1) {
      const [s0, z0] = NAV_ZOOM_BY_SPEED[i - 1]!;
      return z0 + ((speed - s0) / (s1 - s0)) * (z1 - z0);
    }
  }
  return NAV_ZOOM_BY_SPEED[NAV_ZOOM_BY_SPEED.length - 1]![1];
}

/** `k` of the way from `from` to `to` (0–1), turning the short way round. */
export function interpolateAngle(from: number, to: number, k: number): number {
  return normalizeDegrees(from + turnAngleDegrees(from, to) * k);
}

export function normalizeDegrees(degrees: number): number {
  return ((degrees % 360) + 360) % 360;
}

/**
 * Running length of the route in Web Mercator units. MapLibre measures
 * `line-progress` this way, so the grey "already ridden" part of the route
 * ends right under the rider even on long north–south routes.
 */
export function mercatorCumulativeLengths(route: Coordinate[]): number[] {
  const lengths: number[] = [];
  let total = 0;
  let previous: [number, number] | null = null;
  for (const coordinate of route) {
    const point = toMercator(coordinate);
    if (previous) total += Math.hypot(point[0] - previous[0], point[1] - previous[1]);
    lengths.push(total);
    previous = point;
  }
  return lengths;
}

/** Share of the drawn route behind the rider (0–1), in `line-progress` terms. */
export function lineProgressAt(
  route: Coordinate[],
  cumulative: number[],
  at: Pick<PolylineProjection, 'segmentIndex' | 'point'>,
): number {
  const total = cumulative[cumulative.length - 1] ?? 0;
  const start = route[at.segmentIndex];
  if (total <= 0 || !start) return 0;
  const a = toMercator(start);
  const p = toMercator(at.point);
  const along = (cumulative[at.segmentIndex] ?? 0) + Math.hypot(p[0] - a[0], p[1] - a[1]);
  return Math.min(1, Math.max(0, along / total));
}

function toMercator([lng, lat]: Coordinate): [number, number] {
  const sin = Math.sin(toRad(lat));
  return [(lng + 180) / 360, 0.5 - (0.25 * Math.log((1 + sin) / (1 - sin))) / Math.PI];
}

function isFiniteNumber(value: number | null | undefined): value is number {
  return value != null && Number.isFinite(value);
}
