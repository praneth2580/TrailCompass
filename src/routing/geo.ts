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
