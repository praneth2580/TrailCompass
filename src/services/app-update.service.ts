import { App } from '@capacitor/app';
import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import { downloadPolicy } from './download-policy.service';

/**
 * In-app updates from GitHub Releases (the app is not on Google Play).
 * Checks the latest release about once a day, downloads its APK with
 * progress, and hands it to Android's installer. Android only replaces the
 * app if the new APK is signed with the same key.
 *
 * The website serves a copy of each release (download/latest.json, from
 * .github/workflows/pages.yml), used first: GitHub's own release downloads
 * are slow or stall on many mobile networks, and the site is on a CDN.
 */

/** Native side: android/app/src/main/java/com/example/trailcompass/AppUpdaterPlugin.java */
interface AppUpdaterPlugin {
  download(options: { url: string; fileName: string }): Promise<{ path: string }>;
  install(options: { path: string }): Promise<{ status: 'started' | 'needs-permission' }>;
  canInstall(): Promise<{ value: boolean }>;
  addListener(
    eventName: 'progress',
    listener: (progress: { bytes: number; total: number }) => void,
  ): Promise<PluginListenerHandle>;
}

const AppUpdater = registerPlugin<AppUpdaterPlugin>('AppUpdater');

const REPO = 'praneth2580/TrailCompass';
const SITE_URL = 'https://praneth2580.github.io/TrailCompass/';
const SITE_LATEST_URL = `${SITE_URL}download/latest.json`;
const LATEST_RELEASE_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
/** From GitHub, APKs are only fetched from this repo's releases. */
const DOWNLOAD_PREFIX = `https://github.com/${REPO}/releases/download/`;
const SITE_APK_PATH = /^download\/[A-Za-z0-9._-]+\.apk$/;
const PREFS_CHECKED_AT = 'tc.appUpdateCheckedAt';
const PREFS_SNOOZE = 'tc.appUpdateSnooze';
const CHECK_EVERY_MS = 24 * 60 * 60 * 1000;
/** "Later" hides the prompt for that version this long. */
const SNOOZE_MS = 3 * 24 * 60 * 60 * 1000;
const MAX_NOTES = 5;

export interface AppRelease {
  /** e.g. "2.1.0" */
  version: string;
  apkUrl: string;
  apkName: string;
  sizeBytes: number;
  /** A few lines of the release notes, markdown stripped. */
  notes: string[];
  pageUrl: string;
}

export type AppUpdateStatus =
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'up-to-date'; current: string }
  /** `prompt`: show the update sheet now (false while snoozed). */
  | { state: 'available'; current: string; release: AppRelease; prompt: boolean }
  | { state: 'downloading'; current: string; release: AppRelease; bytes: number; total: number }
  | { state: 'installing'; current: string; release: AppRelease; path: string }
  | { state: 'needs-permission'; current: string; release: AppRelease; path: string }
  | { state: 'error'; message: string; current?: string; release?: AppRelease };

let status: AppUpdateStatus = { state: 'idle' };
const listeners = new Set<(status: AppUpdateStatus) => void>();
let checking: Promise<void> | null = null;

export function subscribeAppUpdates(
  listener: (status: AppUpdateStatus) => void,
): () => void {
  listeners.add(listener);
  listener(status);
  return () => listeners.delete(listener);
}

/** The installed version (versionName), or null outside the Android app. */
export async function installedAppVersion(): Promise<string | null> {
  if (!Capacitor.isNativePlatform()) return null;
  try {
    return (await App.getInfo()).version;
  } catch {
    return null;
  }
}

/**
 * Look for a newer release. Without `force`, asks GitHub at most once a
 * day and stays quiet (no prompt) for a version the rider postponed.
 */
export function checkForAppUpdate(options: { force?: boolean } = {}): Promise<void> {
  checking ??= runCheck(options.force === true).finally(() => {
    checking = null;
  });
  return checking;
}

async function runCheck(force: boolean): Promise<void> {
  if (status.state === 'downloading' || status.state === 'installing') return;
  const current = await installedAppVersion();
  if (!current) {
    if (force) setStatus({ state: 'error', message: 'Updates install in the Android app' });
    return;
  }
  if (!force && Date.now() - Number(readPref(PREFS_CHECKED_AT) ?? 0) < CHECK_EVERY_MS) return;

  setStatus({ state: 'checking' });
  try {
    const release = await fetchLatestRelease();
    writePref(PREFS_CHECKED_AT, String(Date.now()));

    if (!release || compareVersions(release.version, current) <= 0) {
      setStatus({ state: 'up-to-date', current });
      return;
    }
    setStatus({
      state: 'available',
      current,
      release,
      prompt: force || !isSnoozed(release.version),
    });
  } catch (e) {
    const detail = e instanceof Error ? e.message : 'network error';
    // A failed background check stays quiet; a tapped one explains.
    setStatus(
      force
        ? { state: 'error', message: `Couldn't check for updates (${detail})`, current }
        : { state: 'idle' },
    );
  }
}

/** "Later": hide the prompt for this version for a few days. */
export function snoozeAppUpdate(): void {
  if (status.state !== 'available' && status.state !== 'error') return;
  const release = status.release;
  if (!release) return;
  writePref(PREFS_SNOOZE, JSON.stringify({ version: release.version, until: Date.now() + SNOOZE_MS }));
  if (status.state === 'available') setStatus({ ...status, prompt: false });
  else setStatus({ state: 'idle' });
}

/** Show the prompt again, e.g. from the Offline tab. */
export function showAppUpdatePrompt(): void {
  if (status.state === 'available') setStatus({ ...status, prompt: true });
}

/** Download the release (unless already downloaded) and open the installer. */
export async function installAppUpdate(): Promise<void> {
  const current = 'current' in status ? status.current : undefined;
  const release = 'release' in status ? status.release : undefined;
  if (!current || !release) return;

  let path = status.state === 'installing' || status.state === 'needs-permission'
    ? status.path
    : null;
  if (!path && !downloadPolicy.canDownload()) {
    setStatus({
      state: 'error',
      message: 'Downloads are set to Wi-Fi only. Connect to Wi-Fi, or allow mobile data in the Offline tab.',
      current,
      release,
    });
    return;
  }

  let progress: PluginListenerHandle | null = null;
  try {
    if (!path) {
      setStatus({ state: 'downloading', current, release, bytes: 0, total: release.sizeBytes });
      progress = await AppUpdater.addListener('progress', ({ bytes, total }) => {
        if (status.state !== 'downloading') return;
        setStatus({ ...status, bytes, total: total > 0 ? total : release.sizeBytes });
      });
      path = (await AppUpdater.download({ url: release.apkUrl, fileName: release.apkName })).path;
    }

    const { status: result } = await AppUpdater.install({ path });
    if (result === 'needs-permission') {
      setStatus({ state: 'needs-permission', current, release, path });
      watchForPermission(path);
      return;
    }
    // Android's installer is on screen; the app restarts once it finishes.
    setStatus({ state: 'installing', current, release, path });
  } catch (e) {
    const detail = e instanceof Error ? e.message : 'Download failed';
    setStatus({ state: 'error', message: detail, current, release });
  } finally {
    await progress?.remove();
  }
}

/**
 * The rider was sent to "Install unknown apps". When they come back with it
 * allowed, carry on; if not, just wait (re-opening Settings would loop).
 */
function watchForPermission(path: string): void {
  let handle: PluginListenerHandle | null = null;
  void App.addListener('resume', async () => {
    void handle?.remove();
    if (status.state !== 'needs-permission' || status.path !== path) return;
    const { value } = await AppUpdater.canInstall().catch(() => ({ value: false }));
    if (value) await installAppUpdate();
  }).then((h) => {
    handle = h;
  });
}

/** The newest release: the website's copy first, else GitHub's API. */
async function fetchLatestRelease(): Promise<AppRelease | null> {
  try {
    const response = await fetch(SITE_LATEST_URL, { cache: 'no-cache' });
    if (response.ok) {
      const release = parseSiteRelease(await response.json());
      if (release) return release;
    }
  } catch {
    // Fall back to GitHub.
  }
  const response = await fetch(LATEST_RELEASE_URL, {
    headers: { Accept: 'application/vnd.github+json' },
    cache: 'no-cache',
  });
  if (!response.ok) throw new Error(`GitHub HTTP ${response.status}`);
  return parseRelease(await response.json());
}

/** download/latest.json from the website → what the app needs, or null if unusable. */
export function parseSiteRelease(raw: unknown): AppRelease | null {
  const latest = raw as {
    version?: unknown;
    apk?: unknown;
    size?: unknown;
    notes?: unknown;
  } | null;
  if (!latest || typeof latest.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(latest.version)) {
    return null;
  }
  if (typeof latest.apk !== 'string' || !SITE_APK_PATH.test(latest.apk)) return null;
  return {
    version: latest.version,
    apkUrl: `${SITE_URL}${latest.apk}`,
    apkName: latest.apk.slice('download/'.length),
    sizeBytes: typeof latest.size === 'number' ? latest.size : 0,
    notes: noteLines(latest.notes),
    pageUrl: SITE_URL,
  };
}

/** Release JSON from the GitHub API → what the app needs, or null if unusable. */
export function parseRelease(raw: unknown): AppRelease | null {
  const release = raw as {
    tag_name?: unknown;
    body?: unknown;
    draft?: unknown;
    prerelease?: unknown;
    assets?: Array<{ name?: unknown; size?: unknown; browser_download_url?: unknown }>;
  } | null;
  if (!release || release.draft || release.prerelease) return null;
  const version = typeof release.tag_name === 'string' ? release.tag_name.replace(/^v/, '') : '';
  if (!/^\d+\.\d+\.\d+$/.test(version)) return null;

  const apk = (release.assets ?? []).find(
    (asset) =>
      typeof asset.name === 'string' &&
      /^[A-Za-z0-9._-]+\.apk$/.test(asset.name) &&
      typeof asset.browser_download_url === 'string' &&
      asset.browser_download_url.startsWith(DOWNLOAD_PREFIX),
  );
  if (!apk) return null;

  return {
    version,
    apkUrl: apk.browser_download_url as string,
    apkName: apk.name as string,
    sizeBytes: typeof apk.size === 'number' ? apk.size : 0,
    notes: noteLines(release.body),
    // The website's download button is the fast one.
    pageUrl: SITE_URL,
  };
}

/** The first few lines of release notes, markdown stripped. */
function noteLines(body: unknown): string[] {
  if (typeof body !== 'string') return [];
  return body
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:[-*+]|#{1,6}|\d+\.)\s+/, '').replace(/[*_`]/g, '').trim())
    .filter(Boolean)
    .slice(0, MAX_NOTES);
}

/** Compares dotted versions numerically: 2.10.0 is newer than 2.9.0. */
export function compareVersions(a: string, b: string): number {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function isSnoozed(version: string): boolean {
  try {
    const snooze = JSON.parse(readPref(PREFS_SNOOZE) ?? 'null') as {
      version?: string;
      until?: number;
    } | null;
    return snooze?.version === version && (snooze.until ?? 0) > Date.now();
  } catch {
    return false;
  }
}

function setStatus(next: AppUpdateStatus): void {
  status = next;
  for (const listener of listeners) listener(next);
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
