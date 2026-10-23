import type { Coordinate } from './routing-adapter';
import {
  NoRoadPathError,
  type NetworkFeatureCollection,
  type NetworkRestriction,
} from './graph-engine';
import {
  haversineMeters,
  keyForCoordinate,
  pointAlongPolylineMeters,
  polylineLengthMeters,
} from './geo';
import { interpolateGeodesic } from './route-chunking';
import type { RoutingProgressListener } from './routing-progress';
import { roadPackService } from '../services/road-pack.service';
import { throwIfAborted } from './abort';
import { fetchOverpass } from './overpass-client';
import type { NetworkCoverage } from './network-coverage';
import {
  ROAD_TAG_KEYS,
  controlFromNodeTags,
  type NetworkControl,
  type RoadTags,
} from './road-attributes';

/** Keep queries small enough for public Overpass mirrors (per leg). */
export const MAX_ROUTE_SPAN_M = 80_000;
const BBOX_PAD_DEG = 0.025;
/** Use corridor (around) queries once the leg is longer than this. */
const CORRIDOR_SPAN_M = 25_000;
const CORRIDOR_RADIUS_M = 4_000;
const CORRIDOR_SAMPLE_M = 12_000;
/** Corridor along a known road path: tighter circles, closer together. */
const GUIDE_RADIUS_M = 3_000;
const GUIDE_SAMPLE_M = 4_000;
const MAX_CORRIDOR_SAMPLES = 20;
const METERS_PER_DEG = 111_320;

/** Mid-tier roads that link a town to the highway backbone. */
const CONNECTOR_HIGHWAY_REGEX =
  '^(secondary|tertiary|secondary_link|tertiary_link)$';

export const DETAIL_HIGHWAY_REGEX =
  '^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|service|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link)$';

export interface OverpassElement {
  type: string;
  id: number;
  lat?: number;
  lon?: number;
  tags?: Record<string, string>;
  geometry?: Array<{ lat: number; lon: number }>;
  members?: Array<{ type: string; ref: number; role: string }>;
}

interface CacheEntry {
  collection: NetworkFeatureCollection;
  loadedAt: number;
}

const memoryCache = new Map<string, CacheEntry>();

/**
 * Loads OSM driveable ways for a route corridor and returns a GeoJSON network.
 * This is road *data* for local A* — not an online routing API response.
 *
 * Long thin legs use overlapping `around` samples so the download stays a
 * corridor instead of a huge diagonal bbox. With `guide` (a known road path)
 * the samples follow that path instead of the straight line.
 */
export async function loadOsmNetworkForRoute(
  start: Coordinate,
  end: Coordinate,
  waypoints: Coordinate[] = [],
  onProgress?: RoutingProgressListener,
  signal?: AbortSignal,
  options: { guide?: Coordinate[] } = {},
): Promise<NetworkFeatureCollection> {
  throwIfAborted(signal);
  const points = [start, ...waypoints, end];
  const guide =
    options.guide && options.guide.length >= 2 ? options.guide : null;
  const span = guide ? polylineLengthMeters(guide) : maxPairDistance(points);
  if (!guide && span > MAX_ROUTE_SPAN_M) {
    throw new Error(
      `Route leg is ${Math.round(span / 1000)} km — max ~${Math.round(MAX_ROUTE_SPAN_M / 1000)} km per chunk`,
    );
  }

  const bbox = paddedBbox(guide ?? points);
  const useCorridor = guide != null || span >= CORRIDOR_SPAN_M;
  const radius = guide ? GUIDE_RADIUS_M : CORRIDOR_RADIUS_M;
  const samples = guide
    ? sampleGuide(guide)
    : useCorridor
      ? sampleCorridor(points)
      : [];
  const coverage: NetworkCoverage = useCorridor
    ? { kind: 'corridor', samples, radiusMeters: radius }
    : { kind: 'bbox' };
  const query = useCorridor
    ? buildNetworkQuery(
        samples.map(
          ([lon, lat]) =>
            `way["highway"~"${DETAIL_HIGHWAY_REGEX}"]["area"!~"yes"](around:${radius},${lat},${lon});`,
        ),
      )
    : buildNetworkQuery([
        `way["highway"~"${DETAIL_HIGHWAY_REGEX}"]["area"!~"yes"](${bboxClause(bbox)});`,
      ]);

  return loadNetwork({
    cacheKey: useCorridor
      ? `corridor:${samples.map((p) => `${p[0].toFixed(3)},${p[1].toFixed(3)}`).join('|')}`
      : bboxKey(bbox),
    coveragePoints: guide ? samples : points,
    query,
    bbox,
    coverage,
    label: useCorridor
      ? 'Downloading road corridor…'
      : 'Downloading connecting roads…',
    onProgress,
    signal,
  });
}

/**
 * Every road class within `radiusMeters` of `point`, plus secondary and
 * tertiary roads out to `connectorRadiusMeters`, so a trip end in a side
 * street or a small town can reach the highway backbone.
 */
export async function loadLocalArea(
  point: Coordinate,
  radiusMeters: number,
  connectorRadiusMeters: number,
  onProgress?: RoutingProgressListener,
  signal?: AbortSignal,
): Promise<NetworkFeatureCollection> {
  throwIfAborted(signal);
  const inner = bboxAround(point, radiusMeters);
  const outer = bboxAround(point, Math.max(radiusMeters, connectorRadiusMeters));
  const cacheKey = `local:${point[0].toFixed(3)},${point[1].toFixed(3)}:${radiusMeters}:${connectorRadiusMeters}`;

  const cached = memoryCache.get(cacheKey);
  if (cached) return cached.collection;
  // Only part of the box has every class, so reuse is by exact key only.
  const saved = await roadPackService.findByCacheKey(cacheKey);
  throwIfAborted(signal);
  if (saved) {
    remember(cacheKey, saved.collection);
    return saved.collection;
  }

  onProgress?.({
    phase: 'downloading-roads',
    label: 'Downloading local streets…',
    percent: null,
  });
  const raw = await fetchOverpass<OverpassElement>(
    buildNetworkQuery([
      `way["highway"~"${DETAIL_HIGHWAY_REGEX}"]["area"!~"yes"](${bboxClause(inner)});`,
      `way["highway"~"${CONNECTOR_HIGHWAY_REGEX}"]["area"!~"yes"](${bboxClause(outer)});`,
    ]),
    { onProgress, signal },
  );
  const collection = overpassToNetwork(raw, outer, { kind: 'bbox' }, 'OSM local streets');
  remember(cacheKey, collection);
  void roadPackService
    .saveFromCollection(collection, { cacheKey, kind: 'connector' })
    .catch(() => {
      // Best-effort; still in memory for this session.
    });
  return collection;
}

function bboxAround(
  point: Coordinate,
  radiusMeters: number,
): [number, number, number, number] {
  const dLat = radiusMeters / METERS_PER_DEG;
  const dLon =
    radiusMeters / (METERS_PER_DEG * Math.cos((point[1] * Math.PI) / 180));
  return [point[0] - dLon, point[1] - dLat, point[0] + dLon, point[1] + dLat];
}

async function loadNetwork(request: {
  cacheKey: string;
  coveragePoints: Coordinate[];
  query: string;
  bbox: [number, number, number, number];
  coverage: NetworkCoverage;
  label: string;
  onProgress?: RoutingProgressListener;
  signal?: AbortSignal;
}): Promise<NetworkFeatureCollection> {
  const { cacheKey, onProgress, signal } = request;
  const cached = memoryCache.get(cacheKey);
  if (cached) {
    onProgress?.({
      phase: 'checking-cache',
      label: 'Using cached roads',
      percent: 100,
    });
    return cached.collection;
  }

  onProgress?.({
    phase: 'checking-cache',
    label: 'Checking saved road packs…',
    percent: null,
  });
  const diskPack = await roadPackService.findCoveringPack(
    request.coveragePoints,
  );
  throwIfAborted(signal);
  if (diskPack) {
    onProgress?.({
      phase: 'checking-cache',
      label: `Using saved pack · ${diskPack.meta.label}`,
      percent: 100,
    });
    remember(cacheKey, diskPack.collection);
    return diskPack.collection;
  }

  onProgress?.({
    phase: 'downloading-roads',
    label: request.label,
    percent: null,
  });
  const raw = await fetchOverpass<OverpassElement>(request.query, {
    onProgress,
    signal,
  });
  onProgress?.({
    phase: 'building-graph',
    label: 'Building road graph…',
    percent: null,
  });
  const collection = overpassToNetwork(raw, request.bbox, request.coverage);

  if (collection.features.length === 0) {
    throw new NoRoadPathError('No driveable roads found between those points');
  }

  remember(cacheKey, collection);
  void roadPackService.saveFromCollection(collection, { cacheKey }).catch(() => {
    // Persistence is best-effort; routing still works.
  });

  return collection;
}

function remember(cacheKey: string, collection: NetworkFeatureCollection) {
  memoryCache.set(cacheKey, { collection, loadedAt: Date.now() });
  if (memoryCache.size > 24) {
    const oldest = memoryCache.keys().next().value;
    if (oldest) memoryCache.delete(oldest);
  }
}

/**
 * Overpass QL for a set of `way` clauses: the ways with geometry, the
 * junction controls on them (signals, stop/give-way, level crossings, toll
 * booths) and via-node turn restrictions between them.
 */
export function buildNetworkQuery(
  wayClauses: string[],
  timeoutSeconds = 90,
): string {
  return `
[out:json][timeout:${timeoutSeconds}];
(
  ${wayClauses.join('\n  ')}
)->.w;
.w out tags geom;
(
  node(w.w)["highway"~"^(traffic_signals|stop|give_way)$"];
  node(w.w)["railway"="level_crossing"];
  node(w.w)["barrier"="toll_booth"];
);
out body;
rel(bw.w)["type"="restriction"]->.r;
.r out body;
node(r.r:"via");
out skel;
`.trim();
}

export function bboxClause(bbox: [number, number, number, number]): string {
  const [west, south, east, north] = bbox;
  return `${south},${west},${north},${east}`;
}

/** Points every GUIDE_SAMPLE_M along a road path, ends included. */
function sampleGuide(guide: Coordinate[]): Coordinate[] {
  const total = polylineLengthMeters(guide);
  const steps = Math.min(
    MAX_CORRIDOR_SAMPLES - 1,
    Math.max(1, Math.ceil(total / GUIDE_SAMPLE_M)),
  );
  const samples: Coordinate[] = [];
  for (let s = 0; s <= steps; s++) {
    const hit = pointAlongPolylineMeters(guide, (total * s) / steps);
    if (hit) samples.push(hit.coordinate);
  }
  return samples;
}

/** Sample points along consecutive segments for corridor Overpass queries. */
function sampleCorridor(points: Coordinate[]): Coordinate[] {
  if (points.length === 0) return [];
  const samples: Coordinate[] = [points[0]!];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const dist = haversineMeters(a, b);
    const steps = Math.max(1, Math.ceil(dist / CORRIDOR_SAMPLE_M));
    for (let s = 1; s <= steps; s++) {
      samples.push(interpolateGeodesic(a, b, s / steps));
    }
  }
  // Cap sample count for Overpass URL size / timeout.
  if (samples.length <= 12) return samples;
  const out: Coordinate[] = [];
  for (let i = 0; i < 12; i++) {
    const idx = Math.round((i / 11) * (samples.length - 1));
    out.push(samples[idx]!);
  }
  return out;
}

export function overpassToNetwork(
  raw: { elements?: OverpassElement[] },
  bbox: [number, number, number, number],
  coverage: NetworkCoverage,
  name = 'OSM route corridor',
): NetworkFeatureCollection {
  const features: NetworkFeatureCollection['features'] = [];
  const controls: NetworkControl[] = [];
  const nodeCoordinates = new Map<number, Coordinate>();
  const relations: OverpassElement[] = [];

  for (const el of raw.elements ?? []) {
    if (el.type === 'node') {
      if (typeof el.lat !== 'number' || typeof el.lon !== 'number') continue;
      const coordinate: Coordinate = [el.lon, el.lat];
      nodeCoordinates.set(el.id, coordinate);
      const control = el.tags ? controlFromNodeTags(coordinate, el.tags) : null;
      if (control) controls.push(control);
      continue;
    }
    if (el.type === 'relation') {
      relations.push(el);
      continue;
    }
    if (el.type !== 'way' || !el.geometry || el.geometry.length < 2) continue;
    // Access / oneway rules are applied by the graph engine from these tags.
    const tags = el.tags ?? {};

    features.push({
      type: 'Feature',
      properties: {
        highway: tags.highway ?? 'road',
        oneway: tags.oneway ?? null,
        name: tags.name ?? null,
        osm_id: el.id,
        tags: pickRoadTags(tags),
      },
      geometry: {
        type: 'LineString',
        coordinates: el.geometry.map((g) => [g.lon, g.lat]),
      },
    });
  }

  return {
    type: 'FeatureCollection',
    name,
    attribution: '© OpenStreetMap contributors (ODbL)',
    region: {
      id: `osm-${bboxKey(bbox)}`,
      label: 'OSM roads (route area)',
      bbox,
      coverage,
    },
    features,
    controls,
    restrictions: relations.flatMap((rel) =>
      parseRestriction(rel, nodeCoordinates),
    ),
  };
}

function pickRoadTags(tags: Record<string, string>): RoadTags {
  const out: RoadTags = {};
  for (const key of ROAD_TAG_KEYS) {
    if (tags[key] != null) out[key] = tags[key];
  }
  return out;
}

/** Via-node turn restriction that applies to motorcycles, or nothing. */
function parseRestriction(
  rel: OverpassElement,
  nodeCoordinates: Map<number, Coordinate>,
): NetworkRestriction[] {
  const tags = rel.tags ?? {};
  const except = (tags.except ?? '').split(';').map((v) => v.trim());
  if (except.includes('motorcycle') || except.includes('motor_vehicle')) {
    return [];
  }
  const value = (tags['restriction:motorcycle'] ?? tags.restriction ?? '').trim();
  const kind = value.startsWith('no_')
    ? 'no'
    : value.startsWith('only_')
      ? 'only'
      : null;
  if (!kind) return [];

  const members = rel.members ?? [];
  const vias = members.filter((m) => m.role === 'via');
  if (vias.length !== 1 || vias[0]!.type !== 'node') return [];
  const via = nodeCoordinates.get(vias[0]!.ref);
  if (!via) return [];

  const from = members.filter((m) => m.role === 'from' && m.type === 'way');
  const to = members.filter((m) => m.role === 'to' && m.type === 'way');
  return from.flatMap((f) =>
    to.map((t) => ({ fromWay: f.ref, via, toWay: t.ref, kind })),
  );
}

/**
 * One network from several downloads. Ways shared by overlapping downloads
 * (same OSM id) are kept once so the graph has no duplicate edges.
 */
export function mergeNetworks(
  collections: NetworkFeatureCollection[],
  label = 'OSM roads (merged)',
): NetworkFeatureCollection {
  const seenWays = new Set<number>();
  const seenControls = new Set<string>();
  const seenRestrictions = new Set<string>();
  const merged: NetworkFeatureCollection = {
    type: 'FeatureCollection',
    name: label,
    attribution: '© OpenStreetMap contributors (ODbL)',
    features: [],
    controls: [],
    restrictions: [],
  };
  let bbox: [number, number, number, number] | undefined;

  for (const collection of collections) {
    for (const feature of collection.features) {
      const id = feature.properties?.osm_id;
      if (id != null) {
        if (seenWays.has(id)) continue;
        seenWays.add(id);
      }
      merged.features.push(feature);
    }
    for (const control of collection.controls ?? []) {
      const key = keyForCoordinate(control.coordinate);
      if (seenControls.has(key)) continue;
      seenControls.add(key);
      merged.controls!.push(control);
    }
    for (const r of collection.restrictions ?? []) {
      const key = `${r.fromWay}:${keyForCoordinate(r.via)}:${r.toWay}:${r.kind}`;
      if (seenRestrictions.has(key)) continue;
      seenRestrictions.add(key);
      merged.restrictions!.push(r);
    }
    const b = collection.region?.bbox;
    if (b) {
      bbox = bbox
        ? [
            Math.min(bbox[0], b[0]),
            Math.min(bbox[1], b[1]),
            Math.max(bbox[2], b[2]),
            Math.max(bbox[3], b[3]),
          ]
        : [...b];
    }
  }

  merged.region = { id: `merged-${bbox ? bboxKey(bbox) : 'x'}`, label, bbox };
  return merged;
}

/** Ways with any point inside `bbox` (plus their controls / restrictions). */
export function clipNetwork(
  collection: NetworkFeatureCollection,
  bbox: [number, number, number, number],
): NetworkFeatureCollection {
  const [west, south, east, north] = bbox;
  const inside = ([lon, lat]: Coordinate) =>
    lon >= west && lon <= east && lat >= south && lat <= north;
  return {
    ...collection,
    region: { ...collection.region, bbox },
    features: collection.features.filter(
      (f) =>
        f.geometry.type === 'LineString' &&
        (f.geometry.coordinates as Coordinate[]).some(inside),
    ),
    controls: (collection.controls ?? []).filter((c) => inside(c.coordinate)),
    restrictions: (collection.restrictions ?? []).filter((r) => inside(r.via)),
  };
}

/** Bbox around `points`, padded by `padMeters` (default ~2.8 km). */
export function paddedBbox(
  points: Coordinate[],
  padMeters?: number,
): [number, number, number, number] {
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (const [lng, lat] of points) {
    west = Math.min(west, lng);
    east = Math.max(east, lng);
    south = Math.min(south, lat);
    north = Math.max(north, lat);
  }
  const padLat = padMeters != null ? padMeters / METERS_PER_DEG : BBOX_PAD_DEG;
  const padLon =
    padMeters != null
      ? padMeters /
        (METERS_PER_DEG * Math.cos((((south + north) / 2) * Math.PI) / 180))
      : BBOX_PAD_DEG;
  return [west - padLon, south - padLat, east + padLon, north + padLat];
}

function bboxKey(bbox: [number, number, number, number]): string {
  return bbox.map((n) => n.toFixed(3)).join(':');
}

function maxPairDistance(points: Coordinate[]): number {
  let best = 0;
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      best = Math.max(best, haversineMeters(points[i]!, points[j]!));
    }
  }
  return best;
}
