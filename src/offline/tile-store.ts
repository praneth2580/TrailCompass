import { Compression, readVarint, tileIdToZxy, type Source } from 'pmtiles';
import {
  base64ToBytes,
  bytesToBase64,
  packFiles,
  type PackFiles,
  type PackFileWriter,
} from './pack-files';
import {
  gunzip,
  HEAD_BYTES,
  PmtilesBuilder,
  readArchive,
  readRanges,
  writeVarint,
  type PmtilesBounds,
} from './pmtiles-writer';
import { tileBounds } from './tile-plan';

/**
 * Every map tile on the phone, each kept once. Offline maps
 * (services/map-pack.service.ts) are lists of the tiles they need; the
 * tiles live here, in PMTiles files ("segments") under `tiles/`, written
 * by downloads and imports.
 *
 * Each tile carries the time it was downloaded from OpenFreeMap. When a
 * tile is saved again the newer copy wins, and the older one is garbage
 * until `collect` rewrites or deletes its file.
 */

const DIR = 'tiles';
const FORMAT = 'trailcompass-tiles';
/** A long download is split into files this size, so closing the app keeps what arrived. */
const SEGMENT_MAX_TILES = 500;
const SEGMENT_MAX_BYTES = 8 * 1024 * 1024;
/** A file is rewritten once over half of it, and at least 1 MB, is garbage. */
const REWRITE_SHARE = 0.5;
const REWRITE_MIN_BYTES = 1024 * 1024;

export interface TileTime {
  /** When it was downloaded from OpenFreeMap (ms since 1970). Kept through sharing. */
  at: number;
  /** The OpenFreeMap planet build it came from. */
  planet: string;
}

const UNKNOWN_TIME: TileTime = { at: 0, planet: 'unknown' };

interface Segment {
  path: string;
  source: Source;
  compression: number;
  /** Bytes of tile data in the file. */
  dataBytes: number;
  fileBytes: number;
}

export interface StoredTile extends TileTime {
  segment: Segment;
  /** From the start of the segment file. */
  offset: number;
  length: number;
}

type PlacedTile = [tileId: number, tile: Omit<StoredTile, 'segment'>];

/** Download times in PMTiles metadata: tiles grouped by time, as encodeTileIds lists. */
export interface TileTimeGroup {
  at: number;
  planet: string;
  tiles: string;
}

export class TileStore {
  private index = new Map<number, StoredTile>();
  private segments = new Set<Segment>();
  private loaded: Promise<void> | null = null;
  private readonly files: PackFiles;

  constructor(files: PackFiles = packFiles) {
    this.files = files;
  }

  /** Reads every segment's directory, once. */
  init(): Promise<void> {
    this.loaded ??= this.load();
    return this.loaded;
  }

  /** Synchronous; empty until `init` resolves. */
  get(tileId: number): StoredTile | undefined {
    return this.index.get(tileId);
  }

  get tileCount(): number {
    return this.index.size;
  }

  /** What the store takes up on the phone. */
  diskBytes(): number {
    let total = 0;
    for (const segment of this.segments) total += segment.fileBytes;
    return total;
  }

  /** The size of these tiles, each stored copy counted once. */
  bytesOf(tileIds: Iterable<number>): number {
    const seen = new Map<Segment, Set<number>>();
    let total = 0;
    for (const tileId of tileIds) {
      const tile = this.index.get(tileId);
      if (!tile) continue;
      let offsets = seen.get(tile.segment);
      if (!offsets) seen.set(tile.segment, (offsets = new Set()));
      if (offsets.has(tile.offset)) continue;
      offsets.add(tile.offset);
      total += tile.length;
    }
    return total;
  }

  /** A tile ready for the map (decompressed), or null when it isn't saved. */
  async readTile(tileId: number, signal?: AbortSignal): Promise<ArrayBuffer | null> {
    await this.init();
    const tile = this.index.get(tileId);
    if (!tile) return null;
    const { data } = await tile.segment.source.getBytes(tile.offset, tile.length, signal);
    if (tile.segment.compression !== Compression.Gzip) return data;
    const bytes = await gunzip(new Uint8Array(data));
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  }

  /** The stored (still compressed) bytes of these tiles, a few large reads per file. */
  async readRaw(
    tileIds: Iterable<number>,
    onTile: (tileId: number, data: Uint8Array, tile: StoredTile) => Promise<void> | void,
  ): Promise<void> {
    const bySegment = new Map<Segment, Array<StoredTile & { tileId: number }>>();
    for (const tileId of new Set(tileIds)) {
      const tile = this.index.get(tileId);
      if (!tile) continue;
      let tiles = bySegment.get(tile.segment);
      if (!tiles) bySegment.set(tile.segment, (tiles = []));
      tiles.push({ ...tile, tileId });
    }
    for (const [segment, tiles] of bySegment) {
      await readRanges(segment.source, tiles, (tile, data) => onTile(tile.tileId, data, tile));
    }
  }

  /** Writes tiles into new segments; each tile is served once its segment closes. */
  writer(): TileWriter {
    return new TileWriter(this, this.files);
  }

  /**
   * Forgets tiles no map needs (not in `live`), deletes files nothing
   * uses any more and rewrites files that are mostly garbage. Resolves
   * with the bytes freed.
   */
  async collect(live: ReadonlySet<number>): Promise<number> {
    await this.init();
    for (const tileId of [...this.index.keys()]) {
      if (!live.has(tileId)) this.index.delete(tileId);
    }
    const used = new Map<Segment, Map<number, number>>();
    for (const tile of this.index.values()) {
      let offsets = used.get(tile.segment);
      if (!offsets) used.set(tile.segment, (offsets = new Map()));
      offsets.set(tile.offset, tile.length);
    }

    let freed = 0;
    for (const segment of [...this.segments]) {
      let usedBytes = 0;
      for (const length of used.get(segment)?.values() ?? []) usedBytes += length;
      const garbage = segment.dataBytes - usedBytes;
      if (usedBytes > 0 && (garbage < REWRITE_MIN_BYTES || garbage < segment.dataBytes * REWRITE_SHARE)) {
        continue;
      }
      if (usedBytes > 0) {
        // Copy what's still used into a new file, download times and all.
        const writer = this.writer();
        const tileIds = [...this.index].filter(([, tile]) => tile.segment === segment).map(([id]) => id);
        await this.readRaw(tileIds, (tileId, data, tile) =>
          writer.add(tileId, data, { at: tile.at, planet: tile.planet }),
        );
        await writer.finish();
        freed -= writer.fileBytes;
      }
      this.segments.delete(segment);
      await this.files.delete(segment.path);
      freed += segment.fileBytes;
    }
    return freed;
  }

  /** For TileWriter: serves a finished segment's tiles. */
  addSegment(segment: Segment, tiles: PlacedTile[]): void {
    this.segments.add(segment);
    for (const [tileId, tile] of tiles) this.offer(tileId, { ...tile, segment });
  }

  /** Keeps `tile` unless the copy held is newer (on equal times, the later file wins). */
  private offer(tileId: number, tile: StoredTile): void {
    const held = this.index.get(tileId);
    if (!held || tile.at >= held.at) this.index.set(tileId, tile);
  }

  private async load(): Promise<void> {
    // Oldest first: names start with the time they were written.
    for (const name of (await this.files.list(DIR)).sort()) {
      const path = `${DIR}/${name}`;
      try {
        await this.open(path);
      } catch {
        // Cut short when the app closed mid-write, or damaged.
        await this.files.delete(path);
      }
    }
  }

  private async open(path: string): Promise<void> {
    const source = this.files.source(path);
    const { header, entries, metadata } = await readArchive(source);
    const meta = (metadata as { trailcompass?: { format?: string; times?: unknown } } | null)?.trailcompass;
    if (meta?.format !== FORMAT) throw new Error('Not a tile store file');
    const times = readTileTimes(meta.times);
    const tiles: PlacedTile[] = [];
    for (const entry of entries) {
      for (let i = 0; i < entry.runLength; i++) {
        const tileId = entry.tileId + i;
        tiles.push([tileId, { offset: entry.offset, length: entry.length, ...(times.get(tileId) ?? UNKNOWN_TIME) }]);
      }
    }
    this.addSegment(
      {
        path,
        source,
        compression: header.tileCompression,
        dataBytes: header.tileDataLength ?? 0,
        fileBytes: header.jsonMetadataOffset + header.jsonMetadataLength,
      },
      tiles,
    );
  }
}

/**
 * Writes tiles into new segment files, starting another every
 * SEGMENT_MAX_TILES or SEGMENT_MAX_BYTES. Calls may overlap (download
 * workers); the writes run one after another.
 */
export class TileWriter {
  private part: SegmentPart | null = null;
  private chain: Promise<void> = Promise.resolve();
  private written = 0;
  private closedBytes = 0;
  private readonly store: TileStore;
  private readonly files: PackFiles;

  constructor(store: TileStore, files: PackFiles) {
    this.store = store;
    this.files = files;
  }

  /** Tiles written so far. */
  get count(): number {
    return this.written;
  }

  /** Size of the files closed so far. */
  get fileBytes(): number {
    return this.closedBytes;
  }

  /** `data` is a gzip-compressed vector tile. */
  add(tileId: number, data: Uint8Array, time: TileTime): Promise<void> {
    this.chain = this.chain.then(async () => {
      this.part ??= new SegmentPart(this.files);
      await this.part.add(tileId, data, time);
      this.written += 1;
      if (this.part.full) await this.closePart();
    });
    return this.chain;
  }

  /** Closes the last file; every tile written is then served. */
  finish(): Promise<void> {
    this.chain = this.chain.then(() => this.closePart());
    return this.chain;
  }

  /** After a failed write: deletes the file being written. */
  async discard(): Promise<void> {
    const part = this.part;
    this.part = null;
    await part?.file.abort();
  }

  private async closePart(): Promise<void> {
    const part = this.part;
    this.part = null;
    if (!part) return;
    const { segment, tiles } = await part.close(this.files);
    this.closedBytes += segment.fileBytes;
    this.store.addSegment(segment, tiles);
  }
}

class SegmentPart {
  readonly path = `${DIR}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.pmtiles`;
  readonly file: PackFileWriter;
  private builder = new PmtilesBuilder();
  private times = new Map<number, TileTime>();

  constructor(files: PackFiles) {
    this.file = files.createWriter(this.path);
  }

  get full(): boolean {
    return this.times.size >= SEGMENT_MAX_TILES || this.builder.dataBytes >= SEGMENT_MAX_BYTES;
  }

  async add(tileId: number, data: Uint8Array, time: TileTime): Promise<void> {
    if (this.times.has(tileId)) return;
    // Room for the header and root directory, written last.
    if (this.times.size === 0) await this.file.append(new Uint8Array(HEAD_BYTES));
    this.times.set(tileId, time);
    const chunk = await this.builder.addTileById(tileId, data);
    if (chunk) await this.file.append(chunk);
  }

  async close(files: PackFiles): Promise<{ segment: Segment; tiles: PlacedTile[] }> {
    const { head, tail } = await this.builder.finish(boundsOf(this.times.keys()), {
      name: 'TrailCompass map tiles',
      type: 'baselayer',
      format: 'pbf',
      trailcompass: { format: FORMAT, version: 1, times: groupTileTimes(this.times) },
    });
    await this.file.append(tail);
    await this.file.writeAt(0, head);
    const fileBytes = await this.file.close();
    const tiles: PlacedTile[] = this.builder.placements.map((entry) => [
      entry.tileId,
      { offset: HEAD_BYTES + entry.offset, length: entry.length, ...this.times.get(entry.tileId)! },
    ]);
    return {
      segment: {
        path: this.path,
        source: files.source(this.path),
        compression: Compression.Gzip,
        dataBytes: this.builder.dataBytes,
        fileBytes,
      },
      tiles,
    };
  }
}

/** A tile list as compact text: sorted, de-duplicated, delta varints in base64. */
export function encodeTileIds(tileIds: Iterable<number>): string {
  const sorted = [...new Set(tileIds)].sort((a, b) => a - b);
  const out: number[] = [];
  let last = 0;
  for (const tileId of sorted) {
    writeVarint(out, tileId - last);
    last = tileId;
  }
  return bytesToBase64(Uint8Array.from(out));
}

/** Sorted by tile id, so low zooms come first. */
export function decodeTileIds(encoded: string): number[] {
  const p = { buf: base64ToBytes(encoded), pos: 0 };
  const tileIds: number[] = [];
  let last = 0;
  while (p.pos < p.buf.length) {
    last += readVarint(p);
    tileIds.push(last);
  }
  return tileIds;
}

export function groupTileTimes(times: ReadonlyMap<number, TileTime>): TileTimeGroup[] {
  const groups = new Map<string, { time: TileTime; tileIds: number[] }>();
  for (const [tileId, time] of times) {
    const key = `${time.at}|${time.planet}`;
    let group = groups.get(key);
    if (!group) groups.set(key, (group = { time, tileIds: [] }));
    group.tileIds.push(tileId);
  }
  return [...groups.values()].map(({ time, tileIds }) => ({
    at: time.at,
    planet: time.planet,
    tiles: encodeTileIds(tileIds),
  }));
}

/** Tile → download time, from groupTileTimes' output; ignores what doesn't parse. */
export function readTileTimes(groups: unknown): Map<number, TileTime> {
  const times = new Map<number, TileTime>();
  if (!Array.isArray(groups)) return times;
  for (const group of groups as Array<Partial<TileTimeGroup>>) {
    if (typeof group?.at !== 'number' || typeof group.tiles !== 'string') continue;
    const time = { at: group.at, planet: typeof group.planet === 'string' ? group.planet : 'unknown' };
    try {
      for (const tileId of decodeTileIds(group.tiles)) times.set(tileId, time);
    } catch {
      // A damaged group: its tiles count as old.
    }
  }
  return times;
}

function boundsOf(tileIds: Iterable<number>): PmtilesBounds {
  let minZoom = 32;
  let maxZoom = 0;
  let west = 180;
  let south = 90;
  let east = -180;
  let north = -90;
  for (const tileId of tileIds) {
    const [z, x, y] = tileIdToZxy(tileId);
    const [w, s, e, n] = tileBounds(z, x, y);
    minZoom = Math.min(minZoom, z);
    maxZoom = Math.max(maxZoom, z);
    west = Math.min(west, w);
    south = Math.min(south, s);
    east = Math.max(east, e);
    north = Math.max(north, n);
  }
  return { minZoom, maxZoom, bbox: [west, south, east, north] };
}

export const tileStore = new TileStore();
