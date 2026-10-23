import type { Coordinate } from './routing-adapter';
import { haversineMeters, toRad } from './geo';

/** Target max length per OSM download + A* leg (keep under Overpass limit). */
export const ROUTE_CHUNK_MAX_M = 55_000;

/**
 * Cut a road path into consecutive slices of about `maxMeters`. Slices end
 * on path vertices (real graph nodes) and share their boundary vertex.
 */
export function splitPolyline(
  coords: Coordinate[],
  maxMeters: number,
): Coordinate[][] {
  if (coords.length < 2) return [coords];
  const slices: Coordinate[][] = [];
  let current: Coordinate[] = [coords[0]!];
  let walked = 0;
  for (let i = 1; i < coords.length; i++) {
    walked += haversineMeters(coords[i - 1]!, coords[i]!);
    current.push(coords[i]!);
    if (walked >= maxMeters && i < coords.length - 1) {
      slices.push(current);
      current = [coords[i]!];
      walked = 0;
    }
  }
  // Fold a short tail into the previous slice instead of a tiny last leg.
  const last = slices[slices.length - 1];
  if (last && walked < maxMeters * 0.25) {
    last.push(...current.slice(1));
  } else {
    slices.push(current);
  }
  return slices;
}

/** True when the direct trip needs more than one download/routing leg. */
export function needsRouteChunking(
  start: Coordinate,
  end: Coordinate,
  waypoints: Coordinate[] = [],
  maxChunkMeters = ROUTE_CHUNK_MAX_M,
): boolean {
  const points = [start, ...waypoints, end];
  for (let i = 1; i < points.length; i++) {
    if (haversineMeters(points[i - 1]!, points[i]!) > maxChunkMeters) {
      return true;
    }
  }
  return waypoints.length > 0;
}

/** Spherical interpolation along the great-circle from a → b (f in 0..1). */
export function interpolateGeodesic(
  a: Coordinate,
  b: Coordinate,
  f: number,
): Coordinate {
  if (f <= 0) return a;
  if (f >= 1) return b;

  const lat1 = toRad(a[1]);
  const lon1 = toRad(a[0]);
  const lat2 = toRad(b[1]);
  const lon2 = toRad(b[0]);

  const d =
    2 *
    Math.asin(
      Math.min(
        1,
        Math.sqrt(
          Math.sin((lat2 - lat1) / 2) ** 2 +
            Math.cos(lat1) * Math.cos(lat2) * Math.sin((lon2 - lon1) / 2) ** 2,
        ),
      ),
    );

  if (d < 1e-12) return a;

  const A = Math.sin((1 - f) * d) / Math.sin(d);
  const B = Math.sin(f * d) / Math.sin(d);
  const x =
    A * Math.cos(lat1) * Math.cos(lon1) + B * Math.cos(lat2) * Math.cos(lon2);
  const y =
    A * Math.cos(lat1) * Math.sin(lon1) + B * Math.cos(lat2) * Math.sin(lon2);
  const z = A * Math.sin(lat1) + B * Math.sin(lat2);
  const lat = Math.atan2(z, Math.sqrt(x * x + y * y));
  const lon = Math.atan2(y, x);
  return [(lon * 180) / Math.PI, (lat * 180) / Math.PI];
}
