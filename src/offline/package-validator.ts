import type { RegionPackage } from '../types/region';

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  checkedAt: string;
}

/**
 * Validates region package metadata. Binary checksum verification
 * against downloaded tile files will be added with the offline bridge.
 */
export function validateRegionPackage(pkg: RegionPackage): ValidationResult {
  const errors: string[] = [];
  const checkedAt = new Date().toISOString();

  if (!pkg.id.trim()) errors.push('Missing region id');
  if (!pkg.displayName.trim()) errors.push('Missing display name');
  if (pkg.bounds.length !== 4) errors.push('Bounds must be [west, south, east, north]');
  if (pkg.fileSizeBytes < 0) errors.push('Invalid file size');
  if (!pkg.attribution.trim()) errors.push('Missing attribution');
  if (!pkg.license.trim()) errors.push('Missing license');
  if (pkg.schemaVersion < 1) errors.push('Unsupported schema version');

  const [west, south, east, north] = pkg.bounds;
  if (
    west == null ||
    south == null ||
    east == null ||
    north == null ||
    west >= east ||
    south >= north
  ) {
    errors.push('Invalid geographic bounds');
  }

  return {
    valid: errors.length === 0,
    errors,
    checkedAt,
  };
}
