import type { Coordinate } from '../routing/routing-adapter';
import type { NetworkFeatureCollection } from '../routing/graph-engine';
import {
  bboxCoversPoints,
  coverageIncludesPoints,
  type NetworkCoverage,
} from '../routing/network-coverage';
import { appDatabase } from '../database/database';
import { storageManager } from '../offline/storage-manager';

const INDEX_KEY = 'road-pack-index';
const BACKBONE_INDEX_KEY = 'road-pack-index-backbone';
const PACK_DIR = 'road-packs';
/** Bump when the stored network format gains data routing depends on. */
const PACK_SCHEMA = 2;
const MAX_CORRIDOR_PACKS = 40;
const MAX_BACKBONE_PACKS = 60;
/** Skip persisting huge extracts on web localStorage. */
const MAX_WEB_JSON_CHARS = 1_800_000;

export type BBox = [west: number, south: number, east: number, north: number];

/**
 * Corridor/area packs have every road class everywhere and are reused by
 * coverage. Backbone tiles and connector areas hold only some classes in
 * parts of their box, so they are reused by exact cache key only.
 */
export type RoadPackKind = 'corridor' | 'backbone' | 'connector';

/** The kinds as riders see them, in display order. */
export const ROAD_PACK_KINDS: Array<{ kind: RoadPackKind; title: string; hint: string }> = [
  { kind: 'backbone', title: 'Major roads', hint: 'Highways for long trips, in areas about 55 km across' },
  { kind: 'corridor', title: 'Route corridors', hint: 'Every road along a route you planned' },
  { kind: 'connector', title: 'Local streets', hint: 'Streets around where trips start and end' },
];

/** Packs saved before kinds existed are route corridors. */
export function packKind(pack: RoadPackMeta): RoadPackKind {
  return pack.kind ?? 'corridor';
}

export function totalPackBytes(packs: RoadPackMeta[]): number {
  return packs.reduce((sum, pack) => sum + pack.bytes, 0);
}

export interface RoadPackMeta {
  id: string;
  label: string;
  bbox: BBox;
  featureCount: number;
  createdAt: string;
  /** Approximate serialized size in bytes. */
  bytes: number;
  cacheKey?: string;
  /** Where the pack really has roads; absent on packs saved before this existed. */
  coverage?: NetworkCoverage;
  /** Format version; packs without tags / junction controls have none. */
  schema?: number;
  kind?: RoadPackKind;
  /** The main roads in it by name, for the Offline tab; absent on older packs. */
  roads?: string[];
}

/**
 * Persist OSM road extracts so nearby re-plans skip Overpass.
 * Index in Preferences; GeoJSON body on disk (or localStorage on web).
 */
export class RoadPackService {
  async listPacks(): Promise<RoadPackMeta[]> {
    const ids = [
      ...((await appDatabase.getJson<string[]>(INDEX_KEY)) ?? []),
      ...((await appDatabase.getJson<string[]>(BACKBONE_INDEX_KEY)) ?? []),
    ];
    const packs: RoadPackMeta[] = [];
    for (const id of ids) {
      const meta = await appDatabase.getJson<RoadPackMeta>(`road-pack-meta:${id}`);
      if (meta) packs.push(meta);
    }
    return packs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async getPack(id: string): Promise<{
    meta: RoadPackMeta;
    collection: NetworkFeatureCollection;
  } | null> {
    const meta = await appDatabase.getJson<RoadPackMeta>(`road-pack-meta:${id}`);
    if (!meta) return null;
    const raw = await storageManager.readTextFile(`${PACK_DIR}/${id}.json`);
    if (!raw) return null;
    try {
      const collection = JSON.parse(raw) as NetworkFeatureCollection;
      return { meta, collection };
    } catch {
      return null;
    }
  }

  /** First saved pack that has roads at every point (bbox plus corridor check). */
  async findCoveringPack(
    points: Coordinate[],
  ): Promise<{
    meta: RoadPackMeta;
    collection: NetworkFeatureCollection;
  } | null> {
    if (points.length === 0) return null;
    const packs = await this.listPacks();
    for (const meta of packs) {
      if (!isCurrent(meta) || (meta.kind ?? 'corridor') !== 'corridor') continue;
      if (!bboxCoversPoints(meta.bbox, points, 0.002)) continue;
      if (!coverageIncludesPoints(meta.coverage, points)) continue;
      const loaded = await this.getPack(meta.id);
      if (loaded) return loaded;
    }
    return null;
  }

  /** A current-format pack saved under `cacheKey` (e.g. a backbone tile). */
  async findByCacheKey(cacheKey: string): Promise<{
    meta: RoadPackMeta;
    collection: NetworkFeatureCollection;
  } | null> {
    const packs = await this.listPacks();
    const meta = packs.find((m) => m.cacheKey === cacheKey && isCurrent(m));
    return meta ? this.getPack(meta.id) : null;
  }

  async saveFromCollection(
    collection: NetworkFeatureCollection,
    options?: { cacheKey?: string; label?: string; kind?: RoadPackKind },
  ): Promise<RoadPackMeta | null> {
    const kind = options?.kind ?? 'corridor';
    const bbox = collection.region?.bbox;
    if (!bbox || collection.features.length === 0) return null;

    const json = JSON.stringify(collection);
    if (json.length > MAX_WEB_JSON_CHARS) {
      // Too large for reliable web storage; skip persist (native is fine but
      // keep behavior consistent for huge corridors).
      if (json.length > MAX_WEB_JSON_CHARS * 4) return null;
    }

    const id = crypto.randomUUID();
    const meta: RoadPackMeta = {
      id,
      label: options?.label ?? labelForBbox(bbox, collection.features.length),
      bbox,
      featureCount: collection.features.length,
      createdAt: new Date().toISOString(),
      bytes: json.length,
      cacheKey: options?.cacheKey,
      coverage: collection.region?.coverage,
      schema: PACK_SCHEMA,
      kind,
      roads: mainRoadNames(collection),
    };

    await storageManager.writeTextFile(`${PACK_DIR}/${id}.json`, json);
    await appDatabase.setJson(`road-pack-meta:${id}`, meta);
    const keyed = kind !== 'corridor';
    const indexKey = keyed ? BACKBONE_INDEX_KEY : INDEX_KEY;
    const cap = keyed ? MAX_BACKBONE_PACKS : MAX_CORRIDOR_PACKS;
    const ids = (await appDatabase.getJson<string[]>(indexKey)) ?? [];
    if (!ids.includes(id)) {
      ids.unshift(id);
      // Cap stored packs so devices don't fill up.
      const dropped = ids.splice(cap);
      await appDatabase.setJson(indexKey, ids);
      for (const drop of dropped) await this.deletePack(drop);
    }
    return meta;
  }

  async deletePack(id: string): Promise<void> {
    await storageManager.deleteFile(`${PACK_DIR}/${id}.json`);
    await appDatabase.remove(`road-pack-meta:${id}`);
    for (const indexKey of [INDEX_KEY, BACKBONE_INDEX_KEY]) {
      const ids = (await appDatabase.getJson<string[]>(indexKey)) ?? [];
      if (!ids.includes(id)) continue;
      await appDatabase.setJson(
        indexKey,
        ids.filter((x) => x !== id),
      );
    }
  }

  async deleteAll(): Promise<void> {
    for (const indexKey of [INDEX_KEY, BACKBONE_INDEX_KEY]) {
      const ids = (await appDatabase.getJson<string[]>(indexKey)) ?? [];
      for (const id of ids) {
        await storageManager.deleteFile(`${PACK_DIR}/${id}.json`);
        await appDatabase.remove(`road-pack-meta:${id}`);
      }
      await appDatabase.setJson(indexKey, []);
    }
  }
}

function isCurrent(meta: RoadPackMeta): boolean {
  return (meta.schema ?? 1) >= PACK_SCHEMA;
}

const MAJOR_HIGHWAYS = new Set(['motorway', 'trunk', 'primary', 'secondary']);

/** The two names on the most ways, bigger roads counting more. */
export function mainRoadNames(collection: NetworkFeatureCollection): string[] {
  const tally = new Map<string, number>();
  for (const feature of collection.features) {
    const name = feature.properties?.name?.trim();
    if (!name) continue;
    const highway = feature.properties?.highway?.replace(/_link$/, '') ?? '';
    tally.set(name, (tally.get(name) ?? 0) + (MAJOR_HIGHWAYS.has(highway) ? 4 : 1));
  }
  return [...tally]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([name]) => name);
}

function labelForBbox(bbox: BBox, featureCount: number): string {
  const [west, south, east, north] = bbox;
  const midLat = (south + north) / 2;
  const midLng = (west + east) / 2;
  const spanKm = Math.max(
    Math.abs(east - west) * 111 * Math.cos((midLat * Math.PI) / 180),
    Math.abs(north - south) * 111,
  );
  return `Roads · ${midLat.toFixed(2)}°, ${midLng.toFixed(2)}° · ~${Math.max(1, Math.round(spanKm))} km · ${featureCount} ways`;
}

export const roadPackService = new RoadPackService();
