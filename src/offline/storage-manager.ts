import { Directory, Encoding, Filesystem } from '@capacitor/filesystem';
import { Capacitor } from '@capacitor/core';

const MAP_ROOT = 'map-packages';

export interface StorageInfo {
  /** Estimated free bytes when available; null on web/unsupported. */
  freeBytes: number | null;
  rootUri: string;
  platform: string;
}

/**
 * Thin wrapper around Capacitor Filesystem for regional map packages.
 * Large binary downloads and range-request serving are not implemented yet.
 */
export class StorageManager {
  async ensureMapRoot(): Promise<string> {
    if (!Capacitor.isNativePlatform()) {
      return `web://${MAP_ROOT}`;
    }

    try {
      await Filesystem.mkdir({
        path: MAP_ROOT,
        directory: Directory.Data,
        recursive: true,
      });
    } catch {
      // Directory may already exist.
    }

    const { uri } = await Filesystem.getUri({
      path: MAP_ROOT,
      directory: Directory.Data,
    });
    return uri;
  }

  async getStorageInfo(): Promise<StorageInfo> {
    const rootUri = await this.ensureMapRoot();
    return {
      freeBytes: null,
      rootUri,
      platform: Capacitor.getPlatform(),
    };
  }

  async writeTextFile(relativePath: string, data: string): Promise<string> {
    if (!Capacitor.isNativePlatform()) {
      const key = `trailcompass:file:${relativePath}`;
      localStorage.setItem(key, data);
      return key;
    }

    const path = `${MAP_ROOT}/${relativePath}`;
    await Filesystem.writeFile({
      path,
      data,
      directory: Directory.Data,
      encoding: Encoding.UTF8,
      // Without this, writes into a missing subfolder (road-packs/) fail.
      recursive: true,
    });
    const { uri } = await Filesystem.getUri({
      path,
      directory: Directory.Data,
    });
    return uri;
  }

  async readTextFile(relativePath: string): Promise<string | null> {
    if (!Capacitor.isNativePlatform()) {
      return localStorage.getItem(`trailcompass:file:${relativePath}`);
    }

    try {
      const result = await Filesystem.readFile({
        path: `${MAP_ROOT}/${relativePath}`,
        directory: Directory.Data,
        encoding: Encoding.UTF8,
      });
      return typeof result.data === 'string' ? result.data : null;
    } catch {
      return null;
    }
  }

  async deleteFile(relativePath: string): Promise<void> {
    if (!Capacitor.isNativePlatform()) {
      localStorage.removeItem(`trailcompass:file:${relativePath}`);
      return;
    }

    try {
      await Filesystem.deleteFile({
        path: `${MAP_ROOT}/${relativePath}`,
        directory: Directory.Data,
      });
    } catch {
      // Ignore missing files.
    }
  }
}

export const storageManager = new StorageManager();
