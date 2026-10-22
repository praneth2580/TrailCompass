import type { Coordinate } from './routing-adapter';
import { haversineMeters, toRad } from './geo';

/** Target max length per OSM download + A* leg (keep under Overpass limit). */
export const ROUTE_CHUNK_MAX_M = 55_000;

export interface RouteChainPoint {
  coordinate: Coordinate;
  /** Auto-inserted for long-distance chunking — may be snapped onto roads. */
  synthetic: boolean;
}

/**
 * Expand start → waypoints → end with geodesic vias so consecutive hops
 * stay under `maxChunkMeters`. User waypoints are never dropped.
 */
export function expandRouteChain(
  start: Coordinate,
  end: Coordinate,
  waypoints: Coordinate[] = [],
  maxChunkMeters = ROUTE_CHUNK_MAX_M,
): RouteChainPoint[] {
  const anchors: RouteChainPoint[] = [
    { coordinate: start, synthetic: false },
    ...waypoints.map((coordinate) => ({ coordinate, synthetic: false })),
    { coordinate: end, synthetic: false },
  ];

  const chain: RouteChainPoint[] = [anchors[0]!];
  for (let i = 1; i < anchors.length; i++) {
    const from = anchors[i - 1]!.coordinate;
    const to = anchors[i]!;
    for (const via of splitSegment(from, to.coordinate, maxChunkMeters)) {
      chain.push({ coordinate: via, synthetic: true });
    }
    chain.push(to);
  }
  return chain;
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

function splitSegment(
  a: Coordinate,
  b: Coordinate,
  maxChunkMeters: number,
): Coordinate[] {
  const dist = haversineMeters(a, b);
  if (dist <= maxChunkMeters) return [];
  const parts = Math.ceil(dist / maxChunkMeters);
  const vias: Coordinate[] = [];
  for (let i = 1; i < parts; i++) {
    vias.push(interpolateGeodesic(a, b, i / parts));
  }
  return vias;
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
