import { Capacitor } from '@capacitor/core';
import { Geolocation } from '@capacitor/geolocation';
import type { GpsFix } from '../types/navigation';

export type LocationListener = (fix: GpsFix | null, error?: string) => void;

const STALE_MS = 15_000;

export function isFixStale(fix: GpsFix, now = Date.now()): boolean {
  return now - fix.timestampMs > STALE_MS;
}

export function formatAccuracy(fix: GpsFix | null): string {
  if (!fix) return 'No fix';
  if (fix.accuracyMeters == null) return 'Accuracy unknown';
  return `±${Math.round(fix.accuracyMeters)} m`;
}

/** Short label for the ride HUD chip (errors can be verbose from the browser). */
export function formatGpsChipLabel(
  fix: GpsFix | null,
  error?: string,
  options?: { stale?: boolean },
): string {
  if (fix) {
    const accuracy = formatAccuracy(fix);
    return options?.stale ? `${accuracy} · stale` : accuracy;
  }
  if (!error) return 'Acquiring…';
  const lower = error.toLowerCase();
  if (lower.includes('denied') || lower.includes('permission')) {
    return 'Permission denied';
  }
  if (lower.includes('unavailable') || lower.includes('disabled')) {
    return 'Unavailable';
  }
  if (lower.includes('timeout')) return 'Timed out';
  if (lower.includes('secure') || lower.includes('only secure')) {
    return 'Needs HTTPS';
  }
  return 'No fix';
}

/**
 * GPS / location service using Capacitor Geolocation.
 * Handles permission denial gracefully.
 */
export class LocationService {
  private watchId: string | null = null;
  private listeners = new Set<LocationListener>();
  private lastFix: GpsFix | null = null;
  private permissionDenied = false;

  getLastFix(): GpsFix | null {
    return this.lastFix;
  }

  wasPermissionDenied(): boolean {
    return this.permissionDenied;
  }

  subscribe(listener: LocationListener): () => void {
    this.listeners.add(listener);
    if (this.lastFix) listener(this.lastFix);
    return () => this.listeners.delete(listener);
  }

  async startWatching(): Promise<void> {
    if (this.watchId) return;

    try {
      const permission = await Geolocation.checkPermissions();
      let status = permission.location;
      if (status !== 'granted') {
        const requested = await Geolocation.requestPermissions();
        status = requested.location;
      }

      if (status !== 'granted') {
        this.permissionDenied = true;
        this.emit(null, 'Location permission denied');
        return;
      }

      this.permissionDenied = false;
      this.watchId = await Geolocation.watchPosition(
        {
          enableHighAccuracy: true,
          timeout: 20_000,
          maximumAge: 5_000,
        },
        (position, err) => {
          if (err || !position) {
            this.emit(this.lastFix, err?.message ?? 'Location error');
            return;
          }
          const fix: GpsFix = {
            latitude: position.coords.latitude,
            longitude: position.coords.longitude,
            accuracyMeters: position.coords.accuracy ?? null,
            altitudeMeters: position.coords.altitude ?? null,
            speedMps: position.coords.speed ?? null,
            headingDegrees: position.coords.heading ?? null,
            timestampMs: position.timestamp,
          };
          this.lastFix = fix;
          this.emit(fix);
        },
      );
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Location unavailable';
      // Browser fallback for web prototype when Capacitor plugin is limited.
      if (!Capacitor.isNativePlatform() && 'geolocation' in navigator) {
        this.startBrowserWatch();
        return;
      }
      this.emit(null, message);
    }
  }

  async stopWatching(): Promise<void> {
    if (this.watchId) {
      await Geolocation.clearWatch({ id: this.watchId });
      this.watchId = null;
    }
    if (this.browserWatchId != null) {
      navigator.geolocation.clearWatch(this.browserWatchId);
      this.browserWatchId = null;
    }
  }

  private browserWatchId: number | null = null;

  private startBrowserWatch(): void {
    if (this.browserWatchId != null) return;
    this.browserWatchId = navigator.geolocation.watchPosition(
      (position) => {
        const fix: GpsFix = {
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          accuracyMeters: position.coords.accuracy ?? null,
          altitudeMeters: position.coords.altitude ?? null,
          speedMps: position.coords.speed ?? null,
          headingDegrees: position.coords.heading ?? null,
          timestampMs: position.timestamp,
        };
        this.lastFix = fix;
        this.permissionDenied = false;
        this.emit(fix);
      },
      (err) => {
        this.permissionDenied = err.code === err.PERMISSION_DENIED;
        this.emit(null, err.message);
      },
      { enableHighAccuracy: true, maximumAge: 5_000, timeout: 20_000 },
    );
  }

  private emit(fix: GpsFix | null, error?: string): void {
    for (const listener of this.listeners) {
      listener(fix, error);
    }
  }
}

export const locationService = new LocationService();
