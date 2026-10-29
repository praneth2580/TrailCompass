import { Capacitor, registerPlugin } from '@capacitor/core';
import { Directory, Filesystem } from '@capacitor/filesystem';
import type { Source } from 'pmtiles';

/**
 * Binary files for offline maps: the tile store's PMTiles files and the
 * map's fonts and icons. On Android they live under the app's data folder
 * in `map-packages/` (next to storage-manager.ts's text files) and tiles
 * are read by byte range through MapFilesPlugin.java. In a browser they
 * are Blobs in IndexedDB.
 *
 * Files being shared are written to the cache folder (Android) or kept
 * as a Blob to download (browser).
 */

const ROOT = 'map-packages';
const SHARE_DIR = 'shared-maps';
/** Appends are batched so the bridge carries fewer, larger calls. */
const APPEND_BATCH_BYTES = 1024 * 1024;

type FolderName = 'DATA' | 'CACHE';

interface MapFilesPlugin {
  readRange(options: { path: string; directory: FolderName; offset: number; length: number }): Promise<{ data: string }>;
  writeAt(options: { path: string; directory: FolderName; offset: number; data: string }): Promise<void>;
}

const MapFiles = registerPlugin<MapFilesPlugin>('MapFiles');

export interface PackFileWriter {
  append(bytes: Uint8Array): Promise<void>;
  /** Overwrites bytes already written (e.g. a header at offset 0). */
  writeAt(offset: number, bytes: Uint8Array): Promise<void>;
  /** Resolves with the file size. */
  close(): Promise<number>;
  abort(): Promise<void>;
}

/** A file ready to hand to the share sheet (Android) or download (web). */
export type ShareableFile = { uri: string } | { blob: Blob };

export interface ShareFileWriter extends Omit<PackFileWriter, 'close'> {
  finish(): Promise<ShareableFile>;
}

export interface PackFiles {
  createWriter(path: string): PackFileWriter;
  /** A file named `fileName` to share; replaces an earlier one of that name. */
  createShareWriter(fileName: string): ShareFileWriter;
  /** For the `pmtiles` reader. */
  source(path: string): Source;
  readBytes(path: string): Promise<Uint8Array | null>;
  writeBytes(path: string, bytes: Uint8Array): Promise<void>;
  delete(path: string): Promise<void>;
  /** File names in folder `dir`; empty when it doesn't exist. */
  list(dir: string): Promise<string[]>;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

class NativePackFiles implements PackFiles {
  createWriter(path: string): PackFileWriter {
    return nativeWriter(`${ROOT}/${path}`, 'DATA');
  }

  createShareWriter(fileName: string): ShareFileWriter {
    const path = `${SHARE_DIR}/${fileName}`;
    const { close, ...writer } = nativeWriter(path, 'CACHE');
    return {
      ...writer,
      finish: async () => {
        await close();
        const { uri } = await Filesystem.getUri({ path, directory: Directory.Cache });
        return { uri };
      },
    };
  }

  source(path: string): Source {
    const full = `${ROOT}/${path}`;
    return {
      getKey: () => full,
      getBytes: async (offset, length) => {
        const { data } = await MapFiles.readRange({ path: full, directory: 'DATA', offset, length });
        return { data: base64ToBytes(data).buffer as ArrayBuffer };
      },
    };
  }

  async readBytes(path: string): Promise<Uint8Array | null> {
    try {
      const { data } = await Filesystem.readFile({ path: `${ROOT}/${path}`, directory: Directory.Data });
      return typeof data === 'string' ? base64ToBytes(data) : new Uint8Array(await data.arrayBuffer());
    } catch {
      return null;
    }
  }

  async writeBytes(path: string, bytes: Uint8Array): Promise<void> {
    await Filesystem.writeFile({
      path: `${ROOT}/${path}`,
      data: bytesToBase64(bytes),
      directory: Directory.Data,
      recursive: true,
    });
  }

  async delete(path: string): Promise<void> {
    await Filesystem.deleteFile({ path: `${ROOT}/${path}`, directory: Directory.Data }).catch(() => undefined);
  }

  async list(dir: string): Promise<string[]> {
    try {
      const { files } = await Filesystem.readdir({ path: `${ROOT}/${dir}`, directory: Directory.Data });
      return files.filter((file) => file.type === 'file').map((file) => file.name);
    } catch {
      return [];
    }
  }
}

/** Appends in batches; `folder` is the plugin's name for `path`'s directory. */
function nativeWriter(path: string, folder: FolderName): PackFileWriter {
  const directory = folder === 'DATA' ? Directory.Data : Directory.Cache;
  let pending: Uint8Array[] = [];
  let pendingBytes = 0;
  let size = 0;
  let started: Promise<void> | null = null;
  // writeFile replaces any earlier file of this name.
  const start = () =>
    (started ??= Filesystem.writeFile({ path, data: '', directory, recursive: true }).then(() => undefined));
  const flush = async () => {
    await start();
    if (pendingBytes === 0) return;
    const data = bytesToBase64(concat(pending, pendingBytes));
    pending = [];
    pendingBytes = 0;
    await Filesystem.appendFile({ path, data, directory });
  };
  return {
    append: async (bytes) => {
      pending.push(bytes);
      pendingBytes += bytes.length;
      size += bytes.length;
      if (pendingBytes >= APPEND_BATCH_BYTES) await flush();
    },
    writeAt: async (offset, bytes) => {
      await flush();
      await MapFiles.writeAt({ path, directory: folder, offset, data: bytesToBase64(bytes) });
    },
    close: async () => {
      await flush();
      return size;
    },
    abort: async () => {
      pending = [];
      await Filesystem.deleteFile({ path, directory }).catch(() => undefined);
    },
  };
}

const DB_NAME = 'trailcompass-map-files';
const STORE = 'files';

class WebPackFiles implements PackFiles {
  private db: Promise<IDBDatabase> | null = null;
  /** Blobs already read, so each tile read doesn't go back to IndexedDB. */
  private blobs = new Map<string, Promise<Blob | null>>();

  createWriter(path: string): PackFileWriter {
    const { writer, blob } = blobWriter();
    return {
      ...writer,
      close: async () => {
        await this.put(path, blob());
        return blob().size;
      },
    };
  }

  createShareWriter(): ShareFileWriter {
    const { writer, blob } = blobWriter();
    return {
      ...writer,
      finish: async () => ({ blob: new Blob([blob()], { type: 'application/octet-stream' }) }),
    };
  }

  source(path: string): Source {
    return {
      getKey: () => path,
      getBytes: async (offset, length) => {
        const blob = await this.getBlob(path);
        if (!blob) throw new Error('Offline map file is missing');
        return { data: await blob.slice(offset, offset + length).arrayBuffer() };
      },
    };
  }

  async readBytes(path: string): Promise<Uint8Array | null> {
    const blob = await this.getBlob(path);
    return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
  }

  async writeBytes(path: string, bytes: Uint8Array): Promise<void> {
    await this.put(path, new Blob([bytes as BlobPart]));
  }

  async delete(path: string): Promise<void> {
    this.blobs.delete(path);
    await this.request((store) => store.delete(path), 'readwrite').catch(() => undefined);
  }

  async list(dir: string): Promise<string[]> {
    const keys: IDBValidKey[] = await this.request<IDBValidKey[]>((store) => store.getAllKeys()).catch(() => []);
    const prefix = `${dir}/`;
    return keys
      .filter((key): key is string => typeof key === 'string' && key.startsWith(prefix))
      .map((key) => key.slice(prefix.length))
      .filter((name) => !name.includes('/'));
  }

  private getBlob(path: string): Promise<Blob | null> {
    let blob = this.blobs.get(path);
    if (!blob) {
      blob = this.request<Blob | undefined>((store) => store.get(path)).then(
        (value) => value ?? null,
        () => null,
      );
      this.blobs.set(path, blob);
    }
    return blob;
  }

  private async put(path: string, blob: Blob): Promise<void> {
    this.blobs.set(path, Promise.resolve(blob));
    await this.request((store) => store.put(blob, path), 'readwrite');
  }

  private open(): Promise<IDBDatabase> {
    this.db ??= new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return this.db;
  }

  private async request<T>(
    run: (store: IDBObjectStore) => IDBRequest,
    mode: IDBTransactionMode = 'readonly',
  ): Promise<T> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const request = run(db.transaction(STORE, mode).objectStore(STORE));
      request.onsuccess = () => resolve(request.result as T);
      request.onerror = () => reject(request.error);
    });
  }
}

/** A file built up in memory. */
function blobWriter(): { writer: Omit<PackFileWriter, 'close'>; blob: () => Blob } {
  let blob = new Blob([]);
  return {
    writer: {
      append: async (bytes) => {
        blob = new Blob([blob, bytes as BlobPart]);
      },
      writeAt: async (offset, bytes) => {
        blob = new Blob([blob.slice(0, offset), bytes as BlobPart, blob.slice(offset + bytes.length)]);
      },
      abort: async () => {
        blob = new Blob([]);
      },
    },
    blob: () => blob,
  };
}

function concat(parts: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export const packFiles: PackFiles = Capacitor.isNativePlatform()
  ? new NativePackFiles()
  : new WebPackFiles();
