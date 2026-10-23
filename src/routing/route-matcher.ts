import type { CalculatedRoute, Coordinate } from './routing-adapter';
import { projectOntoPolyline, type PolylineProjection } from './geo';

/** Base distance from the route before the rider counts as off route. */
export const OFF_ROUTE_THRESHOLD_M = 50;
/** How far past a stop the rider must be before it counts as visited. */
export const WAYPOINT_PASSED_MARGIN_M = 30;
/** Fallback speed when a route has no usable planned duration. */
const FALLBACK_SPEED_MPS = 11;

export interface MatchResult {
  /** Index of the vertex that starts the matched route segment. */
  nearestIndex: number;
  distanceMeters: number;
  /** Distance from the route start to the matched point. */
  alongMeters: number;
  /** Closest point on the route. */
  point: Coordinate | null;
  /** True when the rider appears to have left the planned route. */
  offRoute: boolean;
}

/**
 * Finds the closest point on a route polyline to the current position.
 * A poor GPS fix widens the off-route threshold so jitter alone does not
 * trigger a reroute.
 */
export function matchPositionToRoute(
  position: Coordinate,
  route: Coordinate[],
  options: { accuracyMeters?: number | null; thresholdMeters?: number } = {},
): MatchResult {
  const projection: PolylineProjection | null = projectOntoPolyline(
    position,
    route,
  );
  if (!projection) {
    return {
      nearestIndex: -1,
      distanceMeters: Infinity,
      alongMeters: 0,
      point: null,
      offRoute: true,
    };
  }

  const threshold = offRouteThresholdMeters(
    options.accuracyMeters,
    options.thresholdMeters,
  );
  return {
    nearestIndex: projection.segmentIndex,
    distanceMeters: projection.distanceToRouteMeters,
    alongMeters: projection.alongMeters,
    point: projection.point,
    offRoute: projection.distanceToRouteMeters > threshold,
  };
}

export function offRouteThresholdMeters(
  accuracyMeters?: number | null,
  base = OFF_ROUTE_THRESHOLD_M,
): number {
  if (accuracyMeters == null || !Number.isFinite(accuracyMeters)) return base;
  return Math.max(base, accuracyMeters * 1.5);
}

/**
 * Distance along the route to each waypoint, in visit order. Each search
 * covers only the route after the previous waypoint's matched point, so an
 * out-and-back road cannot match a later stop to the outbound pass.
 */
export function waypointPositionsAlong(
  waypoints: Coordinate[],
  route: Coordinate[],
): number[] {
  const positions: number[] = [];
  let remaining = route;
  let offsetMeters = 0;
  for (const waypoint of waypoints) {
    const projection = projectOntoPolyline(waypoint, remaining);
    if (!projection) {
      positions.push(offsetMeters);
      continue;
    }
    offsetMeters += projection.alongMeters;
    positions.push(offsetMeters);
    remaining = [
      projection.point,
      ...remaining.slice(projection.segmentIndex + 1),
    ];
  }
  return positions;
}

/** How many leading waypoints the rider has already ridden past. */
export function countPassedWaypoints(
  waypointAlong: number[],
  currentAlongMeters: number,
  marginMeters = WAYPOINT_PASSED_MARGIN_M,
): number {
  let passed = 0;
  while (
    passed < waypointAlong.length &&
    currentAlongMeters >= waypointAlong[passed]! + marginMeters
  ) {
    passed += 1;
  }
  return passed;
}

/** Remaining time, scaled from the route's own planned pace. */
export function remainingDurationSeconds(
  route: Pick<CalculatedRoute, 'distanceMeters' | 'durationSeconds'>,
  remainingMeters: number,
): number {
  if (route.distanceMeters > 0 && route.durationSeconds > 0) {
    return Math.round(
      (route.durationSeconds * remainingMeters) / route.distanceMeters,
    );
  }
  return Math.round(remainingMeters / FALLBACK_SPEED_MPS);
}
