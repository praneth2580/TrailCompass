import type { CalculatedRoute, Coordinate } from './routing-adapter';
import { bearingDegrees, haversineMeters, polylineLengthMeters } from './geo';

const DEFAULT_SPEED_MPS = 11;

/**
 * Offline direct (great-circle style) route between two points.
 * Used when start/end are outside the loaded road network so we never
 * invent a nonsense path that snaps to a distant demo region.
 */
export function buildDirectRoute(
  start: Coordinate,
  end: Coordinate,
): CalculatedRoute {
  const distanceMeters = haversineMeters(start, end);
  const coordinates = densifyGeodesic(start, end, distanceMeters);
  const durationSeconds = Math.max(
    30,
    Math.round(distanceMeters / DEFAULT_SPEED_MPS),
  );
  const bearing = Math.round(bearingDegrees(start, end));

  return {
    coordinates,
    distanceMeters,
    durationSeconds,
    instructions: [
      {
        text: `Head ${bearingLabel(bearing)} toward destination`,
        distanceMeters: Math.max(1, Math.round(distanceMeters)),
        maneuver: 'depart',
      },
      {
        text: 'Arrive at destination',
        distanceMeters: 0,
        maneuver: 'arrive',
      },
    ],
  };
}

function densifyGeodesic(
  start: Coordinate,
  end: Coordinate,
  distanceMeters: number,
): Coordinate[] {
  if (distanceMeters < 2) return [start, end];

  // ~250 m between samples, capped for long hauls.
  const steps = Math.max(2, Math.min(128, Math.ceil(distanceMeters / 250)));
  const coords: Coordinate[] = [start];

  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    coords.push(interpolateCoordinate(start, end, t));
  }
  coords.push(end);
  return coords;
}

/** Linear interpolation in lon/lat — good enough for regional touring legs. */
function interpolateCoordinate(
  a: Coordinate,
  b: Coordinate,
  t: number,
): Coordinate {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

function bearingLabel(bearing: number): string {
  const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'] as const;
  const idx = Math.round(bearing / 45) % 8;
  return dirs[idx]!;
}

export function routeLengthOk(route: CalculatedRoute): boolean {
  return (
    route.coordinates.length >= 2 &&
    polylineLengthMeters(route.coordinates) >= 0
  );
}
