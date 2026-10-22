import type { RegionPackage } from '../types/region';
import { validateRegionPackage } from './package-validator';
import { storageManager } from './storage-manager';

export type DownloadProgressListener = (progress: {
  regionId: string;
  bytesReceived: number;
  bytesTotal: number;
  percent: number;
}) => void;

/**
 * Manages regional map package metadata and download lifecycle.
 * Actual resumable downloads are not implemented — methods are working stubs
 * with real interfaces for Milestone 5 wiring.
 */
export class RegionManager {
  private regions = new Map<string, RegionPackage>();
  private listeners = new Set<DownloadProgressListener>();
  private cancelled = new Set<string>();

  async listRegions(): Promise<RegionPackage[]> {
    await this.hydrateFromDisk();
    return [...this.regions.values()];
  }

  async getRegion(id: string): Promise<RegionPackage | undefined> {
    await this.hydrateFromDisk();
    return this.regions.get(id);
  }

  async upsertRegion(pkg: RegionPackage): Promise<RegionPackage> {
    const validation = validateRegionPackage(pkg);
    if (!validation.valid) {
      throw new Error(`Invalid region package: ${validation.errors.join('; ')}`);
    }
    this.regions.set(pkg.id, pkg);
    await this.persist();
    return pkg;
  }

  /**
   * Placeholder download: marks state transitions without fetching tiles.
   * Does not bulk-download from public OSM tile servers.
   */
  async startDownload(regionId: string): Promise<RegionPackage> {
    const region = await this.requireRegion(regionId);
    this.cancelled.delete(regionId);

    const downloading: RegionPackage = {
      ...region,
      downloadState: 'downloading',
      errorMessage: undefined,
    };
    this.regions.set(regionId, downloading);
    this.emitProgress(regionId, 0, region.fileSizeBytes || 1);

    // Simulate a blocked download path until a lawful package source exists.
    const updated: RegionPackage = {
      ...downloading,
      downloadState: 'error',
      errorMessage:
        'Download not implemented — provide a lawful regional package source. ' +
        'Public OSM tile bulk download is not used.',
    };
    this.regions.set(regionId, updated);
    await this.persist();
    return updated;
  }

  async pauseDownload(regionId: string): Promise<RegionPackage> {
    const region = await this.requireRegion(regionId);
    const updated: RegionPackage = { ...region, downloadState: 'paused' };
    this.regions.set(regionId, updated);
    await this.persist();
    return updated;
  }

  async cancelDownload(regionId: string): Promise<void> {
    this.cancelled.add(regionId);
    const region = this.regions.get(regionId);
    if (region) {
      this.regions.set(regionId, {
        ...region,
        downloadState: 'available',
        errorMessage: 'Download cancelled',
      });
      await this.persist();
    }
  }

  async deleteRegion(regionId: string): Promise<void> {
    const region = this.regions.get(regionId);
    if (region?.localPath) {
      await storageManager.deleteFile(region.localPath);
    }
    this.regions.delete(regionId);
    await this.persist();
  }

  onProgress(listener: DownloadProgressListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emitProgress(
    regionId: string,
    bytesReceived: number,
    bytesTotal: number,
  ): void {
    const percent =
      bytesTotal > 0 ? Math.min(100, (bytesReceived / bytesTotal) * 100) : 0;
    for (const listener of this.listeners) {
      listener({ regionId, bytesReceived, bytesTotal, percent });
    }
  }

  private async requireRegion(id: string): Promise<RegionPackage> {
    const region = await this.getRegion(id);
    if (!region) throw new Error(`Unknown region: ${id}`);
    return region;
  }

  private async hydrateFromDisk(): Promise<void> {
    if (this.regions.size > 0) return;
    const raw = await storageManager.readTextFile('regions.json');
    if (!raw) return;
    try {
      const list = JSON.parse(raw) as RegionPackage[];
      for (const pkg of list) {
        this.regions.set(pkg.id, pkg);
      }
    } catch {
      // Corrupt catalog — start empty.
    }
  }

  private async persist(): Promise<void> {
    const list = [...this.regions.values()];
    await storageManager.writeTextFile('regions.json', JSON.stringify(list, null, 2));
  }
}

export const regionManager = new RegionManager();
