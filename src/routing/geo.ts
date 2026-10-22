import type { Coordinate } from './routing-adapter';

const EARTH_RADIUS_M = 6_371_000;

export function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

export function haversineMeters(a: Coordinate, b: Coordinate): number {
  const dLat = toRad(b[1] - a[1]);
  const dLon = toRad(b[0] - a[0]);
  const lat1 = toRad(a[1]);
  const lat2 = toRad(b[1]);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Initial bearing from a → b in degrees [0, 360). */
export function bearingDegrees(a: Coordinate, b: Coordinate): number {
  const lat1 = toRad(a[1]);
  const lat2 = toRad(b[1]);
  const dLon = toRad(b[0] - a[0]);
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x =
    Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

export function turnAngleDegrees(incoming: number, outgoing: number): number {
  return ((outgoing - incoming + 540) % 360) - 180;
}

export function polylineLengthMeters(coords: Coordinate[]): number {
  let total = 0;
  for (let i = 1; i < coords.length; i++) {
    total += haversineMeters(coords[i - 1]!, coords[i]!);
  }
  return total;
}

/**
 * Distance along a polyline from the start up to the nearest vertex
 * to `position`, plus remaining path length after that vertex.
 */
export function distanceAlongPolylineMeters(
  position: Coordinate,
  route: Coordinate[],
): { alongMeters: number; nearestIndex: number; distanceToRouteMeters: number } {
  if (route.length === 0) {
    return { alongMeters: 0, nearestIndex: -1, distanceToRouteMeters: Infinity };
  }

  let nearestIndex = 0;
  let best = Infinity;
  for (let i = 0; i < route.length; i++) {
    const d = haversineMeters(position, route[i]!);
    if (d < best) {
      best = d;
      nearestIndex = i;
    }
  }

  let along = 0;
  for (let i = 1; i <= nearestIndex; i++) {
    along += haversineMeters(route[i - 1]!, route[i]!);
  }

  return {
    alongMeters: along,
    nearestIndex,
    distanceToRouteMeters: best,
  };
}

export function remainingPolylineMeters(
  route: Coordinate[],
  fromIndex: number,
): number {
  let total = 0;
  for (let i = fromIndex + 1; i < route.length; i++) {
    total += haversineMeters(route[i - 1]!, route[i]!);
  }
  return total;
}

export function keyForCoordinate(c: Coordinate, precision = 6): string {
  return `${c[0].toFixed(precision)},${c[1].toFixed(precision)}`;
}

/**
 * Point on the polyline at `targetMeters` from the start (clamped to ends).
 */
export function pointAlongPolylineMeters(
  route: Coordinate[],
  targetMeters: number,
): { coordinate: Coordinate; alongMeters: number; index: number } | null {
  if (route.length === 0) return null;
  if (route.length === 1 || targetMeters <= 0) {
    return { coordinate: route[0]!, alongMeters: 0, index: 0 };
  }

  let walked = 0;
  for (let i = 1; i < route.length; i++) {
    const a = route[i - 1]!;
    const b = route[i]!;
    const seg = haversineMeters(a, b);
    if (walked + seg >= targetMeters) {
      const remain = targetMeters - walked;
      const t = seg > 0 ? remain / seg : 0;
      const coordinate: Coordinate = [
        a[0] + (b[0] - a[0]) * t,
        a[1] + (b[1] - a[1]) * t,
      ];
      return { coordinate, alongMeters: targetMeters, index: i - 1 };
    }
    walked += seg;
  }

  const last = route.length - 1;
  return {
    coordinate: route[last]!,
    alongMeters: walked,
    index: last,
  };
}

/** Checkpoints every `intervalMeters` along the route (excludes start; may include near-end). */
export function pointsAlongPolylineEveryMeters(
  route: Coordinate[],
  intervalMeters: number,
): Array<{ coordinate: Coordinate; alongMeters: number }> {
  if (route.length < 2 || intervalMeters <= 0) return [];
  const total = polylineLengthMeters(route);
  if (total < intervalMeters * 0.35) return [];

  const out: Array<{ coordinate: Coordinate; alongMeters: number }> = [];
  for (
    let target = intervalMeters;
    target < total - intervalMeters * 0.15;
    target += intervalMeters
  ) {
    const hit = pointAlongPolylineMeters(route, target);
    if (hit) out.push({ coordinate: hit.coordinate, alongMeters: hit.alongMeters });
  }
  return out;
}
