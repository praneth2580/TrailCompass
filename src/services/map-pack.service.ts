import { Compression, TileType, tileIdToZxy, zxyToTileId, type Source } from 'pmtiles';
import { appDatabase } from '../database/database';
import { packFiles, type ShareableFile } from '../offline/pack-files';
import {
  gzip,
  HEAD_BYTES,
  PmtilesBuilder,
  readArchive,
  readRanges,
  type ArchiveContents,
} from '../offline/pmtiles-writer';
import {
  MAX_TILES,
  planAreaTiles,
  planRouteTiles,
  type AreaShape,
  type TileKey,
  type TilePlan,
} from '../offline/tile-plan';
import {
  fetchBytes,
  fillTemplate,
  MAP_ATTRIBUTION,
  planetTilesTemplate,
  planetVersion,
  prefetchMapAssets,
} from '../offline/tile-protocol';
import {
  decodeTileIds,
  encodeTileIds,
  groupTileTimes,
  readTileTimes,
  tileStore,
  type TileTime,
  type TileTimeGroup,
} from '../offline/tile-store';
import { parseRouteFile, suggestedFileName, toRouteFile } from '../routing/route-file';
import { abortError, anySignal, isAbortError } from '../routing/abort';
import type { SavedRoute, TrailCompassRouteFile } from '../types/route';
import { downloadPolicy } from './download-policy.service';

/**
 * Offline maps: the map along a saved trip, or an area such as a city or
 * a state. A map is a list of tiles. The tiles themselves are kept once,
 * in the tile store (offline/tile-store.ts), so maps that overlap share
 * them, and saving or updating a map only fetches tiles that are missing
 * or from an older OpenFreeMap build.
 *
 * A shared map is a PMTiles file (`<name>.trailcompass.pmtiles`) with the
 * map's tiles, each tile's download time, the map's details and, for a
 * trip, the route. Importing one merges it in as if it had been
 * downloaded here: of each tile and of the map's details, the newer copy
 * wins.
 */

const CATALOG_KEY = 'offline-maps';
/** Before the tile store: one PMTiles file per trip, listed under this key. */
const OLD_INDEX_KEY = 'map-packs';
const OLD_PACK_DIR = 'packs';
export const MAP_FILE_EXTENSION = '.trailcompass.pmtiles';
/** OpenFreeMap's limits for one offline download: 3,000 tiles (tile-plan.ts), 50 MB and 4 requests at a time. */
const MAX_DOWNLOAD_BYTES = 48 * 1024 * 1024;
const CONCURRENCY = 4;
const TILE_ATTEMPTS = 3;
/** A big tile on a slow connection can take a while; the map on screen waits less. */
const TILE_TIMEOUT_MS = 30_000;
/** Tiles that failed get one more go this long after the rest are in. */
const RETRY_PAUSE_MS = 3_000;
/** This many tiles failing in a row means the connection is gone, not a tile. */
const GIVE_UP_AFTER = 8;
const CONNECTION_LOST = 'Map download failed. Check the connection and try again.';
const SHARE_FORMAT = 'trailcompass-map';
const SHARE_VERSION = 2;

export type MapPackKind = 'route' | 'area';

/** A map's details: kept here, and carried in a shared file. */
interface PackRecord {
  /** `route:<route id>` or `area:<OpenStreetMap id>`, the same on every phone. */
  id: string;
  kind: MapPackKind;
  routeId?: string;
  name: string;
  /** [west, south, east, north] */
  bbox: [number, number, number, number];
  minZoom: number;
  maxZoom: number;
  /** The tiles it needs (encodeTileIds). */
  tileIds: string;
  tiles: number;
  /** When this phone first kept it. */
  createdAt: string;
  /**
   * When its tiles were last downloaded or brought up to date, kept
   * through sharing. Null until a download finishes.
   */
  downloadedAt: string | null;
  /** The OpenFreeMap build of that download. */
  planet: string;
  /** The 50 MB limit stopped the download short of the closest zoom. */
  trimmed?: boolean;
}

export interface MapPackMeta extends Omit<PackRecord, 'tileIds'> {
  /** Its tiles' size on the phone. Tiles shared with other maps count in each. */
  bytes: number;
  /** How many of its tiles are on the phone. */
  saved: number;
}

export type MapPackJob =
  | { packId: string; state: 'queued' }
  | { packId: string; state: 'waiting-wifi' }
  | {
      packId: string;
      state: 'downloading';
      done: number;
      total: number;
      /** Tiles that failed, being tried again after the rest. */
      retrying?: number;
    }
  | { packId: string; state: 'error'; message: string };

/** An area to save, e.g. a search result. */
export interface MapArea {
  /** The same on every phone (an OpenStreetMap id), so one area is one map. */
  key: string;
  name: string;
  shape: AreaShape;
}

type SharedPack = Omit<PackRecord, 'createdAt'>;

interface ShareMetadata {
  trailcompass?: {
    format?: string;
    version?: number;
    pack?: SharedPack;
    route?: TrailCompassRouteFile;
    times?: TileTimeGroup[];
  };
}

/** A shared map file, read but not kept yet. */
export interface SharedMapFile {
  readonly pack: SharedPack;
  /** A trip map's route. */
  readonly route?: SavedRoute;
  readonly source: Source;
  readonly contents: ArchiveContents;
  readonly times: Map<number, TileTime>;
}

export interface MapImportResult {
  pack: MapPackMeta;
  /** Tiles taken from the file: new here, or a newer download than the copy here. */
  added: number;
  /** Tiles the phone already had in the same or a newer copy. */
  skipped: number;
  /** The file's map was new here or newer, and its details replaced this phone's. */
  replaced: boolean;
}

export function routePackId(routeId: string): string {
  return `route:${routeId}`;
}

export function areaPackId(key: string): string {
  return `area:${key}`;
}

export class MapPackService {
  private records = new Map<string, PackRecord>();
  private tileLists = new Map<string, { encoded: string; tileIds: number[] }>();
  private metas: MapPackMeta[] | null = null;
  private loaded: Promise<void> | null = null;
  private jobs = new Map<string, MapPackJob>();
  private running = new Map<string, { promise: Promise<MapPackMeta | null>; controller: AbortController }>();
  private queue: Promise<unknown> = Promise.resolve();
  /** Imports and shares reading or writing tiles right now. */
  private busy = 0;
  private collecting: Promise<void> | null = null;
  private collectAgain = false;
  private listeners = new Set<() => void>();

  /** Loads the maps and the tile store. */
  init(): Promise<void> {
    this.loaded ??= (async () => {
      await this.dropOldPacks();
      await tileStore.init();
      for (const record of (await appDatabase.getJson<PackRecord[]>(CATALOG_KEY)) ?? []) {
        this.records.set(record.id, record);
      }
      this.changed();
      this.collectSoon();
    })();
    return this.loaded;
  }

  /** Newest first. */
  async list(): Promise<MapPackMeta[]> {
    await this.init();
    return [...this.allMetas()];
  }

  /** Synchronous; undefined until `init` resolves. */
  get(packId: string): MapPackMeta | undefined {
    return this.allMetas().find((meta) => meta.id === packId);
  }

  packForRoute(routeId: string): MapPackMeta | undefined {
    return this.get(routePackId(routeId));
  }

  getJob(packId: string): MapPackJob | undefined {
    return this.jobs.get(packId);
  }

  /** What all offline maps take up on the phone, shared tiles counted once. */
  diskBytes(): number {
    return tileStore.diskBytes();
  }

  /** How many of these tiles the phone already has. */
  savedCount(tiles: TileKey[]): number {
    return tiles.filter(([z, x, y]) => tileStore.get(zxyToTileId(z, x, y))).length;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Saves the map along `route`, or brings it up to date. One download
   * runs at a time; resolves null when stopped.
   */
  async downloadRoute(route: SavedRoute): Promise<MapPackMeta | null> {
    await this.init();
    const id = routePackId(route.id);
    const running = this.running.get(id);
    if (running) return running.promise;
    const plan = planRouteTiles(route.coordinates, MAX_TILES);
    await this.putRecord(this.planned(id, 'route', route.name, plan, route.id));
    return this.enqueue(id);
  }

  /** Saves an area's map, or brings it up to date. */
  async downloadArea(area: MapArea): Promise<MapPackMeta | null> {
    await this.init();
    const id = areaPackId(area.key);
    const running = this.running.get(id);
    if (running) return running.promise;
    await this.putRecord(this.planned(id, 'area', area.name, planAreaTiles(area.shape, MAX_TILES)));
    return this.enqueue(id);
  }

  /** Fetches a map's missing tiles and those from an older OpenFreeMap build. */
  async update(packId: string): Promise<MapPackMeta | null> {
    await this.init();
    if (!this.records.has(packId)) throw new Error('That offline map is gone');
    return this.enqueue(packId);
  }

  cancel(packId: string): void {
    this.running.get(packId)?.controller.abort();
    if (this.jobs.get(packId)?.state === 'error') {
      this.jobs.delete(packId);
      this.emit();
    }
  }

  /** Forgets the map; tiles no other map uses are deleted. */
  async delete(packId: string): Promise<void> {
    await this.init();
    this.running.get(packId)?.controller.abort();
    this.jobs.delete(packId);
    if (!this.records.delete(packId)) return;
    this.tileLists.delete(packId);
    await this.persist();
    this.collectSoon();
  }

  async deleteForRoute(routeId: string): Promise<void> {
    await this.delete(routePackId(routeId));
  }

  /** Removes maps whose trip is gone (run at start-up, so Undo after a delete keeps its map). */
  async pruneOrphans(routeIds: string[]): Promise<void> {
    await this.init();
    const keep = new Set(routeIds);
    for (const record of [...this.records.values()]) {
      if (record.kind !== 'route' || keep.has(record.routeId ?? '') || this.running.has(record.id)) continue;
      await this.delete(record.id);
    }
  }

  /**
   * The map's saved tiles in one file to share, with its details and each
   * tile's download time; a trip map carries `route` too. Null when the
   * map has no tiles saved.
   */
  async buildShareFile(
    packId: string,
    route?: SavedRoute,
  ): Promise<{ file: ShareableFile; fileName: string } | null> {
    await this.init();
    const record = this.records.get(packId);
    if (!record) return null;
    const tileIds = this.idsOf(record).filter((tileId) => tileStore.get(tileId));
    if (tileIds.length === 0) return null;

    const release = await this.hold();
    const name = route?.name ?? record.name;
    const fileName = route
      ? suggestedFileName(route).replace(/\.trailcompass\.json$/, MAP_FILE_EXTENSION)
      : `${fileSlug(name)}${MAP_FILE_EXTENSION}`;
    const writer = packFiles.createShareWriter(fileName);
    try {
      const builder = new PmtilesBuilder();
      const times = new Map<number, TileTime>();
      await writer.append(new Uint8Array(HEAD_BYTES));
      await tileStore.readRaw(tileIds, async (tileId, data, tile) => {
        times.set(tileId, { at: tile.at, planet: tile.planet });
        const chunk = await builder.addTileById(tileId, data);
        if (chunk) await writer.append(chunk);
      });
      const { createdAt: _createdAt, ...pack } = { ...record, name };
      const metadata: ShareMetadata & Record<string, unknown> = {
        name,
        description: record.kind === 'route' ? 'TrailCompass trip map' : 'TrailCompass offline area',
        attribution: MAP_ATTRIBUTION,
        type: 'baselayer',
        format: 'pbf',
        trailcompass: {
          format: SHARE_FORMAT,
          version: SHARE_VERSION,
          pack,
          ...(route ? { route: toRouteFile(route) } : {}),
          times: groupTileTimes(times),
        },
      };
      const { head, tail } = await builder.finish(
        { minZoom: record.minZoom, maxZoom: record.maxZoom, bbox: record.bbox },
        metadata,
      );
      await writer.append(tail);
      await writer.writeAt(0, head);
      return { file: await writer.finish(), fileName };
    } catch (e) {
      await writer.abort().catch(() => undefined);
      throw e;
    } finally {
      release();
    }
  }

  /** Reads a shared map file's details, without keeping anything yet. */
  async openSharedFile(file: Blob): Promise<SharedMapFile> {
    const source = blobSource(file);
    let contents: ArchiveContents;
    try {
      contents = await readArchive(source);
    } catch {
      throw new Error('Not a valid map file');
    }
    const meta = (contents.metadata as ShareMetadata | null)?.trailcompass;
    if (
      meta?.format !== SHARE_FORMAT ||
      meta.version !== SHARE_VERSION ||
      !isSharedPack(meta.pack) ||
      contents.header.tileType !== TileType.Mvt ||
      contents.header.tileCompression !== Compression.Gzip
    ) {
      throw new Error('This map file is not from this version of TrailCompass');
    }
    let pack = meta.pack;
    let route: SavedRoute | undefined;
    if (pack.kind === 'route') {
      if (!meta.route) throw new Error('This trip map has no route in it');
      route = parseRouteFile(JSON.stringify(meta.route));
      // A trip's map goes with the trip.
      pack = { ...pack, id: routePackId(route.id), routeId: route.id };
    }
    return { pack, route, source, contents, times: readTileTimes(meta.times) };
  }

  /**
   * Merges a shared map in as if it had been downloaded here: each of its
   * tiles that is new here or a newer download than the copy here, and
   * its details when they are newer than this phone's copy of the map.
   */
  async importSharedFile(
    shared: SharedMapFile,
    onProgress?: (done: number, total: number) => void,
  ): Promise<MapImportResult> {
    await this.init();
    const release = await this.hold();
    try {
      const existing = this.records.get(shared.pack.id);
      const replaced = !existing || dateValue(shared.pack.downloadedAt) > dateValue(existing.downloadedAt);
      const record: PackRecord = replaced
        ? { ...shared.pack, createdAt: existing?.createdAt ?? new Date().toISOString() }
        : existing;
      const wanted = new Set(this.idsOf(record));
      const fallback: TileTime = { at: dateValue(shared.pack.downloadedAt), planet: shared.pack.planet };

      const take: Array<{ tileId: number; offset: number; length: number; time: TileTime }> = [];
      let offered = 0;
      for (const entry of shared.contents.entries) {
        for (let i = 0; i < entry.runLength; i++) {
          const tileId = entry.tileId + i;
          if (!wanted.has(tileId)) continue;
          offered += 1;
          const time = shared.times.get(tileId) ?? fallback;
          const held = tileStore.get(tileId);
          if (!held || time.at > held.at) take.push({ tileId, offset: entry.offset, length: entry.length, time });
        }
      }

      const writer = tileStore.writer();
      let done = 0;
      try {
        await readRanges(shared.source, take, async (tile, data) => {
          await writer.add(tile.tileId, data, tile.time);
          done += 1;
          onProgress?.(done, take.length);
        });
        await writer.finish();
      } catch (e) {
        await writer.discard();
        throw e;
      }
      await this.putRecord(record);
      return { pack: this.toMeta(record), added: take.length, skipped: offered - take.length, replaced };
    } finally {
      release();
    }
  }

  private planned(
    id: string,
    kind: MapPackKind,
    name: string,
    plan: TilePlan,
    routeId?: string,
  ): PackRecord {
    const existing = this.records.get(id);
    const tileIds = plan.tiles.map(([z, x, y]) => zxyToTileId(z, x, y));
    return {
      id,
      kind,
      ...(routeId ? { routeId } : {}),
      name,
      bbox: plan.bbox,
      minZoom: plan.minZoom,
      maxZoom: plan.maxZoom,
      tileIds: encodeTileIds(tileIds),
      tiles: new Set(tileIds).size,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
      downloadedAt: existing?.downloadedAt ?? null,
      planet: existing?.planet ?? 'unknown',
    };
  }

  private enqueue(packId: string): Promise<MapPackMeta | null> {
    const controller = new AbortController();
    this.setJob({ packId, state: 'queued' });
    const promise = this.queue
      .catch(() => undefined)
      .then(() => this.runDownload(packId, controller.signal))
      .then(
        (meta) => {
          this.jobs.delete(packId);
          return meta;
        },
        (e: unknown) => {
          if (isAbortError(e) || controller.signal.aborted) {
            this.jobs.delete(packId);
            return null;
          }
          this.jobs.set(packId, {
            packId,
            state: 'error',
            message: e instanceof Error ? e.message : "Couldn't save the map",
          });
          throw e;
        },
      )
      .finally(() => {
        this.running.delete(packId);
        this.changed();
        this.collectSoon();
      });
    this.queue = promise;
    this.running.set(packId, { promise, controller });
    return promise;
  }

  private async runDownload(packId: string, signal: AbortSignal): Promise<MapPackMeta | null> {
    await this.init();
    if (!this.records.has(packId)) return null;
    await this.waitForAllowedNetwork(packId, signal);
    const template = await planetTilesTemplate({ refresh: true });
    const planet = planetVersion(template);
    const release = await this.hold();
    try {
      const record = this.records.get(packId);
      if (!record) return null;
      // Tiles already saved from this build, by this map or another, aren't fetched again.
      const todo = this.idsOf(record).filter((tileId) => tileStore.get(tileId)?.planet !== planet);
      this.setJob({ packId, state: 'downloading', done: 0, total: todo.length });

      const writer = tileStore.writer();
      const time: TileTime = { at: Date.now(), planet };
      let done = 0;
      let transferred = 0;
      let full = false;
      let retrying = 0;
      let failedInARow = 0;
      /** Tiles that failed every attempt. */
      const missed: number[] = [];

      // At most 4 updates a second, the last one always shown.
      let lastReport = 0;
      let reportTimer: ReturnType<typeof setTimeout> | undefined;
      const report = () => {
        const emit = () => {
          reportTimer = undefined;
          lastReport = Date.now();
          this.setJob({ packId, state: 'downloading', done, total: todo.length, ...(retrying ? { retrying } : {}) });
        };
        const wait = 250 - (Date.now() - lastReport);
        if (wait <= 0) emit();
        else reportTimer ??= setTimeout(emit, wait);
      };

      // A lost connection or a failed write stops the other workers too.
      const failed = new AbortController();
      const tileSignal = anySignal([signal, failed.signal]);
      const pass = async (tileIds: number[]) => {
        let next = 0;
        const worker = async () => {
          try {
            while (next < tileIds.length && !full) {
              tileSignal.throwIfAborted();
              const tileId = tileIds[next++]!;
              let tile: Uint8Array;
              try {
                tile = await gzip(await fetchTile(template, tileIdToZxy(tileId), tileSignal));
              } catch (e) {
                if (tileSignal.aborted) throw e;
                // One stubborn tile mustn't sink the map: it's tried again at the end.
                missed.push(tileId);
                failedInARow += 1;
                if (failedInARow >= GIVE_UP_AFTER || navigator.onLine === false) throw new Error(CONNECTION_LOST);
                continue;
              }
              failedInARow = 0;
              transferred += tile.length;
              if (transferred >= MAX_DOWNLOAD_BYTES) full = true;
              await writer.add(tileId, tile, time);
              done += 1;
              report();
            }
          } catch (e) {
            failed.abort();
            throw e;
          }
        };
        const results = await Promise.allSettled(Array.from({ length: CONCURRENCY }, worker));
        const errors = results.flatMap((result) => (result.status === 'rejected' ? [result.reason as unknown] : []));
        if (errors.length > 0) throw errors.find((e) => !isAbortError(e)) ?? errors[0];
      };

      let failure: unknown = null;
      try {
        await pass(todo);
        if (missed.length > 0 && !full) {
          const again = missed.splice(0);
          retrying = again.length;
          report();
          await pause(RETRY_PAUSE_MS, tileSignal);
          failedInARow = 0;
          await pass(again);
        }
      } catch (e) {
        failure = e;
      } finally {
        clearTimeout(reportTimer);
      }
      // What arrived is kept even when stopped, so the next try carries on from there.
      try {
        await writer.finish();
      } catch (e) {
        await writer.discard();
        throw e;
      }
      if (signal.aborted) throw abortError();
      if (failure) throw failure;
      if (missed.length > 0) {
        throw new Error(
          missed.length === 1
            ? "1 map tile didn't download. Retry fetches it."
            : `${missed.length} map tiles didn't download. Retry fetches them.`,
        );
      }

      // Labels and icons, so the saved map draws fully offline.
      await prefetchMapAssets(signal).catch((e: unknown) => {
        if (isAbortError(e)) throw e;
      });
      const current = this.records.get(packId);
      if (!current) return null;
      const finished: PackRecord = {
        ...(full ? this.trimmed(current) : current),
        downloadedAt: new Date().toISOString(),
        planet,
      };
      await this.putRecord(finished);
      return this.toMeta(finished);
    } finally {
      release();
    }
  }

  /**
   * After the size limit: the map keeps the tiles that arrived. Low zooms
   * come first, so only part of its closest zoom is missing.
   */
  private trimmed(record: PackRecord): PackRecord {
    const keep = this.idsOf(record).filter((tileId) => tileStore.get(tileId));
    return {
      ...record,
      tileIds: encodeTileIds(keep),
      tiles: keep.length,
      maxZoom: keep.reduce((max, tileId) => Math.max(max, tileIdToZxy(tileId)[0]), record.minZoom),
      trimmed: true,
    };
  }

  /** With the "Wi-Fi only" setting on mobile data, waits for Wi-Fi. */
  private async waitForAllowedNetwork(packId: string, signal: AbortSignal): Promise<void> {
    await downloadPolicy.start();
    if (downloadPolicy.canDownload()) return;
    this.setJob({ packId, state: 'waiting-wifi' });
    await new Promise<void>((resolve, reject) => {
      const stop = () => {
        unsubscribe();
        signal.removeEventListener('abort', onAbort);
      };
      const unsubscribe = downloadPolicy.subscribe(() => {
        if (!downloadPolicy.canDownload()) return;
        stop();
        resolve();
      });
      const onAbort = () => {
        stop();
        reject(abortError());
      };
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  /**
   * Waits out a clean-up, then holds the next one off until the returned
   * function is called, so no tile file goes while it's being read.
   */
  private async hold(): Promise<() => void> {
    while (this.collecting) await this.collecting;
    this.busy += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.busy -= 1;
      this.collectSoon();
    };
  }

  /** Deletes tiles no map needs, once nothing is downloading, importing or sharing. */
  private collectSoon(): void {
    if (this.collecting) {
      this.collectAgain = true;
      return;
    }
    if (this.busy > 0 || this.running.size > 0) return;
    this.collecting = (async () => {
      const live = new Set<number>();
      for (const record of this.records.values()) {
        for (const tileId of this.idsOf(record)) live.add(tileId);
      }
      await tileStore.collect(live);
    })()
      // Tried again after the next change.
      .catch(() => undefined)
      .finally(() => {
        this.collecting = null;
        this.changed();
        if (this.collectAgain) {
          this.collectAgain = false;
          this.collectSoon();
        }
      });
  }

  /** Maps saved before the tile store were a file per trip; Library saves them again. */
  private async dropOldPacks(): Promise<void> {
    if ((await appDatabase.getJson<unknown>(OLD_INDEX_KEY)) == null) return;
    // Every file in the folder, including any the old list had lost track of.
    for (const name of await packFiles.list(OLD_PACK_DIR)) {
      await packFiles.delete(`${OLD_PACK_DIR}/${name}`);
    }
    await appDatabase.remove(OLD_INDEX_KEY);
  }

  private idsOf(record: PackRecord): number[] {
    const cached = this.tileLists.get(record.id);
    if (cached?.encoded === record.tileIds) return cached.tileIds;
    const tileIds = decodeTileIds(record.tileIds);
    this.tileLists.set(record.id, { encoded: record.tileIds, tileIds });
    return tileIds;
  }

  private allMetas(): MapPackMeta[] {
    this.metas ??= [...this.records.values()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((record) => this.toMeta(record));
    return this.metas;
  }

  private toMeta(record: PackRecord): MapPackMeta {
    const tileIds = this.idsOf(record);
    const { tileIds: _encoded, ...meta } = record;
    return {
      ...meta,
      bytes: tileStore.bytesOf(tileIds),
      saved: tileIds.filter((tileId) => tileStore.get(tileId)).length,
    };
  }

  private async putRecord(record: PackRecord): Promise<void> {
    this.records.set(record.id, record);
    await this.persist();
  }

  private async persist(): Promise<void> {
    await appDatabase.setJson(CATALOG_KEY, [...this.records.values()]);
    this.changed();
  }

  private setJob(job: MapPackJob): void {
    this.jobs.set(job.packId, job);
    this.emit();
  }

  /** Sizes and saved counts are worked out again on next read. */
  private changed(): void {
    this.metas = null;
    this.emit();
  }

  private emit(): void {
    for (const listener of [...this.listeners]) listener();
  }
}

/** How much of the road network a map shows, by its closest zoom (OpenMapTiles). */
export function mapDetail(maxZoom: number): string {
  if (maxZoom >= 14) return 'Street detail';
  if (maxZoom >= 13) return 'Most streets';
  if (maxZoom >= 11) return 'Main roads';
  if (maxZoom >= 9) return 'Major roads';
  return 'Highways only';
}

/** The day OpenFreeMap's build was made, from a name like "20261025_080012_pt". */
export function mapDataDate(planet: string): Date | null {
  const match = /^(\d{4})(\d{2})(\d{2})/.exec(planet);
  return match ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])) : null;
}

async function fetchTile(template: string, [z, x, y]: TileKey, signal: AbortSignal): Promise<Uint8Array> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fetchBytes(fillTemplate(template, z, x, y), signal, TILE_TIMEOUT_MS);
    } catch (e) {
      if (signal.aborted || attempt >= TILE_ATTEMPTS) throw signal.aborted ? e : new Error(CONNECTION_LOST);
      await pause(1_000 * attempt, signal);
    }
  }
}

/** Waits `ms`, or rejects when `signal` aborts first. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function isSharedPack(pack: unknown): pack is SharedPack {
  if (!pack || typeof pack !== 'object') return false;
  const p = pack as Record<string, unknown>;
  return (
    typeof p.id === 'string' &&
    (p.kind === 'route' || (p.kind === 'area' && p.id.startsWith('area:'))) &&
    typeof p.name === 'string' &&
    Array.isArray(p.bbox) &&
    p.bbox.length === 4 &&
    p.bbox.every((value) => typeof value === 'number') &&
    typeof p.minZoom === 'number' &&
    typeof p.maxZoom === 'number' &&
    typeof p.tileIds === 'string' &&
    typeof p.tiles === 'number' &&
    (p.downloadedAt === null || typeof p.downloadedAt === 'string') &&
    typeof p.planet === 'string'
  );
}

/** Milliseconds of an ISO date, 0 when missing. */
function dateValue(iso: string | null | undefined): number {
  return (iso && Date.parse(iso)) || 0;
}

function blobSource(blob: Blob): Source {
  return {
    getKey: () => 'shared-map',
    getBytes: async (offset, length) => ({ data: await blob.slice(offset, offset + length).arrayBuffer() }),
  };
}

function fileSlug(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48);
  return slug || 'offline-map';
}

/** A PMTiles file, by name or by its first bytes ("PMTiles"). */
export async function isMapFile(file: Blob & { name?: string }): Promise<boolean> {
  if (/\.pmtiles$/i.test(file.name ?? '')) return true;
  const magic = new TextDecoder().decode(await file.slice(0, 7).arrayBuffer());
  return magic === 'PMTiles';
}

export const mapPackService = new MapPackService();
