import type { Coordinate } from './routing-adapter';

export interface MatchResult {
  /** Index of the nearest coordinate on the route polyline. */
  nearestIndex: number;
  distanceMeters: number;
  /** True when the rider appears to have left the planned route. */
  offRoute: boolean;
}

const EARTH_RADIUS_M = 6_371_000;

function haversineMeters(a: Coordinate, b: Coordinate): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b[1] - a[1]);
  const dLon = toRad(b[0] - a[0]);
  const lat1 = toRad(a[1]);
  const lat2 = toRad(b[1]);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

/**
 * Finds the nearest point on a route polyline to the current position.
 * Off-route threshold is a simple distance check until a real matcher exists.
 */
export function matchPositionToRoute(
  position: Coordinate,
  route: Coordinate[],
  offRouteThresholdMeters = 50,
): MatchResult {
  if (route.length === 0) {
    return { nearestIndex: -1, distanceMeters: Infinity, offRoute: true };
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

  return {
    nearestIndex,
    distanceMeters: best,
    offRoute: best > offRouteThresholdMeters,
  };
}
