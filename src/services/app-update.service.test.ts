import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppUpdateStatus } from './app-update.service';

const native = vi.hoisted(() => ({
  updater: {
    download: vi.fn(),
    install: vi.fn(),
    canInstall: vi.fn(),
    addListener: vi.fn(),
  },
  resume: null as null | (() => void),
}));

vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => true },
  registerPlugin: () => native.updater,
}));

vi.mock('@capacitor/app', () => ({
  App: {
    getInfo: async () => ({ version: '2.0.0' }),
    addListener: async (_event: string, listener: () => void) => {
      native.resume = listener;
      return { remove: async () => undefined };
    },
  },
}));

const APK_URL =
  'https://github.com/praneth2580/TrailCompass/releases/download/v2.1.0/trailcompass.2.1.0.apk';

function release(tag = 'v2.1.0', overrides: Record<string, unknown> = {}) {
  return {
    tag_name: tag,
    html_url: `https://github.com/praneth2580/TrailCompass/releases/tag/${tag}`,
    draft: false,
    prerelease: false,
    body: '## Changes\n- Fuel fix & new **dash** UI\n\n* Faster road downloads',
    assets: [
      { name: 'notes.txt', size: 10, browser_download_url: 'https://example.com/notes.txt' },
      { name: 'trailcompass.2.1.0.apk', size: 10_122_605, browser_download_url: APK_URL },
    ],
    ...overrides,
  };
}

function serve(body: unknown) {
  const fetchMock = vi.fn(async () => Response.json(body));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** A fresh module (its status is shared state), recording every status. */
async function load() {
  vi.resetModules();
  const service = await import('./app-update.service');
  const statuses: AppUpdateStatus[] = [];
  service.subscribeAppUpdates((status) => statuses.push(status));
  return { service, last: () => statuses[statuses.length - 1]!, statuses };
}

beforeEach(() => {
  const prefs = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => prefs.get(key) ?? null,
    setItem: (key: string, value: string) => void prefs.set(key, value),
  });
  for (const fn of Object.values(native.updater)) fn.mockReset();
  native.updater.addListener.mockResolvedValue({ remove: async () => undefined });
  native.resume = null;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('compareVersions', () => {
  it('compares each part as a number', async () => {
    const { service } = await load();
    expect(service.compareVersions('2.10.0', '2.9.0')).toBeGreaterThan(0);
    expect(service.compareVersions('2.1.0', '2.1.0')).toBe(0);
    expect(service.compareVersions('2.0.0', '2.1.0')).toBeLessThan(0);
  });
});

describe('parseRelease', () => {
  it('takes the APK from this repo and plain-text notes', async () => {
    const { service } = await load();
    expect(service.parseRelease(release())).toMatchObject({
      version: '2.1.0',
      apkUrl: APK_URL,
      apkName: 'trailcompass.2.1.0.apk',
      sizeBytes: 10_122_605,
      notes: ['Changes', 'Fuel fix & new dash UI', 'Faster road downloads'],
    });
  });

  it('ignores APKs from anywhere else, and pre-releases', async () => {
    const { service } = await load();
    const foreign = release('v2.1.0', {
      assets: [{ name: 'evil.apk', size: 1, browser_download_url: 'https://example.com/evil.apk' }],
    });
    expect(service.parseRelease(foreign)).toBeNull();
    expect(service.parseRelease(release('v2.1.0', { prerelease: true }))).toBeNull();
    expect(service.parseRelease(release('nightly'))).toBeNull();
  });
});

describe('checkForAppUpdate', () => {
  it('offers a newer release, and asks GitHub at most once a day', async () => {
    const fetchMock = serve(release());
    const { service, last } = await load();

    await service.checkForAppUpdate();
    expect(last()).toMatchObject({ state: 'available', current: '2.0.0', prompt: true });

    await service.checkForAppUpdate();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('says up to date when the installed version is the latest', async () => {
    serve(release('v2.0.0'));
    const { service, last } = await load();

    await service.checkForAppUpdate({ force: true });
    expect(last()).toEqual({ state: 'up-to-date', current: '2.0.0' });
  });

  it('keeps quiet about a version the rider postponed', async () => {
    serve(release());
    const { service, last } = await load();
    await service.checkForAppUpdate();
    service.snoozeAppUpdate();
    expect(last()).toMatchObject({ state: 'available', prompt: false });

    // The next day's background check still finds it, but doesn't prompt…
    localStorage.setItem('tc.appUpdateCheckedAt', '0');
    await service.checkForAppUpdate();
    expect(last()).toMatchObject({ state: 'available', prompt: false });
    // …while a tap on "Check for updates" does.
    await service.checkForAppUpdate({ force: true });
    expect(last()).toMatchObject({ state: 'available', prompt: true });
  });
});

describe('installAppUpdate', () => {
  it('downloads with progress, then opens the installer', async () => {
    serve(release());
    const { service, last, statuses } = await load();
    await service.checkForAppUpdate();
    native.updater.addListener.mockImplementation(async (_event, listener) => {
      native.updater.download.mockImplementation(async () => {
        listener({ bytes: 5_000_000, total: 10_122_605 });
        return { path: '/cache/updates/trailcompass.2.1.0.apk' };
      });
      return { remove: async () => undefined };
    });
    native.updater.install.mockResolvedValue({ status: 'started' });

    await service.installAppUpdate();

    expect(native.updater.download).toHaveBeenCalledWith({
      url: APK_URL,
      fileName: 'trailcompass.2.1.0.apk',
    });
    expect(statuses).toContainEqual(
      expect.objectContaining({ state: 'downloading', bytes: 5_000_000, total: 10_122_605 }),
    );
    expect(last()).toMatchObject({
      state: 'installing',
      path: '/cache/updates/trailcompass.2.1.0.apk',
    });
  });

  it('continues by itself once installs are allowed', async () => {
    serve(release());
    const { service, last } = await load();
    await service.checkForAppUpdate();
    native.updater.download.mockResolvedValue({ path: '/cache/updates/trailcompass.2.1.0.apk' });
    native.updater.install
      .mockResolvedValueOnce({ status: 'needs-permission' })
      .mockResolvedValueOnce({ status: 'started' });
    native.updater.canInstall.mockResolvedValue({ value: true });

    await service.installAppUpdate();
    expect(last()).toMatchObject({ state: 'needs-permission' });

    // The rider allowed it in Settings and came back.
    await native.resume!();
    await vi.waitFor(() => expect(last()).toMatchObject({ state: 'installing' }));
    expect(native.updater.download).toHaveBeenCalledTimes(1);
  });

  it('keeps the release on a failed download so it can be retried', async () => {
    serve(release());
    const { service, last } = await load();
    await service.checkForAppUpdate();
    native.updater.download.mockRejectedValue(new Error('Download failed: HTTP 503'));

    await service.installAppUpdate();
    expect(last()).toMatchObject({
      state: 'error',
      message: 'Download failed: HTTP 503',
      release: { version: '2.1.0' },
    });
  });
});
