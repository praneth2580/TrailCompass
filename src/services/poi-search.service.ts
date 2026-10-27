import type { Coordinate } from '../routing/routing-adapter';
import {
  distanceAlongPolylineMeters,
  haversineMeters,
  samplePolylineMeters,
} from '../routing/geo';
import { isAbortError } from '../routing/abort';
import type { PlaceHit, PoiKind } from '../types/trip-stop';
import { fetchOverpass } from '../routing/overpass-client';
import { nominatimSearch, type NominatimResult } from './nominatim-client';
import { bundledPoisNear } from './bundled-pois.service';

interface OverpassNode {
  type: string;
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

/** Nominatim box size along a route stretch; it returns at most 40 hits per box. */
const NOMINATIM_BOX_SPAN_M = 20_000;
/** Above this many calls (1 per second) a single Overpass query is quicker. */
const NOMINATIM_MAX_REQUESTS = 6;
/** With this many bundled places in the area, skip the network. */
const ENOUGH_BUNDLED: Record<PoiKind, number> = { fuel: 3, food: 5 };
/** Two hits closer than this are the same place seen by two sources. */
const SAME_PLACE_M = 60;
const OVERPASS_POI_ATTEMPTS = 3;
/** Longer search lines are resampled before measuring distances to them. */
const MAX_EXACT_LINE_POINTS = 1_500;

const FOOD_TYPES = ['restaurant', 'fast_food', 'cafe', 'food_court'];
/** Nominatim needs one call per type; these cover nearly all highway food. */
const NOMINATIM_FOOD_TYPES = ['restaurant', 'fast_food'];

/**
 * Find fuel or food stops near a point or along a route stretch.
 *
 * Uses the bundled Overture places first (works offline) and adds live
 * OpenStreetMap results only where those are few. Live lookups use
 * Nominatim for small areas and one Overpass query for long stretches,
 * each falling back to the other. Throws only when nothing was found and
 * the live lookup failed.
 */
export async function findPois(options: {
  kind: PoiKind;
  near?: Coordinate | null;
  /** Search within `radiusMeters` of this polyline (e.g. a route stretch). */
  route?: Coordinate[] | null;
  radiusMeters?: number;
  limit?: number;
  signal?: AbortSignal;
}): Promise<PlaceHit[]> {
  const radius = options.radiusMeters ?? 2_500;
  const limit = options.limit ?? 20;
  const line = options.route && options.route.length >= 2 ? options.route : null;

  let points: Coordinate[];
  if (line) {
    // Evenly spaced points, so long straight segments are covered too.
    points = samplePolylineMeters(
      line,
      0,
      Number.POSITIVE_INFINITY,
      Math.max(500, radius),
    ).map((p) => p.coordinate);
  } else if (options.near) {
    points = [options.near];
  } else {
    throw new Error('Need a location or a planned route to find stops');
  }

  // A whole route can have ~10k vertices and thousands of candidates; a
  // 250 m resample keeps "off route" accurate at a fraction of the cost.
  const measureLine =
    line && line.length > MAX_EXACT_LINE_POINTS
      ? samplePolylineMeters(line, 0, Number.POSITIVE_INFINITY, 250).map(
          (p) => p.coordinate,
        )
      : line;
  const distanceTo = (coordinate: Coordinate): number =>
    measureLine
      ? distanceAlongPolylineMeters(coordinate, measureLine).distanceToRouteMeters
      : haversineMeters(options.near!, coordinate);
  const inArea = (hits: PlaceHit[]): PlaceHit[] =>
    hits
      .map((hit) => ({ ...hit, distanceMeters: distanceTo(hit.coordinate) }))
      .filter((hit) => hit.distanceMeters <= radius);

  const bundled = inArea(await bundledPoisNear(options.kind, points, radius));

  let live: PlaceHit[] = [];
  let liveError: unknown = null;
  if (bundled.length < ENOUGH_BUNDLED[options.kind]) {
    try {
      live = inArea(await searchOsm(options.kind, points, radius, options.signal));
    } catch (e) {
      if (isAbortError(e)) throw e;
      liveError = e;
    }
  }

  const hits = mergeSamePlaces([...live, ...bundled]);
  if (hits.length === 0 && liveError) {
    const detail = liveError instanceof Error ? liveError.message : 'network error';
    throw new Error(
      `Couldn't reach OpenStreetMap (${detail}). Check the connection and try again.`,
    );
  }

  hits.sort((a, b) => (a.distanceMeters ?? 0) - (b.distanceMeters ?? 0));
  return hits.slice(0, limit);
}

/** Live OpenStreetMap lookup: Nominatim for small areas, else Overpass. */
async function searchOsm(
  kind: PoiKind,
  points: Coordinate[],
  radius: number,
  signal?: AbortSignal,
): Promise<PlaceHit[]> {
  const boxes = boxesAlong(points, radius);
  const types = kind === 'fuel' ? ['fuel'] : NOMINATIM_FOOD_TYPES;

  let nominatimError: unknown = null;
  if (boxes.length * types.length <= NOMINATIM_MAX_REQUESTS) {
    try {
      return await searchNominatim(kind, boxes, types, signal);
    } catch (e) {
      if (isAbortError(e)) throw e;
      nominatimError = e;
    }
  }

  try {
    return await searchOverpass(kind, points, radius, signal);
  } catch (e) {
    if (isAbortError(e) || !nominatimError) throw e;
    const detail = e instanceof Error ? e.message : 'failed';
    throw new Error(`${detail}; Nominatim also failed`);
  }
}

async function searchNominatim(
  kind: PoiKind,
  boxes: Bbox[],
  types: string[],
  signal?: AbortSignal,
): Promise<PlaceHit[]> {
  const hits: PlaceHit[] = [];
  for (const box of boxes) {
    for (const type of types) {
      const rows = await nominatimSearch(
        {
          q: `[${type}]`,
          viewbox: `${box.west},${box.north},${box.east},${box.south}`,
          bounded: '1',
          limit: '40',
        },
        signal,
      );
      for (const row of rows) {
        if (!isKind(kind, row)) continue;
        hits.push(nominatimHit(kind, row));
      }
    }
  }
  return hits;
}

async function searchOverpass(
  kind: PoiKind,
  points: Coordinate[],
  radius: number,
  signal?: AbortSignal,
): Promise<PlaceHit[]> {
  // around: accepts a polyline: lat1,lon1,lat2,lon2,…
  const line = points
    .map(([lon, lat]) => `${lat.toFixed(5)},${lon.toFixed(5)}`)
    .join(',');
  const query = `[out:json][timeout:25];
(
  nwr${amenityFilter(kind)}(around:${Math.round(radius)},${line});
);
out center tags;`;

  const data =
    (
      await fetchOverpass<OverpassNode>(query, {
        signal,
        maxAttempts: OVERPASS_POI_ATTEMPTS,
      })
    ).elements ?? [];

  const hits: PlaceHit[] = [];
  for (const el of data) {
    const coordinate = nodeCoordinate(el);
    if (!coordinate) continue;
    hits.push({
      id: `osm-${el.type}-${el.id}`,
      name:
        el.tags?.name?.trim() ||
        el.tags?.brand?.trim() ||
        el.tags?.operator?.trim() ||
        defaultPoiName(kind),
      coordinate,
      subtitle: el.tags?.['addr:street'] ?? el.tags?.amenity,
      kind,
    });
  }
  return hits;
}

interface Bbox {
  west: number;
  south: number;
  east: number;
  north: number;
}

/** Cover the points with boxes about NOMINATIM_BOX_SPAN_M long, padded by `radius`. */
function boxesAlong(points: Coordinate[], radius: number): Bbox[] {
  const boxes: Bbox[] = [];
  let chunk: Coordinate[] = [];
  let span = 0;
  for (const point of points) {
    const previous = chunk[chunk.length - 1];
    if (previous) span += haversineMeters(previous, point);
    chunk.push(point);
    if (span >= NOMINATIM_BOX_SPAN_M) {
      boxes.push(paddedBox(chunk, radius));
      chunk = [point];
      span = 0;
    }
  }
  if (chunk.length > 1 || boxes.length === 0) boxes.push(paddedBox(chunk, radius));
  return boxes;
}

function paddedBox(points: Coordinate[], radius: number): Bbox {
  const lons = points.map((p) => p[0]);
  const lats = points.map((p) => p[1]);
  const midLat = (Math.min(...lats) + Math.max(...lats)) / 2;
  const padLat = radius / 110_540;
  const padLon = radius / (111_320 * Math.max(0.2, Math.cos((midLat * Math.PI) / 180)));
  return {
    west: Math.min(...lons) - padLon,
    east: Math.max(...lons) + padLon,
    south: Math.min(...lats) - padLat,
    north: Math.max(...lats) + padLat,
  };
}

/** Keep the first of any hits within SAME_PLACE_M; named ones win. */
function mergeSamePlaces(hits: PlaceHit[]): PlaceHit[] {
  const kept: PlaceHit[] = [];
  for (const hit of hits) {
    const twin = kept.findIndex(
      (other) => haversineMeters(other.coordinate, hit.coordinate) < SAME_PLACE_M,
    );
    if (twin < 0) {
      kept.push(hit);
    } else if (isGenericName(kept[twin]!.name) && !isGenericName(hit.name)) {
      kept[twin] = { ...hit, distanceMeters: kept[twin]!.distanceMeters };
    }
  }
  return kept;
}

function isKind(kind: PoiKind, row: NominatimResult): boolean {
  const category = row.category ?? row.class;
  if (category !== 'amenity') return false;
  return kind === 'fuel' ? row.type === 'fuel' : FOOD_TYPES.includes(row.type ?? '');
}

function nominatimHit(kind: PoiKind, row: NominatimResult): PlaceHit {
  return {
    id: `nom-${row.place_id}`,
    name: row.name?.trim() || defaultPoiName(kind),
    coordinate: [Number(row.lon), Number(row.lat)],
    subtitle: row.type,
    kind,
  };
}

function amenityFilter(kind: PoiKind): string {
  if (kind === 'fuel') return '["amenity"="fuel"]';
  return `["amenity"~"^(${FOOD_TYPES.join('|')})$"]`;
}

function defaultPoiName(kind: PoiKind): string {
  return kind === 'fuel' ? 'Fuel station' : 'Place to eat';
}

export function isGenericName(name: string): boolean {
  return name === 'Fuel station' || name === 'Place to eat';
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
