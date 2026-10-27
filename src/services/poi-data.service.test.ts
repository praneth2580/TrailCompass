import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PoiUpdateStatus } from './poi-data.service';

/** In-memory stand-in for the app's data folder. */
const disk = vi.hoisted(() => new Map<string, string>());

/** The Wi-Fi only setting: `allowed` is false on mobile data with it on. */
const policy = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  return {
    allowed: true,
    listeners,
    set(allowed: boolean) {
      this.allowed = allowed;
      for (const listener of [...listeners]) listener();
    },
  };
});

vi.mock('./download-policy.service', () => ({
  downloadPolicy: {
    canDownload: () => policy.allowed,
    subscribe: (listener: () => void) => {
      policy.listeners.add(listener);
      return () => policy.listeners.delete(listener);
    },
  },
}));

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: () => true,
    convertFileSrc: (uri: string) =>
      uri.replace('file://', 'https://localhost/_capacitor_file_'),
  },
}));

vi.mock('@capacitor/filesystem', () => ({
  Directory: { Data: 'DATA' },
  Encoding: { UTF8: 'utf8' },
  Filesystem: {
    writeFile: async ({ path, data }: { path: string; data: string }) => {
      disk.set(path, data);
      return { uri: `file:///data/${path}` };
    },
    stat: async ({ path }: { path: string }) => {
      if (!disk.has(path)) throw new Error('File does not exist');
      return {};
    },
    getUri: async ({ path }: { path: string }) => ({ uri: `file:///data/${path}` }),
    readdir: async ({ path }: { path: string }) => {
      const names = new Set<string>();
      for (const file of disk.keys()) {
        if (file.startsWith(`${path}/`)) names.add(file.slice(path.length + 1).split('/')[0]!);
      }
      if (names.size === 0) throw new Error('Directory does not exist');
      return { files: [...names].map((name) => ({ name })) };
    },
    rmdir: async ({ path }: { path: string }) => {
      for (const file of [...disk.keys()]) {
        if (file.startsWith(`${path}/`)) disk.delete(file);
      }
    },
  },
}));

const REMOTE = 'https://praneth2580.github.io/TrailCompass/poi';
const BUNDLED_RELEASE = '2026-10-21.0';
const TILE = JSON.stringify({ v: 1, names: ['', 'Hindustan Petroleum'], p: [7341660, 1808330, 1] });

function manifest(release: string, fuelTiles = ['73_18']) {
  return {
    version: 1,
    source: 'test',
    release,
    countries: ['IN'],
    tileDegrees: 1,
    kinds: {
      fuel: { count: fuelTiles.length, tiles: fuelTiles },
      food: { count: 1, tiles: ['73_18'] },
    },
  };
}

/** Serve the bundled manifest, the published manifest (or a 404) and tiles. */
function serve(published: object | 404, missing: string[] = []) {
  const fetchMock = vi.fn(async (url: string) => {
    if (url === 'assets/poi/manifest.json') return Response.json(manifest(BUNDLED_RELEASE));
    if (url === `${REMOTE}/manifest.json`) {
      return published === 404 ? new Response('', { status: 404 }) : Response.json(published);
    }
    if (url.startsWith(`${REMOTE}/`) && !missing.some((path) => url.endsWith(path))) {
      return new Response(TILE);
    }
    return new Response('', { status: 404 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** A fresh copy of the module, so its in-memory state starts clean. */
async function load() {
  vi.resetModules();
  const service = await import('./poi-data.service');
  const statuses: PoiUpdateStatus[] = [];
  service.subscribePoiUpdates((status) => statuses.push(status));
  return { service, last: () => statuses[statuses.length - 1]! };
}

beforeEach(() => {
  disk.clear();
  policy.allowed = true;
  policy.listeners.clear();
  const prefs = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => prefs.get(key) ?? null,
    setItem: (key: string, value: string) => void prefs.set(key, value),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('compareReleases', () => {
  it('orders by date, then patch number, with a missing release first', async () => {
    const { service } = await load();
    expect(service.compareReleases('2026-11-18.0', '2026-10-21.0')).toBeGreaterThan(0);
    expect(service.compareReleases('2026-10-21.10', '2026-10-21.9')).toBeGreaterThan(0);
    expect(service.compareReleases('2026-10-21.0', '2026-10-21.0')).toBe(0);
    expect(service.compareReleases(null, '2026-10-21.0')).toBeLessThan(0);
  });
});

describe('formatPoiRelease', () => {
  it('shows a release as its date', async () => {
    const { service } = await load();
    expect(service.formatPoiRelease('2026-10-21.0')).toBe('21 Oct 2026');
    expect(service.formatPoiRelease('2026-01-05.3')).toBe('5 Jan 2026');
    expect(service.formatPoiRelease('custom')).toBe('custom');
  });
});

describe('parsePoiManifest', () => {
  it('accepts a published manifest', async () => {
    const { service } = await load();
    expect(service.parsePoiManifest(manifest('2026-11-18.0')).release).toBe('2026-11-18.0');
  });

  it('rejects names that could escape the data folder', async () => {
    const { service } = await load();
    expect(() => service.parsePoiManifest(manifest('../../x'))).toThrow();
    expect(() => service.parsePoiManifest(manifest('2026-11-18.0', ['../../evil']))).toThrow();
    expect(() => service.parsePoiManifest({ ...manifest('2026-11-18.0'), version: 2 })).toThrow();
  });
});

describe('checkForPoiUpdate', () => {
  it('downloads a newer release, switches to it and removes old downloads', async () => {
    disk.set('poi-data/2026-09-23.0/manifest.json', '{}');
    serve(manifest('2026-11-18.0'));
    const { service, last } = await load();
    const changed = vi.fn();
    service.onPoiDataChanged(changed);

    await service.checkForPoiUpdate({ force: true });

    expect([...disk.keys()].sort()).toEqual([
      'poi-data/2026-11-18.0/food/73_18.json',
      'poi-data/2026-11-18.0/fuel/73_18.json',
      'poi-data/2026-11-18.0/manifest.json',
    ]);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(last()).toEqual({ state: 'done', message: 'Updated to the 18 Nov 2026 data' });
    expect(await service.currentPoiData()).toEqual({
      base: 'https://localhost/_capacitor_file_/data/poi-data/2026-11-18.0',
      release: '2026-11-18.0',
      downloaded: true,
    });
  });

  it('waits for Wi-Fi when downloads are set to Wi-Fi only', async () => {
    serve(manifest('2026-11-18.0'));
    policy.allowed = false;
    const { service, last } = await load();

    await service.checkForPoiUpdate();

    expect(disk.size).toBe(0);
    expect(last()).toEqual({
      state: 'done',
      message: 'Newer data from 18 Nov 2026 · downloads on Wi-Fi',
    });

    policy.set(true);
    await vi.waitFor(() =>
      expect(last()).toEqual({ state: 'done', message: 'Updated to the 18 Nov 2026 data' }),
    );
    expect(disk.has('poi-data/2026-11-18.0/manifest.json')).toBe(true);
  });

  it('downloads nothing when the bundled data is already the latest', async () => {
    const fetchMock = serve(manifest(BUNDLED_RELEASE));
    const { service, last } = await load();

    await service.checkForPoiUpdate({ force: true });

    expect(fetchMock.mock.calls.map(([url]) => url)).not.toContain(
      `${REMOTE}/${BUNDLED_RELEASE}/fuel/73_18.json`,
    );
    expect(last()).toEqual({ state: 'done', message: 'Up to date · data from 21 Oct 2026' });
    expect(service.lastPoiCheckAt()).not.toBeNull();
  });

  it('resumes an interrupted download', async () => {
    disk.set('poi-data/2026-11-18.0/fuel/73_18.json', TILE);
    const fetchMock = serve(manifest('2026-11-18.0'));
    const { service } = await load();

    await service.checkForPoiUpdate({ force: true });

    const urls = fetchMock.mock.calls.map(([url]) => url);
    expect(urls).not.toContain(`${REMOTE}/2026-11-18.0/fuel/73_18.json`);
    expect(urls).toContain(`${REMOTE}/2026-11-18.0/food/73_18.json`);
  });

  it('keeps the current data when a download fails, and retries next time', async () => {
    serve(manifest('2026-11-18.0'), ['/food/73_18.json']);
    const { service, last } = await load();

    await service.checkForPoiUpdate({ force: true });

    expect(last()).toMatchObject({ state: 'error' });
    expect(disk.has('poi-data/2026-11-18.0/manifest.json')).toBe(false);
    expect(service.lastPoiCheckAt()).toBeNull();
    expect(await service.currentPoiData()).toMatchObject({ downloaded: false });
  });

  it('asks GitHub at most once a day unless forced', async () => {
    const fetchMock = serve(404);
    const { service, last } = await load();

    await service.checkForPoiUpdate();
    expect(last()).toEqual({ state: 'done', message: 'No published update yet' });
    fetchMock.mockClear();

    await service.checkForPoiUpdate();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
