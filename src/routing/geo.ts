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

/**
 * Direction of travel along the route at segment `index`. Repeated
 * vertices have no direction of their own, so the next real segment is
 * used (or the previous one at the very end).
 */
export function segmentBearingDegrees(
  route: Coordinate[],
  index: number,
): number | null {
  for (let i = Math.max(0, index); i < route.length - 1; i++) {
    if (haversineMeters(route[i]!, route[i + 1]!) >= 1) {
      return bearingDegrees(route[i]!, route[i + 1]!);
    }
  }
  for (let i = Math.min(index, route.length - 1); i > 0; i--) {
    if (haversineMeters(route[i - 1]!, route[i]!) >= 1) {
      return bearingDegrees(route[i - 1]!, route[i]!);
    }
  }
  return null;
}

export function polylineLengthMeters(coords: Coordinate[]): number {
  let total = 0;
  for (let i = 1; i < coords.length; i++) {
    total += haversineMeters(coords[i - 1]!, coords[i]!);
  }
  return total;
}

export interface PolylineProjection {
  /** Index of the vertex that starts the matched segment. */
  segmentIndex: number;
  /** Position within that segment, 0 (start vertex) to 1 (end vertex). */
  t: number;
  /** Closest point on the polyline. */
  point: Coordinate;
  distanceToRouteMeters: number;
  /** Distance from the polyline start to `point`. */
  alongMeters: number;
}

/**
 * Closest point on the polyline to `position`, measured against each
 * segment (not only its vertices). Sparse rural ways can have vertices
 * hundreds of meters apart, so vertex-only matching overstates the gap.
 */
export function projectOntoPolyline(
  position: Coordinate,
  route: Coordinate[],
): PolylineProjection | null {
  if (route.length === 0) return null;
  if (route.length === 1) {
    return {
      segmentIndex: 0,
      t: 0,
      point: route[0]!,
      distanceToRouteMeters: haversineMeters(position, route[0]!),
      alongMeters: 0,
    };
  }

  // Local equirectangular plane centered on the rider: accurate to well
  // under a meter at segment scale, and cheap enough to run per GPS fix.
  const metersPerDegLat = (Math.PI / 180) * EARTH_RADIUS_M;
  const metersPerDegLon = metersPerDegLat * Math.cos(toRad(position[1]));
  const toPlane = (c: Coordinate): [number, number] => [
    (c[0] - position[0]) * metersPerDegLon,
    (c[1] - position[1]) * metersPerDegLat,
  ];

  let best: PolylineProjection | null = null;
  let walked = 0;
  for (let i = 0; i < route.length - 1; i++) {
    const a = route[i]!;
    const b = route[i + 1]!;
    const [ax, ay] = toPlane(a);
    const [bx, by] = toPlane(b);
    const dx = bx - ax;
    const dy = by - ay;
    const lengthSq = dx * dx + dy * dy;
    const t =
      lengthSq > 0
        ? Math.min(1, Math.max(0, -(ax * dx + ay * dy) / lengthSq))
        : 0;
    const point: Coordinate = [
      a[0] + (b[0] - a[0]) * t,
      a[1] + (b[1] - a[1]) * t,
    ];
    const distance = haversineMeters(position, point);
    if (!best || distance < best.distanceToRouteMeters) {
      best = {
        segmentIndex: i,
        t,
        point,
        distanceToRouteMeters: distance,
        alongMeters: walked + haversineMeters(a, point),
      };
    }
    walked += haversineMeters(a, b);
  }
  return best;
}

/**
 * Distance along a polyline from the start up to the closest point to
 * `position`. `nearestIndex` is the vertex that starts the matched segment.
 */
export function distanceAlongPolylineMeters(
  position: Coordinate,
  route: Coordinate[],
): { alongMeters: number; nearestIndex: number; distanceToRouteMeters: number } {
  const projection = projectOntoPolyline(position, route);
  if (!projection) {
    return { alongMeters: 0, nearestIndex: -1, distanceToRouteMeters: Infinity };
  }
  return {
    alongMeters: projection.alongMeters,
    nearestIndex: projection.segmentIndex,
    distanceToRouteMeters: projection.distanceToRouteMeters,
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

/** Path length from a projected point to the end of the polyline. */
export function remainingFromProjectionMeters(
  route: Coordinate[],
  projection: Pick<PolylineProjection, 'segmentIndex' | 'point'>,
): number {
  const next = route[projection.segmentIndex + 1];
  if (!next) return 0;
  return (
    haversineMeters(projection.point, next) +
    remainingPolylineMeters(route, projection.segmentIndex + 1)
  );
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

/**
 * Points every `stepMeters` between `fromMeters` and `toMeters` along the
 * route, both ends included (clamped to the route). One pass over the route.
 */
export function samplePolylineMeters(
  route: Coordinate[],
  fromMeters: number,
  toMeters: number,
  stepMeters: number,
): Array<{ coordinate: Coordinate; alongMeters: number }> {
  if (route.length === 0 || stepMeters <= 0) return [];
  const total = polylineLengthMeters(route);
  const from = Math.max(0, Math.min(fromMeters, total));
  const to = Math.max(from, Math.min(toMeters, total));

  const targets: number[] = [];
  for (let t = from; t < to; t += stepMeters) targets.push(t);
  targets.push(to);

  const out: Array<{ coordinate: Coordinate; alongMeters: number }> = [];
  let walked = 0;
  let i = 1;
  for (const target of targets) {
    while (i < route.length) {
      const seg = haversineMeters(route[i - 1]!, route[i]!);
      if (walked + seg >= target) break;
      walked += seg;
      i += 1;
    }
    if (i >= route.length) {
      out.push({ coordinate: route[route.length - 1]!, alongMeters: total });
      continue;
    }
    const a = route[i - 1]!;
    const b = route[i]!;
    const seg = haversineMeters(a, b);
    const t = seg > 0 ? (target - walked) / seg : 0;
    out.push({
      coordinate: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t],
      alongMeters: target,
    });
  }
  return out;
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
