import type { Coordinate } from './routing-adapter';
import type { NetworkFeatureCollection } from './graph-engine';
import { haversineMeters } from './geo';
import type { RoutingProgressListener } from './routing-progress';

const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

/** Keep queries small enough for public Overpass mirrors. */
const MAX_ROUTE_SPAN_M = 80_000;
const BBOX_PAD_DEG = 0.02;

const HIGHWAY_REGEX =
  '^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|service|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link)$';

interface OverpassElement {
  type: string;
  id: number;
  tags?: Record<string, string>;
  geometry?: Array<{ lat: number; lon: number }>;
}

interface CacheEntry {
  collection: NetworkFeatureCollection;
  loadedAt: number;
}

const memoryCache = new Map<string, CacheEntry>();

/**
 * Loads OSM driveable ways for a route corridor and returns a GeoJSON network.
 * This is road *data* for local A* — not an online routing API response.
 */
export async function loadOsmNetworkForRoute(
  start: Coordinate,
  end: Coordinate,
  waypoints: Coordinate[] = [],
  onProgress?: RoutingProgressListener,
): Promise<NetworkFeatureCollection> {
  const points = [start, ...waypoints, end];
  const span = maxPairDistance(points);
  if (span > MAX_ROUTE_SPAN_M) {
    throw new Error(
      `Route span is ${Math.round(span / 1000)} km — pick a closer destination (max ~${Math.round(MAX_ROUTE_SPAN_M / 1000)} km per plan while using live OSM extracts)`,
    );
  }

  const bbox = paddedBbox(points);
  const cacheKey = bboxKey(bbox);
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
    phase: 'downloading-roads',
    label: 'Downloading connecting roads…',
    percent: null,
  });

  const query = buildOverpassQuery(bbox);
  const raw = await fetchOverpass(query, onProgress);
  onProgress?.({
    phase: 'building-graph',
    label: 'Building road graph…',
    percent: null,
  });
  const collection = overpassToNetwork(raw, bbox);

  if (collection.features.length === 0) {
    throw new Error('No driveable roads found between those points');
  }

  memoryCache.set(cacheKey, { collection, loadedAt: Date.now() });
  if (memoryCache.size > 12) {
    const oldest = memoryCache.keys().next().value;
    if (oldest) memoryCache.delete(oldest);
  }

  return collection;
}

function buildOverpassQuery(bbox: [number, number, number, number]): string {
  const [west, south, east, north] = bbox;
  return `
[out:json][timeout:90];
(
  way["highway"~"${HIGHWAY_REGEX}"]["area"!~"yes"](${south},${west},${north},${east});
);
out body geom;
`.trim();
}

async function fetchOverpass(
  query: string,
  onProgress?: RoutingProgressListener,
): Promise<{ elements?: OverpassElement[] }> {
  let lastError: Error | undefined;
  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
          Accept: 'application/json',
        },
        body: `data=${encodeURIComponent(query)}`,
      });
      if (!response.ok) {
        lastError = new Error(`Overpass HTTP ${response.status}`);
        continue;
      }

      const text = await readResponseText(response, onProgress);
      return JSON.parse(text) as { elements?: OverpassElement[] };
    } catch (e) {
      lastError = e instanceof Error ? e : new Error('Overpass request failed');
    }
  }
  throw lastError ?? new Error('Could not download road network');
}

/**
 * Read body with byte progress when Content-Length is present.
 * If length is missing, percent stays null (indeterminate — no fake %).
 */
async function readResponseText(
  response: Response,
  onProgress?: RoutingProgressListener,
): Promise<string> {
  const totalHeader = response.headers.get('content-length');
  const bytesTotal =
    totalHeader && /^\d+$/.test(totalHeader) ? Number(totalHeader) : null;

  if (!response.body || bytesTotal == null || bytesTotal <= 0) {
    onProgress?.({
      phase: 'downloading-roads',
      label: 'Downloading connecting roads…',
      percent: null,
    });
    return response.text();
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytesReceived = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      bytesReceived += value.byteLength;
      const percent = Math.min(
        99,
        Math.round((bytesReceived / bytesTotal) * 100),
      );
      onProgress?.({
        phase: 'downloading-roads',
        label: 'Downloading connecting roads…',
        percent,
        bytesReceived,
        bytesTotal,
      });
    }
  }

  onProgress?.({
    phase: 'downloading-roads',
    label: 'Downloading connecting roads…',
    percent: 100,
    bytesReceived,
    bytesTotal,
  });

  const merged = new Uint8Array(bytesReceived);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

function overpassToNetwork(
  raw: { elements?: OverpassElement[] },
  bbox: [number, number, number, number],
): NetworkFeatureCollection {
  const features: NetworkFeatureCollection['features'] = [];

  for (const el of raw.elements ?? []) {
    if (el.type !== 'way' || !el.geometry || el.geometry.length < 2) continue;
    const tags = el.tags ?? {};
    if (tags.motor_vehicle === 'no' || tags.motorcycle === 'no') continue;
    if (tags.access === 'no' || tags.access === 'private') continue;

    features.push({
      type: 'Feature',
      properties: {
        highway: tags.highway ?? 'road',
        oneway: tags.oneway ?? null,
        name: tags.name ?? null,
        osm_id: el.id,
      },
      geometry: {
        type: 'LineString',
        coordinates: el.geometry.map((g) => [g.lon, g.lat]),
      },
    });
  }

  return {
    type: 'FeatureCollection',
    name: 'OSM route corridor',
    attribution: '© OpenStreetMap contributors (ODbL)',
    region: {
      id: `osm-${bboxKey(bbox)}`,
      label: 'OSM roads (route area)',
      bbox,
    },
    features,
  };
}

function paddedBbox(
  points: Coordinate[],
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
  return [
    west - BBOX_PAD_DEG,
    south - BBOX_PAD_DEG,
    east + BBOX_PAD_DEG,
    north + BBOX_PAD_DEG,
  ];
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
