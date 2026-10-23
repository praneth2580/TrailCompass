import type { Coordinate } from './routing-adapter';
import { haversineMeters } from './geo';

/**
 * Where a downloaded road network actually has roads. A bbox download
 * fills its whole box; a corridor download only fills circles around
 * sample points, even though its bbox spans the full diagonal.
 */
export type NetworkCoverage =
  | { kind: 'bbox' }
  | { kind: 'corridor'; samples: Coordinate[]; radiusMeters: number };

/** Keep away from the circle edge, where roads may be cut off. */
const CORRIDOR_EDGE_FACTOR = 0.8;

export function bboxCoversPoints(
  bbox: [west: number, south: number, east: number, north: number],
  points: Coordinate[],
  padDeg = 0,
): boolean {
  const [west, south, east, north] = bbox;
  for (const [lng, lat] of points) {
    if (
      lng < west - padDeg ||
      lng > east + padDeg ||
      lat < south - padDeg ||
      lat > north + padDeg
    ) {
      return false;
    }
  }
  return true;
}

/**
 * True when every point falls where the network has roads. Networks saved
 * before coverage was recorded are treated as bbox downloads.
 */
export function coverageIncludesPoints(
  coverage: NetworkCoverage | undefined,
  points: Coordinate[],
): boolean {
  if (!coverage || coverage.kind === 'bbox') return true;
  const reach = coverage.radiusMeters * CORRIDOR_EDGE_FACTOR;
  return points.every((point) =>
    coverage.samples.some((sample) => haversineMeters(point, sample) <= reach),
  );
}
