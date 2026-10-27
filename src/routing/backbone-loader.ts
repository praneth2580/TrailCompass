import type { Coordinate } from './routing-adapter';
import type { NetworkFeatureCollection } from './graph-engine';
import { haversineMeters } from './geo';
import { interpolateGeodesic } from './route-chunking';
import type { RoutingProgressListener } from './routing-progress';
import { throwIfAborted } from './abort';
import { fetchOverpass } from './overpass-client';
import {
  bboxClause,
  buildNetworkQuery,
  mergeNetworks,
  overpassToNetwork,
  type OverpassElement,
} from './osm-network-loader';
import { roadPackService } from '../services/road-pack.service';

/**
 * Major-road "backbone" for long trips: motorway, trunk and primary roads
 * (national / state highways) in fixed 0.5° tiles around the trip. Routing on it first finds where the real road
 * goes (inland highways, bridges, ghats) before detail is downloaded
 * along that path. Tiles are cached and shared across trips.
 */

const TILE_DEG = 0.5;
const TILE_CACHE_VERSION = 'v2';
const SAMPLE_EVERY_M = 10_000;
// Secondary roads are left to the per-stop connector areas: in a metro
// they double a tile's size and Overpass time.
export const BACKBONE_HIGHWAY_REGEX =
  '^(motorway|trunk|primary|motorway_link|trunk_link|primary_link)$';

const memoryTiles = new Map<string, NetworkFeatureCollection>();

export interface BackboneTile {
  x: number;
  y: number;
}

/** Search width for a trip of `meters`: wide enough for inland detours. */
export function backboneRadiusMeters(meters: number): number {
  return Math.min(60_000, Math.max(20_000, meters * 0.2));
}

/** Tiles within `radiusMeters` of the start → waypoints → end polyline. */
export function backboneTiles(
  points: Coordinate[],
  radiusMeters: number,
): BackboneTile[] {
  const samples: Coordinate[] = points.slice(0, 1);
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const steps = Math.max(
      1,
      Math.ceil(haversineMeters(a, b) / SAMPLE_EVERY_M),
    );
    for (let s = 1; s <= steps; s++) {
      samples.push(interpolateGeodesic(a, b, s / steps));
    }
  }

  const tiles = new Map<string, BackboneTile>();
  for (const sample of samples) {
    const dLat = radiusMeters / 111_320;
    const dLon =
      radiusMeters / (111_320 * Math.cos((sample[1] * Math.PI) / 180));
    const x0 = Math.floor((sample[0] - dLon) / TILE_DEG);
    const x1 = Math.floor((sample[0] + dLon) / TILE_DEG);
    const y0 = Math.floor((sample[1] - dLat) / TILE_DEG);
    const y1 = Math.floor((sample[1] + dLat) / TILE_DEG);
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        const key = `${x}:${y}`;
        if (tiles.has(key)) continue;
        if (distanceToTileMeters(sample, x, y) > radiusMeters) continue;
        tiles.set(key, { x, y });
      }
    }
  }
  return [...tiles.values()];
}

/** Merged backbone network for the trip corridor. */
export async function loadBackboneNetwork(
  points: Coordinate[],
  radiusMeters: number,
  onProgress?: RoutingProgressListener,
  signal?: AbortSignal,
): Promise<NetworkFeatureCollection> {
  throwIfAborted(signal);
  const tiles = backboneTiles(points, radiusMeters);
  let done = 0;
  // Shown until the next area arrives, so a slow server doesn't look frozen.
  let retrying = false;
  const report = () =>
    onProgress?.({
      phase: 'downloading-roads',
      label: `Loading major roads · ${done}/${tiles.length} areas${retrying ? ' · map server busy, trying another' : ''}`,
      percent: Math.round((done / Math.max(1, tiles.length)) * 100),
    });
  report();
  const onRetry = () => {
    if (retrying) return;
    retrying = true;
    report();
  };

  // The Overpass scheduler caps how many of these actually run at once.
  let collections: NetworkFeatureCollection[];
  try {
    collections = await Promise.all(
      tiles.map(async (tile) => {
        const collection = await loadTile(tile, signal, onRetry);
        done += 1;
        retrying = false;
        report();
        return collection;
      }),
    );
  } catch (e) {
    if (signal?.aborted || !(e instanceof Error)) throw e;
    // Loaded areas stay cached, so planning again continues from here.
    throw new Error(
      `Couldn't load major roads (${done} of ${tiles.length} areas): ${e.message}. Try again in a few minutes to continue.`,
    );
  }
  throwIfAborted(signal);
  return mergeNetworks(collections, 'OSM major roads');
}

async function loadTile(
  tile: BackboneTile,
  signal?: AbortSignal,
  onRetry?: () => void,
): Promise<NetworkFeatureCollection> {
  const cacheKey = `backbone:${TILE_CACHE_VERSION}:${tile.x}:${tile.y}`;
  const cached = memoryTiles.get(cacheKey);
  if (cached) return cached;

  const saved = await roadPackService.findByCacheKey(cacheKey);
  throwIfAborted(signal);
  if (saved) {
    memoryTiles.set(cacheKey, saved.collection);
    return saved.collection;
  }

  const bbox: [number, number, number, number] = [
    tile.x * TILE_DEG,
    tile.y * TILE_DEG,
    (tile.x + 1) * TILE_DEG,
    (tile.y + 1) * TILE_DEG,
  ];
  const raw = await fetchOverpass<OverpassElement>(
    buildNetworkQuery(
      [
        `way["highway"~"${BACKBONE_HIGHWAY_REGEX}"]["area"!~"yes"](${bboxClause(bbox)});`,
      ],
      180,
    ),
    { signal, onRetry, roadData: true },
  );
  const collection = overpassToNetwork(
    raw,
    bbox,
    { kind: 'bbox' },
    'OSM major roads tile',
  );
  memoryTiles.set(cacheKey, collection);
  void roadPackService
    .saveFromCollection(collection, {
      cacheKey,
      kind: 'backbone',
      label: `Major roads · ${(tile.y * TILE_DEG).toFixed(1)}°, ${(tile.x * TILE_DEG).toFixed(1)}° · ${collection.features.length} ways`,
    })
    .catch(() => {
      // Best-effort; the tile is still in memory for this session.
    });
  return collection;
}

function distanceToTileMeters(point: Coordinate, x: number, y: number): number {
  const lon = Math.min(Math.max(point[0], x * TILE_DEG), (x + 1) * TILE_DEG);
  const lat = Math.min(Math.max(point[1], y * TILE_DEG), (y + 1) * TILE_DEG);
  return haversineMeters(point, [lon, lat]);
}
