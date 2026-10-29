import { Capacitor } from '@capacitor/core';
import { abortError } from '../routing/abort';
import { Downloads, type NetworkType } from './downloads-plugin';

/** Which networks large downloads may use. */
export type DownloadNetworks = 'wifi' | 'any';

const PREFS_KEY = 'tc.downloadNetworks';

/**
 * The "Wi-Fi only" download setting. On mobile data with it on, road
 * downloads for route planning and offline maps wait for Wi-Fi, and fuel
 * and food data and app updates hold off. Rerouting during a ride, map
 * tiles for the screen and searches always use whatever network is up.
 */
export class DownloadPolicyService {
  private setting: DownloadNetworks = readSetting();
  private network: NetworkType = 'unknown';
  private riding = false;
  private waiting = 0;
  private listeners = new Set<() => void>();
  private watching: Promise<void> | null = null;

  /** Follow the phone's network type (the Android app only). */
  start(): Promise<void> {
    this.watching ??= this.watch();
    return this.watching;
  }

  private async watch(): Promise<void> {
    if (!Capacitor.isNativePlatform()) return;
    try {
      await Downloads.addListener('network', ({ type }) => this.setNetwork(type));
      this.setNetwork((await Downloads.getNetwork()).type);
    } catch {
      // Unknown network: downloads are allowed.
    }
  }

  getSetting(): DownloadNetworks {
    return this.setting;
  }

  setSetting(setting: DownloadNetworks): void {
    if (setting === this.setting) return;
    this.setting = setting;
    try {
      localStorage.setItem(PREFS_KEY, setting);
    } catch {
      // Kept for this session.
    }
    this.emit();
  }

  getNetwork(): NetworkType {
    return this.network;
  }

  setNetwork(network: NetworkType): void {
    if (network === this.network) return;
    this.network = network;
    this.emit();
  }

  /** False only on mobile data with the Wi-Fi only setting. */
  canDownload(): boolean {
    return this.setting === 'any' || this.network !== 'cellular';
  }

  /** Whether a road download is waiting for Wi-Fi right now. */
  isWaiting(): boolean {
    return this.waiting > 0;
  }

  /** A rerouting rider can't wait for Wi-Fi, so rides ignore the setting. */
  setRiding(riding: boolean): void {
    if (riding === this.riding) return;
    this.riding = riding;
    this.emit();
  }

  /**
   * Resolves once road data may download: straight away, or when Wi-Fi
   * connects or the setting changes. Rejects if `signal` aborts first.
   */
  async waitForRoads(signal?: AbortSignal): Promise<void> {
    await this.watching;
    if (signal?.aborted) throw abortError();
    if (this.riding || this.canDownload()) return;

    this.waiting += 1;
    this.emit();
    try {
      await new Promise<void>((resolve, reject) => {
        const unsubscribe = this.subscribe(() => {
          if (!this.riding && !this.canDownload()) return;
          stop();
          resolve();
        });
        const onAbort = () => {
          stop();
          reject(abortError());
        };
        const stop = () => {
          unsubscribe();
          signal?.removeEventListener('abort', onAbort);
        };
        signal?.addEventListener('abort', onAbort, { once: true });
      });
    } finally {
      this.waiting -= 1;
      this.emit();
    }
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const listener of [...this.listeners]) listener();
  }
}

function readSetting(): DownloadNetworks {
  try {
    return localStorage.getItem(PREFS_KEY) === 'wifi' ? 'wifi' : 'any';
  } catch {
    return 'any';
  }
}

export const downloadPolicy = new DownloadPolicyService();
