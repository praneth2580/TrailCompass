import { Capacitor, type PluginListenerHandle } from '@capacitor/core';
import { Geolocation } from '@capacitor/geolocation';
import type { GpsFix } from '../types/navigation';
import {
  RideLocation,
  type LocationSource,
  type LocationStatus,
  type NativeFix,
} from './ride-location-plugin';

export type { LocationSource, LocationStatus };

export type LocationListener = (fix: GpsFix | null, error?: string) => void;

const STALE_MS = 15_000;
const SOURCE_KEY = 'tc.locationSource';

/** The GPS modes offered in settings. */
export const LOCATION_SOURCES: Array<{ id: LocationSource; label: string; detail: string }> = [
  {
    id: 'gps',
    label: 'Satellites only',
    detail:
      'Works anywhere, with no mobile data or Google services. Very precise in the open; the first fix after a long break can take a minute.',
  },
  {
    id: 'assisted',
    label: 'Satellites + mobile data & Wi-Fi',
    detail:
      'Finds you fastest and is the most precise in towns, between buildings and out of tunnels. Uses a little data.',
  },
  {
    id: 'saver',
    label: 'Battery saver',
    detail: 'Approximate (about 100 m), from mobile towers and Wi-Fi. Needs data. Not precise enough to navigate.',
  },
];

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
 * The phone's position, from the GPS mode picked in settings. On Android
 * it comes from RideLocationPlugin (android/…/LocationHub.java), which can
 * use the satellites alone; in a browser, the browser picks the source
 * (Battery saver asks it for less accuracy). Permission is asked through
 * @capacitor/geolocation. Handles permission denial gracefully.
 */
export class LocationService {
  private watchId: string | null = null;
  private nativeWatch: PluginListenerHandle | null = null;
  private listeners = new Set<LocationListener>();
  private sourceListeners = new Set<() => void>();
  private lastFix: GpsFix | null = null;
  private permissionDenied = false;
  private source: LocationSource = readSource();

  getSource(): LocationSource {
    return this.source;
  }

  /** Switches the GPS mode; remembered, and applied at once. */
  setSource(source: LocationSource): void {
    if (source === this.source) return;
    this.source = source;
    try {
      localStorage.setItem(SOURCE_KEY, source);
    } catch {
      // Kept for this session.
    }
    for (const listener of [...this.sourceListeners]) listener();
    if (this.nativeWatch) {
      void RideLocation.setSource({ source }).catch(() => undefined);
    } else if (this.watchId || this.browserWatchId != null) {
      void this.stopWatching().then(() => this.startWatching());
    }
  }

  subscribeSource(listener: () => void): () => void {
    this.sourceListeners.add(listener);
    return () => this.sourceListeners.delete(listener);
  }

  /** Whether the phone's GPS and network location are on, and satellites in use. Null in a browser. */
  async status(): Promise<LocationStatus | null> {
    if (!Capacitor.isNativePlatform()) return null;
    return RideLocation.status().catch(() => null);
  }

  /** Android's location settings, to switch the GPS on. */
  async openLocationSettings(): Promise<void> {
    await RideLocation.openLocationSettings();
  }

  getLastFix(): GpsFix | null {
    return this.lastFix;
  }

  wasPermissionDenied(): boolean {
    return this.permissionDenied;
  }

  /**
   * Ensure watching is on and return a fix (fresh or recent).
   * Rejects if permission denied or timeout with no fix.
   */
  async ensureFix(timeoutMs = 8_000): Promise<GpsFix> {
    await this.startWatching();
    if (this.lastFix && !isFixStale(this.lastFix)) {
      return this.lastFix;
    }
    if (this.lastFix && Date.now() - this.lastFix.timestampMs < 60_000) {
      return this.lastFix;
    }

    return new Promise<GpsFix>((resolve, reject) => {
      // subscribe() replays the old fix synchronously, before it returns.
      let unsub: () => void = () => {};
      const timer = window.setTimeout(() => {
        unsub();
        if (this.lastFix) {
          resolve(this.lastFix);
          return;
        }
        reject(
          new Error(
            this.permissionDenied
              ? 'Location permission denied — enable GPS to preview from Plan'
              : 'Waiting for GPS — open Map briefly or enable location, then try again',
          ),
        );
      }, timeoutMs);

      unsub = this.subscribe((fix, error) => {
        if (fix && !isFixStale(fix)) {
          window.clearTimeout(timer);
          unsub();
          resolve(fix);
          return;
        }
        if (error && this.permissionDenied) {
          window.clearTimeout(timer);
          unsub();
          reject(new Error(error));
        }
      });
    });
  }

  subscribe(listener: LocationListener): () => void {
    this.listeners.add(listener);
    if (this.lastFix) listener(this.lastFix);
    return () => this.listeners.delete(listener);
  }

  /** Starts once, however many callers ask at the same time. */
  startWatching(): Promise<void> {
    this.starting ??= this.start().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private starting: Promise<void> | null = null;

  private async start(): Promise<void> {
    if (this.watchId || this.nativeWatch) return;

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
      if (Capacitor.isNativePlatform()) {
        const handle = await RideLocation.addListener('fix', (fix) => this.accept(fromNative(fix)));
        try {
          await RideLocation.watch({ source: this.source });
        } catch (e) {
          await handle.remove();
          throw e;
        }
        this.nativeWatch = handle;
        return;
      }
      this.watchId = await Geolocation.watchPosition(
        {
          enableHighAccuracy: this.source !== 'saver',
          timeout: 20_000,
          maximumAge: 5_000,
        },
        (position, err) => {
          if (err || !position) {
            this.emit(this.lastFix, err?.message ?? 'Location error');
            return;
          }
          this.accept({
            latitude: position.coords.latitude,
            longitude: position.coords.longitude,
            accuracyMeters: position.coords.accuracy ?? null,
            altitudeMeters: position.coords.altitude ?? null,
            speedMps: position.coords.speed ?? null,
            headingDegrees: position.coords.heading ?? null,
            timestampMs: position.timestamp,
          });
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
    if (this.nativeWatch) {
      const handle = this.nativeWatch;
      this.nativeWatch = null;
      await handle.remove();
      await RideLocation.clearWatch().catch(() => undefined);
    }
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
      { enableHighAccuracy: this.source !== 'saver', maximumAge: 5_000, timeout: 20_000 },
    );
  }

  private accept(fix: GpsFix): void {
    this.lastFix = fix;
    this.emit(fix);
  }

  private emit(fix: GpsFix | null, error?: string): void {
    for (const listener of this.listeners) {
      listener(fix, error);
    }
  }
}

function fromNative(fix: NativeFix): GpsFix {
  return {
    latitude: fix.latitude,
    longitude: fix.longitude,
    accuracyMeters: fix.accuracy ?? null,
    altitudeMeters: fix.altitude ?? null,
    speedMps: fix.speed ?? null,
    headingDegrees: fix.bearing ?? null,
    timestampMs: fix.time,
    satellites: fix.satellites,
  };
}

function readSource(): LocationSource {
  try {
    const saved = localStorage.getItem(SOURCE_KEY);
    if (saved === 'gps' || saved === 'assisted' || saved === 'saver') return saved;
  } catch {
    // Default below.
  }
  return 'assisted';
}

export const locationService = new LocationService();
