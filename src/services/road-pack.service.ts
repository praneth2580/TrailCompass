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
const PACK_DIR = 'road-packs';
/** Skip persisting huge extracts on web localStorage. */
const MAX_WEB_JSON_CHARS = 1_800_000;

export type BBox = [west: number, south: number, east: number, north: number];

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
}

/**
 * Persist OSM road extracts so nearby re-plans skip Overpass.
 * Index in Preferences; GeoJSON body on disk (or localStorage on web).
 */
export class RoadPackService {
  async listPacks(): Promise<RoadPackMeta[]> {
    const ids = (await appDatabase.getJson<string[]>(INDEX_KEY)) ?? [];
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
      if (!bboxCoversPoints(meta.bbox, points, 0.002)) continue;
      if (!coverageIncludesPoints(meta.coverage, points)) continue;
      const loaded = await this.getPack(meta.id);
      if (loaded) return loaded;
    }
    return null;
  }

  async saveFromCollection(
    collection: NetworkFeatureCollection,
    options?: { cacheKey?: string; label?: string },
  ): Promise<RoadPackMeta | null> {
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
    };

    await storageManager.writeTextFile(`${PACK_DIR}/${id}.json`, json);
    await appDatabase.setJson(`road-pack-meta:${id}`, meta);
    const ids = (await appDatabase.getJson<string[]>(INDEX_KEY)) ?? [];
    if (!ids.includes(id)) {
      ids.unshift(id);
      // Cap stored packs so devices don't fill up.
      while (ids.length > 40) {
        const drop = ids.pop();
        if (drop) await this.deletePack(drop);
      }
      await appDatabase.setJson(INDEX_KEY, ids);
    }
    return meta;
  }

  async deletePack(id: string): Promise<void> {
    await storageManager.deleteFile(`${PACK_DIR}/${id}.json`);
    await appDatabase.remove(`road-pack-meta:${id}`);
    const ids = (await appDatabase.getJson<string[]>(INDEX_KEY)) ?? [];
    await appDatabase.setJson(
      INDEX_KEY,
      ids.filter((x) => x !== id),
    );
  }

  async deleteAll(): Promise<void> {
    const ids = (await appDatabase.getJson<string[]>(INDEX_KEY)) ?? [];
    for (const id of ids) {
      await storageManager.deleteFile(`${PACK_DIR}/${id}.json`);
      await appDatabase.remove(`road-pack-meta:${id}`);
    }
    await appDatabase.setJson(INDEX_KEY, []);
  }
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
