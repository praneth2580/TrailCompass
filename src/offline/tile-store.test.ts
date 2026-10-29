import { describe, expect, it } from 'vitest';
import { zxyToTileId, type Source } from 'pmtiles';
import type { PackFiles, PackFileWriter, ShareFileWriter } from './pack-files';
import { gzip } from './pmtiles-writer';
import {
  decodeTileIds,
  encodeTileIds,
  groupTileTimes,
  readTileTimes,
  TileStore,
  type TileTime,
} from './tile-store';

/** PackFiles in memory; a file appears when its writer closes. */
class MemoryFiles implements PackFiles {
  files = new Map<string, Uint8Array>();

  createWriter(path: string): PackFileWriter {
    let data = new Uint8Array(0);
    return {
      append: async (bytes) => {
        const next = new Uint8Array(data.length + bytes.length);
        next.set(data);
        next.set(bytes, data.length);
        data = next;
      },
      writeAt: async (offset, bytes) => {
        data.set(bytes, offset);
      },
      close: async () => {
        this.files.set(path, data);
        return data.length;
      },
      abort: async () => {
        this.files.delete(path);
      },
    };
  }

  createShareWriter(): ShareFileWriter {
    throw new Error('Not used here');
  }

  source(path: string): Source {
    return {
      getKey: () => path,
      getBytes: async (offset, length) => {
        const file = this.files.get(path);
        if (!file) throw new Error(`Missing ${path}`);
        return { data: file.slice(offset, offset + length).buffer };
      },
    };
  }

  async readBytes(path: string): Promise<Uint8Array | null> {
    return this.files.get(path) ?? null;
  }

  async writeBytes(path: string, bytes: Uint8Array): Promise<void> {
    this.files.set(path, bytes);
  }

  async delete(path: string): Promise<void> {
    this.files.delete(path);
  }

  async list(dir: string): Promise<string[]> {
    return [...this.files.keys()].filter((key) => key.startsWith(`${dir}/`)).map((key) => key.slice(dir.length + 1));
  }

  tileFiles(): string[] {
    return [...this.files.keys()].filter((key) => key.startsWith('tiles/'));
  }
}

const A = zxyToTileId(14, 11520, 7400);
const B = zxyToTileId(14, 11521, 7400);
const C = zxyToTileId(13, 5760, 3700);

function at(ms: number): TileTime {
  return { at: ms, planet: `build-${ms}` };
}

async function tile(text: string): Promise<Uint8Array> {
  return gzip(new TextEncoder().encode(text));
}

/** Incompressible, so file sizes are predictable. */
async function noise(bytes: number): Promise<Uint8Array> {
  const out = new Uint8Array(bytes);
  for (let i = 0; i < bytes; i += 65_536) crypto.getRandomValues(out.subarray(i, Math.min(bytes, i + 65_536)));
  return gzip(out);
}

async function text(store: TileStore, tileId: number): Promise<string | null> {
  const data = await store.readTile(tileId);
  return data ? new TextDecoder().decode(data) : null;
}

async function write(store: TileStore, tiles: Array<[number, Uint8Array, TileTime]>): Promise<void> {
  const writer = store.writer();
  for (const [tileId, data, time] of tiles) await writer.add(tileId, data, time);
  await writer.finish();
}

describe('TileStore', () => {
  it('keeps the newest download of each tile, also after a restart', async () => {
    const files = new MemoryFiles();
    const store = new TileStore(files);
    await store.init();

    await write(store, [
      [A, await tile('A from Monday'), at(1_000)],
      [B, await tile('B from Monday'), at(1_000)],
    ]);
    await write(store, [[A, await tile('A from Friday'), at(5_000)]]);
    // An older copy (say, from a shared file) doesn't replace it.
    await write(store, [[A, await tile('A from last year'), at(10)]]);

    expect(store.tileCount).toBe(2);
    expect(await text(store, A)).toBe('A from Friday');
    expect(store.get(A)).toMatchObject({ at: 5_000, planet: 'build-5000' });
    expect(await text(store, B)).toBe('B from Monday');
    expect(await text(store, C)).toBeNull();

    const reopened = new TileStore(files);
    await reopened.init();
    expect(await text(reopened, A)).toBe('A from Friday');
    expect(reopened.get(B)).toMatchObject({ at: 1_000, planet: 'build-1000' });
  });

  it('counts a tile stored for several ids once', async () => {
    const store = new TileStore(new MemoryFiles());
    await store.init();
    const sea = await tile('open sea');
    await write(store, [
      [A, sea, at(1)],
      [B, sea, at(1)],
    ]);
    expect(store.bytesOf([A, B])).toBe(sea.length);
  });

  it('starts a new file every 500 tiles, so a closed app keeps what arrived', async () => {
    const files = new MemoryFiles();
    const store = new TileStore(files);
    await store.init();
    const writer = store.writer();
    for (let i = 0; i < 501; i++) await writer.add(zxyToTileId(14, i, 0), await tile(`t${i}`), at(1));
    // The first 500 are served before finish.
    expect(store.tileCount).toBe(500);
    await writer.finish();
    expect(store.tileCount).toBe(501);
    expect(files.tileFiles()).toHaveLength(2);
  }, 30_000);

  it('deletes unused files and rewrites mostly-garbage ones, keeping download times', async () => {
    const files = new MemoryFiles();
    const store = new TileStore(files);
    await store.init();
    const ids = [0, 1, 2, 3, 4].map((i) => zxyToTileId(14, i, 0));
    await write(
      store,
      await Promise.all(ids.map(async (id) => [id, await noise(300_000), at(1)] as [number, Uint8Array, TileTime])),
    );
    // Newer copies of four of the five leave the first file 80% garbage.
    await write(store, await Promise.all(ids.slice(1).map(async (id) => [id, await tile('newer'), at(2)] as [number, Uint8Array, TileTime])));
    const before = store.diskBytes();
    expect(files.tileFiles()).toHaveLength(2);

    const freed = await store.collect(new Set(ids));
    expect(freed).toBeGreaterThan(1_100_000);
    expect(store.diskBytes()).toBe(before - freed);
    expect(files.tileFiles()).toHaveLength(2);
    expect(store.get(ids[0]!)).toMatchObject({ at: 1 });
    expect((await store.readTile(ids[0]!))?.byteLength).toBe(300_000);
    expect(await text(store, ids[4]!)).toBe('newer');

    // No map needs any of them: every file goes.
    await store.collect(new Set());
    expect(store.tileCount).toBe(0);
    expect(files.tileFiles()).toHaveLength(0);
    expect(store.diskBytes()).toBe(0);
  }, 30_000);

  it('drops a file the app closed before it was finished', async () => {
    const files = new MemoryFiles();
    files.files.set('tiles/1-cut.pmtiles', new Uint8Array(20_000));
    const store = new TileStore(files);
    await store.init();
    expect(store.tileCount).toBe(0);
    expect(files.tileFiles()).toHaveLength(0);
  });
});

describe('tile lists and download times', () => {
  it('encodes tile ids compactly, sorted and without repeats', () => {
    const ids = [C, A, B, A, 0, 5];
    const encoded = encodeTileIds(ids);
    expect(decodeTileIds(encoded)).toEqual([0, 5, C, A, B].sort((a, b) => a - b));
    expect(decodeTileIds(encodeTileIds([]))).toEqual([]);
  });

  it('round-trips grouped download times and ignores damaged groups', () => {
    const times = new Map<number, TileTime>([
      [A, at(1)],
      [B, at(1)],
      [C, at(2)],
    ]);
    const groups = groupTileTimes(times);
    expect(groups).toHaveLength(2);
    expect(readTileTimes(groups)).toEqual(times);
    expect(readTileTimes([...groups, { at: 'soon', tiles: 7 }, null]).size).toBe(3);
    expect(readTileTimes('nonsense').size).toBe(0);
  });
});
