import type { Coordinate } from '../routing/routing-adapter';
import { haversineMeters, distanceAlongPolylineMeters } from '../routing/geo';
import type { PlaceHit, PoiKind } from '../types/trip-stop';
import { fetchOverpass } from '../routing/overpass-client';

interface OverpassNode {
  type: string;
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

/**
 * Find fuel or food POIs near a point or along a planned route corridor.
 */
export async function findPois(options: {
  kind: PoiKind;
  near?: Coordinate | null;
  route?: Coordinate[] | null;
  radiusMeters?: number;
  limit?: number;
}): Promise<PlaceHit[]> {
  const radius = options.radiusMeters ?? 2_500;
  const limit = options.limit ?? 20;
  const tagFilter = amenityFilter(options.kind);

  let query: string;
  if (options.route && options.route.length >= 2) {
    const samples = sampleRoute(options.route, 8);
    const aroundParts = samples
      .map(
        ([lon, lat]) =>
          `node${tagFilter}(around:${radius},${lat},${lon});\n  way${tagFilter}(around:${radius},${lat},${lon});`,
      )
      .join('\n  ');
    query = `[out:json][timeout:25];\n(\n  ${aroundParts}\n);\nout center tags;`;
  } else if (options.near) {
    const [lon, lat] = options.near;
    query = `[out:json][timeout:25];
(
  node${tagFilter}(around:${radius},${lat},${lon});
  way${tagFilter}(around:${radius},${lat},${lon});
);
out center tags;`;
  } else {
    throw new Error('Need a location or a planned route to find stops');
  }

  const data = (await fetchOverpass<OverpassNode>(query)).elements ?? [];
  const seen = new Set<string>();
  const hits: PlaceHit[] = [];

  for (const el of data) {
    const coord = nodeCoordinate(el);
    if (!coord) continue;
    const key = `${coord[0].toFixed(5)},${coord[1].toFixed(5)}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const name =
      el.tags?.name?.trim() ||
      el.tags?.brand?.trim() ||
      el.tags?.operator?.trim() ||
      defaultPoiName(options.kind);

    let distanceMeters: number | undefined;
    if (options.route && options.route.length >= 2) {
      distanceMeters = distanceAlongPolylineMeters(
        coord,
        options.route,
      ).distanceToRouteMeters;
    } else if (options.near) {
      distanceMeters = haversineMeters(options.near, coord);
    }

    hits.push({
      id: `osm-${el.type}-${el.id}`,
      name,
      coordinate: coord,
      subtitle: el.tags?.['addr:street'] ?? el.tags?.amenity,
      kind: options.kind,
      distanceMeters,
    });
  }

  hits.sort((a, b) => (a.distanceMeters ?? 0) - (b.distanceMeters ?? 0));
  return hits.slice(0, limit);
}

function amenityFilter(kind: PoiKind): string {
  if (kind === 'fuel') return '["amenity"="fuel"]';
  return '["amenity"~"^(restaurant|cafe|fast_food|food_court)$"]';
}

function defaultPoiName(kind: PoiKind): string {
  return kind === 'fuel' ? 'Fuel station' : 'Place to eat';
}

function nodeCoordinate(el: OverpassNode): Coordinate | null {
  if (typeof el.lat === 'number' && typeof el.lon === 'number') {
    return [el.lon, el.lat];
  }
  if (el.center) {
    return [el.center.lon, el.center.lat];
  }
  return null;
}

function sampleRoute(route: Coordinate[], count: number): Coordinate[] {
  if (route.length <= count) return route;
  const out: Coordinate[] = [];
  for (let i = 0; i < count; i++) {
    const t = i / (count - 1);
    const idx = Math.round(t * (route.length - 1));
    out.push(route[idx]!);
  }
  return out;
}
