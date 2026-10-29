import {
  bytesToHeader,
  Compression,
  readVarint,
  TileType,
  zxyToTileId,
  type Entry,
  type Header,
  type Source,
} from 'pmtiles';

/**
 * Writes PMTiles v3 archives (https://github.com/protomaps/PMTiles/blob/main/spec/v3/spec.md),
 * and lists every tile in one (`readArchive`). The `pmtiles` package only
 * reads single tiles.
 *
 * Tiles are appended as they download, so the file is laid out as:
 *
 *   [header + root directory, padded to HEAD_BYTES][tile data][leaf directories][metadata]
 *
 * The caller reserves HEAD_BYTES, appends each chunk `addTile` returns,
 * then appends `finish().tail` and writes `finish().head` at offset 0.
 */

/** Readers fetch the first 16 KiB for the header and root directory. */
export const HEAD_BYTES = 16_384;
const HEADER_BYTES = 127;

export interface PmtilesBounds {
  minZoom: number;
  maxZoom: number;
  /** [west, south, east, north] */
  bbox: [number, number, number, number];
}

export interface PmtilesHeaderFields extends PmtilesBounds {
  rootDirectoryOffset: number;
  rootDirectoryLength: number;
  jsonMetadataOffset: number;
  jsonMetadataLength: number;
  leafDirectoryOffset: number;
  leafDirectoryLength: number;
  tileDataOffset: number;
  tileDataLength: number;
  numAddressedTiles: number;
  numTileEntries: number;
  numTileContents: number;
  clustered: boolean;
  tileCompression: number;
  tileType: number;
}

/** Gzip, the internal compression every reader supports. */
export async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export function encodeHeader(h: PmtilesHeaderFields): Uint8Array {
  const bytes = new Uint8Array(HEADER_BYTES);
  const view = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode('PMTiles'), 0);
  bytes[7] = 3;
  const u64 = (offset: number, value: number) => {
    view.setUint32(offset, value % 2 ** 32, true);
    view.setUint32(offset + 4, Math.floor(value / 2 ** 32), true);
  };
  u64(8, h.rootDirectoryOffset);
  u64(16, h.rootDirectoryLength);
  u64(24, h.jsonMetadataOffset);
  u64(32, h.jsonMetadataLength);
  u64(40, h.leafDirectoryOffset);
  u64(48, h.leafDirectoryLength);
  u64(56, h.tileDataOffset);
  u64(64, h.tileDataLength);
  u64(72, h.numAddressedTiles);
  u64(80, h.numTileEntries);
  u64(88, h.numTileContents);
  bytes[96] = h.clustered ? 1 : 0;
  bytes[97] = Compression.Gzip;
  bytes[98] = h.tileCompression;
  bytes[99] = h.tileType;
  bytes[100] = h.minZoom;
  bytes[101] = h.maxZoom;
  const [west, south, east, north] = h.bbox;
  view.setInt32(102, Math.round(west * 1e7), true);
  view.setInt32(106, Math.round(south * 1e7), true);
  view.setInt32(110, Math.round(east * 1e7), true);
  view.setInt32(114, Math.round(north * 1e7), true);
  bytes[118] = Math.min(h.maxZoom, Math.max(h.minZoom, Math.round((h.minZoom + h.maxZoom) / 2)));
  view.setInt32(119, Math.round(((west + east) / 2) * 1e7), true);
  view.setInt32(123, Math.round(((south + north) / 2) * 1e7), true);
  return bytes;
}

export function writeVarint(out: number[], value: number): void {
  while (value >= 0x80) {
    out.push((value % 0x80) | 0x80);
    value = Math.floor(value / 0x80);
  }
  out.push(value);
}

/** Entries must be sorted by tileId. */
export async function serializeDirectory(entries: Entry[]): Promise<Uint8Array> {
  const out: number[] = [];
  writeVarint(out, entries.length);
  let lastId = 0;
  for (const entry of entries) {
    writeVarint(out, entry.tileId - lastId);
    lastId = entry.tileId;
  }
  for (const entry of entries) writeVarint(out, entry.runLength);
  for (const entry of entries) writeVarint(out, entry.length);
  entries.forEach((entry, i) => {
    const prev = entries[i - 1];
    // 0 means "straight after the previous tile".
    writeVarint(out, prev && entry.offset === prev.offset + prev.length ? 0 : entry.offset + 1);
  });
  return gzip(new Uint8Array(out));
}

/** The entries of a directory serializeDirectory wrote (already decompressed). */
export function parseDirectory(bytes: Uint8Array): Entry[] {
  const p = { buf: bytes, pos: 0 };
  const entries: Entry[] = [];
  let lastId = 0;
  for (let i = readVarint(p); i > 0; i--) {
    lastId += readVarint(p);
    entries.push({ tileId: lastId, offset: 0, length: 0, runLength: 1 });
  }
  for (const entry of entries) entry.runLength = readVarint(p);
  for (const entry of entries) entry.length = readVarint(p);
  entries.forEach((entry, i) => {
    const value = readVarint(p);
    const prev = entries[i - 1];
    entry.offset = value === 0 && prev ? prev.offset + prev.length : value - 1;
  });
  return entries;
}

export interface ArchiveContents {
  header: Header;
  /** Every tile entry, with `offset` counted from the start of the file. */
  entries: Entry[];
  metadata: unknown;
}

/** Reads an archive's header, all of its directories and its metadata. */
export async function readArchive(source: Source): Promise<ArchiveContents> {
  const head = new Uint8Array((await source.getBytes(0, HEAD_BYTES)).data);
  if (head.length < HEADER_BYTES || new TextDecoder().decode(head.subarray(0, 7)) !== 'PMTiles') {
    throw new Error('Not a PMTiles file');
  }
  const header = bytesToHeader(head.slice(0, HEADER_BYTES).buffer);
  const read = async (offset: number, length: number) =>
    offset + length <= head.length
      ? head.subarray(offset, offset + length)
      : new Uint8Array((await source.getBytes(offset, length)).data);
  const decompress = (bytes: Uint8Array) =>
    header.internalCompression === Compression.Gzip ? gunzip(bytes) : Promise.resolve(bytes);

  const entries: Entry[] = [];
  const walk = async (offset: number, length: number, depth: number): Promise<void> => {
    if (depth > 3) throw new Error('PMTiles directories nest too deep');
    for (const entry of parseDirectory(await decompress(await read(offset, length)))) {
      if (entry.runLength === 0) {
        await walk(header.leafDirectoryOffset + entry.offset, entry.length, depth + 1);
      } else {
        entries.push({ ...entry, offset: header.tileDataOffset + entry.offset });
      }
    }
  };
  await walk(header.rootDirectoryOffset, header.rootDirectoryLength, 0);

  let metadata: unknown = {};
  if (header.jsonMetadataLength > 0) {
    const json = await decompress(await read(header.jsonMetadataOffset, header.jsonMetadataLength));
    metadata = JSON.parse(new TextDecoder().decode(json));
  }
  return { header, entries, metadata };
}

/**
 * Reads many byte ranges of `source` in a few large reads (one bridge
 * call each on Android) and hands each range over in file order.
 */
export async function readRanges<T extends { offset: number; length: number }>(
  source: Source,
  ranges: T[],
  onRange: (range: T, bytes: Uint8Array) => Promise<void> | void,
  maxChunk = 4 * 1024 * 1024,
): Promise<void> {
  const sorted = [...ranges].sort((a, b) => a.offset - b.offset);
  // Small gaps (tiles another map replaced) are read through.
  const gap = 64 * 1024;
  for (let i = 0; i < sorted.length; ) {
    const start = sorted[i]!.offset;
    let end = start + sorted[i]!.length;
    let j = i + 1;
    while (j < sorted.length) {
      const next = sorted[j]!;
      const nextEnd = Math.max(end, next.offset + next.length);
      if (next.offset > end + gap || nextEnd - start > maxChunk) break;
      end = nextEnd;
      j += 1;
    }
    const chunk = new Uint8Array((await source.getBytes(start, end - start)).data);
    for (; i < j; i++) {
      const range = sorted[i]!;
      await onRange(range, chunk.subarray(range.offset - start, range.offset - start + range.length));
    }
  }
}

/**
 * Root directory, plus leaf directories when the root would not fit in
 * the first 16 KiB. Leaf entries in the root have runLength 0 and an
 * offset into the leaf section.
 */
export async function buildDirectories(
  entries: Entry[],
): Promise<{ root: Uint8Array; leaves: Uint8Array }> {
  const room = HEAD_BYTES - HEADER_BYTES;
  const root = await serializeDirectory(entries);
  if (root.length <= room) return { root, leaves: new Uint8Array(0) };

  for (let leafSize = 4096; ; leafSize *= 2) {
    const rootEntries: Entry[] = [];
    const leafParts: Uint8Array[] = [];
    let offset = 0;
    for (let i = 0; i < entries.length; i += leafSize) {
      const chunk = entries.slice(i, i + leafSize);
      const leaf = await serializeDirectory(chunk);
      rootEntries.push({ tileId: chunk[0]!.tileId, offset, length: leaf.length, runLength: 0 });
      leafParts.push(leaf);
      offset += leaf.length;
    }
    const nextRoot = await serializeDirectory(rootEntries);
    if (nextRoot.length <= room) return { root: nextRoot, leaves: concatBytes(leafParts) };
  }
}

export function concatBytes(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/**
 * Collects tile entries while their bytes are appended elsewhere.
 * Identical tiles (open sea, empty land) are stored once.
 */
export class PmtilesBuilder {
  private entries: Entry[] = [];
  private byContent = new Map<string, { offset: number; length: number }>();
  private tileDataLength = 0;
  private contents = 0;

  /** Bytes in the tile data section so far. */
  get dataBytes(): number {
    return this.tileDataLength;
  }

  get tileCount(): number {
    return this.entries.length;
  }

  /** Where each tile went, `offset` counted from the start of the tile data. */
  get placements(): readonly Entry[] {
    return this.entries;
  }

  /**
   * Records a tile (already compressed as the archive says) and returns
   * the bytes to append, or null when the same tile is already stored.
   */
  addTile(z: number, x: number, y: number, data: Uint8Array): Promise<Uint8Array | null> {
    return this.addTileById(zxyToTileId(z, x, y), data);
  }

  async addTileById(tileId: number, data: Uint8Array): Promise<Uint8Array | null> {
    const key = await contentKey(data);
    const seen = this.byContent.get(key);
    if (seen) {
      this.entries.push({ tileId, offset: seen.offset, length: seen.length, runLength: 1 });
      return null;
    }
    const placed = { offset: this.tileDataLength, length: data.length };
    this.byContent.set(key, placed);
    this.entries.push({ tileId, ...placed, runLength: 1 });
    this.tileDataLength += data.length;
    this.contents += 1;
    return data;
  }

  /** `head` goes at offset 0 (HEAD_BYTES long); `tail` is appended after the tile data. */
  async finish(
    bounds: PmtilesBounds,
    metadata: unknown,
    tileType: number = TileType.Mvt,
    tileCompression: number = Compression.Gzip,
  ): Promise<{ head: Uint8Array; tail: Uint8Array }> {
    const entries = mergeRuns([...this.entries].sort((a, b) => a.tileId - b.tileId));
    const { root, leaves } = await buildDirectories(entries);
    const meta = await gzip(new TextEncoder().encode(JSON.stringify(metadata)));
    const leafOffset = HEAD_BYTES + this.tileDataLength;
    const header = encodeHeader({
      ...bounds,
      rootDirectoryOffset: HEADER_BYTES,
      rootDirectoryLength: root.length,
      jsonMetadataOffset: leafOffset + leaves.length,
      jsonMetadataLength: meta.length,
      leafDirectoryOffset: leafOffset,
      leafDirectoryLength: leaves.length,
      tileDataOffset: HEAD_BYTES,
      tileDataLength: this.tileDataLength,
      numAddressedTiles: entries.reduce((sum, entry) => sum + entry.runLength, 0),
      numTileEntries: entries.length,
      numTileContents: this.contents,
      clustered: false,
      tileCompression,
      tileType,
    });
    const head = new Uint8Array(HEAD_BYTES);
    head.set(header, 0);
    head.set(root, HEADER_BYTES);
    return { head, tail: concatBytes([leaves, meta]) };
  }
}

/** Neighbouring tile ids with the same content become one entry with a run length. */
function mergeRuns(sorted: Entry[]): Entry[] {
  const out: Entry[] = [];
  for (const entry of sorted) {
    const last = out[out.length - 1];
    if (
      last &&
      last.offset === entry.offset &&
      last.length === entry.length &&
      last.tileId + last.runLength === entry.tileId
    ) {
      last.runLength += 1;
    } else if (!last || last.tileId !== entry.tileId) {
      out.push({ ...entry });
    }
  }
  return out;
}

async function contentKey(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data as BufferSource);
  return `${data.length}:${btoa(String.fromCharCode(...new Uint8Array(digest)))}`;
}

export { HEADER_BYTES };
