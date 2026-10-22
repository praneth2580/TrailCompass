import type { Coordinate } from './routing-adapter';
import { haversineMeters } from './geo';

export interface MatchResult {
  /** Index of the nearest coordinate on the route polyline. */
  nearestIndex: number;
  distanceMeters: number;
  /** True when the rider appears to have left the planned route. */
  offRoute: boolean;
}

/**
 * Finds the nearest point on a route polyline to the current position.
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
