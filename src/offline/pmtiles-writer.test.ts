import { describe, expect, it } from 'vitest';
import { PMTiles, type Source } from 'pmtiles';
import {
  concatBytes,
  gunzip,
  gzip,
  HEAD_BYTES,
  PmtilesBuilder,
  readArchive,
  readRanges,
} from './pmtiles-writer';

function memorySource(bytes: Uint8Array, key = 'memory'): Source {
  return {
    getKey: () => key,
    getBytes: async (offset, length) => ({
      data: bytes.slice(offset, offset + length).buffer,
    }),
  };
}

async function build(tiles: Array<[number, number, number, string]>, metadata: unknown) {
  const builder = new PmtilesBuilder();
  const chunks: Uint8Array[] = [];
  for (const [z, x, y, body] of tiles) {
    const chunk = await builder.addTile(z, x, y, await gzip(new TextEncoder().encode(body)));
    if (chunk) chunks.push(chunk);
  }
  const { head, tail } = await builder.finish(
    { minZoom: 0, maxZoom: 14, bbox: [72.8, 18.9, 73.4, 19.3] },
    metadata,
  );
  expect(head.length).toBe(HEAD_BYTES);
  return { file: concatBytes([head, ...chunks, tail]), builder };
}

async function readText(archive: PMTiles, z: number, x: number, y: number) {
  const tile = await archive.getZxy(z, x, y);
  return tile ? new TextDecoder().decode(tile.data) : undefined;
}

describe('PmtilesBuilder', () => {
  it('writes an archive the pmtiles reader can open', async () => {
    const { file, builder } = await build(
      [
        [14, 11520, 7400, 'city'],
        [0, 0, 0, 'world'],
        [10, 720, 462, 'region'],
        [14, 11521, 7400, 'sea'],
        [14, 11522, 7400, 'sea'],
      ],
      { name: 'Test', trailcompass: { route: 'r1' } },
    );
    // The repeated "sea" tile is stored once.
    expect(builder.tileCount).toBe(5);

    const archive = new PMTiles(memorySource(file));
    const header = await archive.getHeader();
    expect(header.specVersion).toBe(3);
    expect(header.minZoom).toBe(0);
    expect(header.maxZoom).toBe(14);
    expect(header.minLon).toBeCloseTo(72.8, 5);
    expect(header.maxLat).toBeCloseTo(19.3, 5);
    expect(header.numTileContents).toBe(4);
    expect(header.numAddressedTiles).toBe(5);

    expect(await readText(archive, 0, 0, 0)).toBe('world');
    expect(await readText(archive, 10, 720, 462)).toBe('region');
    expect(await readText(archive, 14, 11520, 7400)).toBe('city');
    expect(await readText(archive, 14, 11521, 7400)).toBe('sea');
    expect(await readText(archive, 14, 11522, 7400)).toBe('sea');
    expect(await readText(archive, 14, 11523, 7400)).toBeUndefined();
    expect(await archive.getMetadata()).toEqual({ name: 'Test', trailcompass: { route: 'r1' } });
  });

  it('moves entries into leaf directories when the root would not fit', async () => {
    const tiles: Array<[number, number, number, string]> = [];
    // Distinct contents and scattered ids, so neither dedup nor runs shrink the directory.
    for (let i = 0; i < 9000; i++) tiles.push([14, (i * 37) % 16384, Math.floor(i / 2), `t${i}`]);
    const { file } = await build(tiles, {});
    const archive = new PMTiles(memorySource(file));
    const header = await archive.getHeader();
    expect(header.leafDirectoryLength).toBeGreaterThan(0);
    expect(header.rootDirectoryOffset + header.rootDirectoryLength).toBeLessThanOrEqual(HEAD_BYTES);
    for (const i of [0, 1, 4500, 8999]) {
      expect(await readText(archive, 14, (i * 37) % 16384, Math.floor(i / 2))).toBe(`t${i}`);
    }

    // readArchive walks the leaves too.
    const contents = await readArchive(memorySource(file));
    expect(contents.entries.reduce((sum, entry) => sum + entry.runLength, 0)).toBe(9000);
  }, 30_000);

  it('lists every tile with its place in the file, and the metadata', async () => {
    const { file } = await build(
      [
        [0, 0, 0, 'world'],
        [14, 11521, 7400, 'sea'],
        [14, 11522, 7400, 'sea'],
      ],
      { name: 'Test' },
    );
    const { header, entries, metadata } = await readArchive(memorySource(file));
    expect(header.numAddressedTiles).toBe(3);
    expect(metadata).toEqual({ name: 'Test' });
    const texts: string[] = [];
    for (const entry of entries) {
      const bytes = file.slice(entry.offset, entry.offset + entry.length);
      const text = new TextDecoder().decode(await gunzip(bytes));
      for (let i = 0; i < entry.runLength; i++) texts.push(text);
    }
    expect(texts.sort()).toEqual(['sea', 'sea', 'world']);
  });

  it('rejects a file that is not PMTiles', async () => {
    await expect(readArchive(memorySource(new Uint8Array(HEAD_BYTES)))).rejects.toThrow('Not a PMTiles file');
  });
});

describe('readRanges', () => {
  it('reads neighbouring ranges together and hands each one over in file order', async () => {
    const bytes = Uint8Array.from({ length: 300 }, (_, i) => i % 256);
    const reads: Array<[number, number]> = [];
    const source: Source = {
      getKey: () => 'counted',
      getBytes: async (offset, length) => {
        reads.push([offset, length]);
        return { data: bytes.slice(offset, offset + length).buffer };
      },
    };
    const got: number[][] = [];
    await readRanges(
      source,
      [
        { offset: 200, length: 2 },
        { offset: 10, length: 3 },
        { offset: 13, length: 2 },
      ],
      (range, data) => {
        got.push([range.offset, ...data]);
      },
      100,
    );
    expect(got).toEqual([
      [10, 10, 11, 12],
      [13, 13, 14],
      [200, 200, 201],
    ]);
    // The gap is small enough to read through, but 10–202 is over the 100-byte chunk.
    expect(reads).toEqual([
      [10, 5],
      [200, 2],
    ]);
  });
});

