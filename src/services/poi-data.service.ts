import { Capacitor } from '@capacitor/core';
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem';
import type { PoiKind } from '../types/trip-stop';

/**
 * Where the fuel and food places come from, and keeping them fresh without
 * a new APK. The app ships a copy (public/assets/poi). A weekly GitHub
 * workflow (.github/workflows/pages.yml) publishes newer Overture
 * releases on GitHub Pages; the app downloads them into its data folder
 * and uses whichever copy is newer.
 */
export const POI_UPDATE_URL: string =
  import.meta.env.VITE_POI_DATA_URL ??
  'https://praneth2580.github.io/TrailCompass/poi';
export const BUNDLED_POI_BASE = 'assets/poi';
/** Downloaded releases live in the app's data folder: poi-data/<release>/… */
const DATA_DIR = 'poi-data';
const PREFS_RELEASE = 'tc.poiDataRelease';
const PREFS_CHECKED_AT = 'tc.poiDataCheckedAt';
const CHECK_EVERY_MS = 24 * 60 * 60 * 1000;
const DOWNLOAD_CONCURRENCY = 4;
const KINDS: PoiKind[] = ['fuel', 'food'];
/** These names come from the network and become file paths: allow only these shapes. */
const RELEASE_PATTERN = /^\d{4}-\d{2}-\d{2}\.\d+$/;
const TILE_PATTERN = /^-?\d{1,3}_-?\d{1,2}$/;
const MAX_TILES = 5_000;

export interface PoiManifest {
  version: number;
  source: string;
  release?: string;
  countries?: string[];
  generated?: string;
  tileDegrees: number;
  kinds: Partial<Record<PoiKind, { count: number; tiles: string[] }>>;
}

export interface PoiDataLocation {
  /** Prefix for manifest.json and <kind>/<tile>.json. */
  base: string;
  release: string | null;
  downloaded: boolean;
}

export type PoiUpdateStatus =
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'downloading'; release: string; done: number; total: number }
  | { state: 'done'; message: string }
  | { state: 'error'; message: string };

class HttpStatusError extends Error {
  status: number;

  constructor(status: number, url: string) {
    super(`HTTP ${status} for ${url}`);
    this.status = status;
  }
}

let location: Promise<PoiDataLocation> | null = null;
let running: Promise<void> | null = null;
let status: PoiUpdateStatus = { state: 'idle' };
const statusListeners = new Set<(status: PoiUpdateStatus) => void>();
const changeListeners = new Set<() => void>();

/** The newest places data on the device: a downloaded release or the bundled copy. */
export function currentPoiData(): Promise<PoiDataLocation> {
  location ??= resolveLocation().catch(() => ({
    base: BUNDLED_POI_BASE,
    release: null,
    downloaded: false,
  }));
  return location;
}

async function resolveLocation(): Promise<PoiDataLocation> {
  // Downloads only happen in the app; the web build uses the bundled copy.
  if (!Capacitor.isNativePlatform()) {
    return { base: BUNDLED_POI_BASE, release: null, downloaded: false };
  }
  const bundled = await fetchJson<PoiManifest>(`${BUNDLED_POI_BASE}/manifest.json`).then(
    (manifest) => manifest.release ?? null,
    () => null,
  );
  const downloaded = readPref(PREFS_RELEASE);
  if (
    downloaded &&
    RELEASE_PATTERN.test(downloaded) &&
    compareReleases(downloaded, bundled) > 0
  ) {
    const { uri } = await Filesystem.getUri({
      path: `${DATA_DIR}/${downloaded}`,
      directory: Directory.Data,
    });
    return { base: Capacitor.convertFileSrc(uri), release: downloaded, downloaded: true };
  }
  return { base: BUNDLED_POI_BASE, release: bundled, downloaded: false };
}

/** Called after a newer release is installed, so caches can be dropped. */
export function onPoiDataChanged(listener: () => void): () => void {
  changeListeners.add(listener);
  return () => changeListeners.delete(listener);
}

export function subscribePoiUpdates(
  listener: (status: PoiUpdateStatus) => void,
): () => void {
  statusListeners.add(listener);
  listener(status);
  return () => statusListeners.delete(listener);
}

/** When the app last asked GitHub for newer data, if ever. */
export function lastPoiCheckAt(): number | null {
  const at = Number(readPref(PREFS_CHECKED_AT));
  return Number.isFinite(at) && at > 0 ? at : null;
}

/**
 * Download a newer published release, if there is one. Without `force`,
 * asks at most once a day. A failed or interrupted download leaves the
 * current data in place and resumes on the next check.
 */
export function checkForPoiUpdate(options: { force?: boolean } = {}): Promise<void> {
  running ??= runCheck(options.force === true).finally(() => {
    running = null;
  });
  return running;
}

async function runCheck(force: boolean): Promise<void> {
  if (!Capacitor.isNativePlatform()) {
    if (force) setStatus({ state: 'error', message: 'Updates download in the Android app' });
    return;
  }
  if (!force && Date.now() - (lastPoiCheckAt() ?? 0) < CHECK_EVERY_MS) return;

  setStatus({ state: 'checking' });
  try {
    const current = await currentPoiData();
    let remote: PoiManifest & { release: string };
    try {
      remote = parsePoiManifest(
        await fetchJson(`${POI_UPDATE_URL}/manifest.json`, { cache: 'no-cache' }),
      );
    } catch (e) {
      // Nothing has been published yet.
      if (e instanceof HttpStatusError && e.status === 404) {
        writePref(PREFS_CHECKED_AT, String(Date.now()));
        setStatus({ state: 'done', message: 'No published update yet' });
        return;
      }
      throw e;
    }

    if (compareReleases(remote.release, current.release) <= 0) {
      writePref(PREFS_CHECKED_AT, String(Date.now()));
      // A newer APK can bundle newer data than an earlier download.
      await removeReleases(
        (release) =>
          release !== current.release && compareReleases(release, current.release) <= 0,
      );
      setStatus({
        state: 'done',
        message: `Up to date · Overture ${current.release ?? remote.release}`,
      });
      return;
    }

    await downloadRelease(remote);
    writePref(PREFS_RELEASE, remote.release);
    writePref(PREFS_CHECKED_AT, String(Date.now()));
    location = null;
    await removeReleases((release) => release !== remote.release);
    for (const listener of changeListeners) listener();
    setStatus({ state: 'done', message: `Updated to Overture ${remote.release}` });
  } catch (e) {
    const detail = e instanceof Error ? e.message : 'network error';
    setStatus({ state: 'error', message: `Couldn't update places (${detail})` });
  }
}

async function downloadRelease(manifest: PoiManifest & { release: string }): Promise<void> {
  const root = `${DATA_DIR}/${manifest.release}`;
  const files = KINDS.flatMap((kind) =>
    (manifest.kinds[kind]?.tiles ?? []).map((key) => `${kind}/${key}.json`),
  );
  let next = 0;
  let done = 0;
  let failed = false;
  const report = () =>
    setStatus({ state: 'downloading', release: manifest.release, done, total: files.length });
  report();

  const worker = async () => {
    while (!failed && next < files.length) {
      const file = files[next++]!;
      const path = `${root}/${file}`;
      try {
        // Already there from an interrupted download.
        if (!(await fileExists(path))) {
          const url = `${POI_UPDATE_URL}/${manifest.release}/${file}`;
          const response = await fetch(url);
          if (!response.ok) throw new HttpStatusError(response.status, url);
          const text = await response.text();
          checkTile(text);
          await Filesystem.writeFile({
            path,
            data: text,
            directory: Directory.Data,
            encoding: Encoding.UTF8,
            recursive: true,
          });
        }
      } catch (e) {
        failed = true;
        throw e;
      }
      done += 1;
      report();
    }
  };
  await Promise.all(Array.from({ length: DOWNLOAD_CONCURRENCY }, worker));

  // Written last: a manifest marks the download as complete.
  await Filesystem.writeFile({
    path: `${root}/manifest.json`,
    data: JSON.stringify(manifest),
    directory: Directory.Data,
    encoding: Encoding.UTF8,
    recursive: true,
  });
}

async function removeReleases(shouldRemove: (release: string) => boolean): Promise<void> {
  let names: string[];
  try {
    const { files } = await Filesystem.readdir({ path: DATA_DIR, directory: Directory.Data });
    names = files.map((file) => file.name);
  } catch {
    return; // Nothing downloaded yet.
  }
  for (const name of names) {
    if (!shouldRemove(name)) continue;
    await Filesystem.rmdir({
      path: `${DATA_DIR}/${name}`,
      directory: Directory.Data,
      recursive: true,
    }).catch(() => undefined);
  }
}

/** Throws unless `raw` is a published manifest the app can safely download. */
export function parsePoiManifest(raw: unknown): PoiManifest & { release: string } {
  const manifest = raw as Partial<PoiManifest> | null;
  const invalid = () => new Error('Published data has an unexpected format');
  if (
    !manifest ||
    manifest.version !== 1 ||
    manifest.tileDegrees !== 1 ||
    typeof manifest.release !== 'string' ||
    !RELEASE_PATTERN.test(manifest.release) ||
    typeof manifest.kinds !== 'object' ||
    manifest.kinds == null
  ) {
    throw invalid();
  }
  let tiles = 0;
  for (const kind of KINDS) {
    const entry = manifest.kinds[kind];
    if (!entry) continue;
    if (
      !Array.isArray(entry.tiles) ||
      !entry.tiles.every((key) => typeof key === 'string' && TILE_PATTERN.test(key))
    ) {
      throw invalid();
    }
    tiles += entry.tiles.length;
  }
  if (tiles === 0 || tiles > MAX_TILES) throw invalid();
  return manifest as PoiManifest & { release: string };
}

function checkTile(text: string): void {
  const tile = JSON.parse(text) as { v?: unknown; names?: unknown; p?: unknown };
  if (
    tile.v !== 1 ||
    !Array.isArray(tile.names) ||
    !Array.isArray(tile.p) ||
    tile.p.length % 3 !== 0
  ) {
    throw new Error('Published tile has an unexpected format');
  }
}

/** Orders release names like 2026-10-21.0; a missing release sorts first. */
export function compareReleases(
  a: string | null | undefined,
  b: string | null | undefined,
): number {
  if (!a || !b) return a ? 1 : b ? -1 : 0;
  const [dateA = '', patchA = '0'] = a.split('.');
  const [dateB = '', patchB = '0'] = b.split('.');
  if (dateA !== dateB) return dateA < dateB ? -1 : 1;
  return Number(patchA) - Number(patchB);
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await Filesystem.stat({ path, directory: Directory.Data });
    return true;
  } catch {
    return false;
  }
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) throw new HttpStatusError(response.status, url);
  return (await response.json()) as T;
}

function setStatus(next: PoiUpdateStatus): void {
  status = next;
  for (const listener of statusListeners) listener(next);
}

function readPref(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writePref(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // ignore
  }
}
