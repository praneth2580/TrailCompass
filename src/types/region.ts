/** Geographic bounding box: [west, south, east, north] in WGS84. */
export type BoundingBox = [west: number, south: number, east: number, north: number];

export type RegionDownloadState =
  | 'available'
  | 'queued'
  | 'downloading'
  | 'paused'
  | 'validating'
  | 'ready'
  | 'invalid'
  | 'error';

export interface RegionPackage {
  id: string;
  displayName: string;
  bounds: BoundingBox;
  format: 'pmtiles' | 'mbtiles' | 'unknown';
  schemaVersion: number;
  fileSizeBytes: number;
  checksum?: string;
  attribution: string;
  license: string;
  downloadState: RegionDownloadState;
  lastValidatedAt?: string;
  /** Path relative to app storage root, once downloaded. */
  localPath?: string;
  /** Optional companion routing-data package id. */
  routingPackageId?: string;
  errorMessage?: string;
}
