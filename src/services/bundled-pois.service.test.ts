import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PoiTileFile } from './bundled-pois.service';
import type { PoiManifest } from './poi-data.service';

const manifest: PoiManifest = {
  version: 1,
  source: 'test',
  tileDegrees: 1,
  kinds: { fuel: { count: 3, tiles: ['73_18'] } },
};

const tile: PoiTileFile = {
  v: 1,
  names: ['', 'Hindustan Petroleum'],
  // Two stations in Mahad, one 40 km away.
  p: [7341660, 1808330, 1, 7342100, 1808900, 0, 7370000, 1780000, 1],
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

function stubAssets(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (url: string) => {
    if (url.endsWith('manifest.json')) return Response.json(manifest);
    if (url.endsWith('fuel/73_18.json')) return Response.json(tile);
    return new Response('missing', { status: 404 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('bundledPoisNear', () => {
  it('returns places in the cells around the search points', async () => {
    stubAssets();
    const { bundledPoisNear } = await import('./bundled-pois.service');
    const hits = await bundledPoisNear('fuel', [[73.4166, 18.0833]], 2_000);

    expect(hits.map((h) => h.name).sort()).toEqual([
      'Fuel station',
      'Hindustan Petroleum',
    ]);
    expect(hits[0]!.coordinate[0]).toBeCloseTo(73.4, 1);
  });

  it('only fetches tiles listed in the manifest', async () => {
    const fetchMock = stubAssets();
    const { bundledPoisNear } = await import('./bundled-pois.service');

    expect(await bundledPoisNear('food', [[73.4, 18.08]], 2_000)).toEqual([]);
    expect(await bundledPoisNear('fuel', [[80.2, 13.0]], 2_000)).toEqual([]);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'assets/poi/manifest.json',
    ]);
  });

  it('returns nothing when the data is not bundled', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 })));
    const { bundledPoisNear } = await import('./bundled-pois.service');

    expect(await bundledPoisNear('fuel', [[73.4, 18.08]], 2_000)).toEqual([]);
  });
});
