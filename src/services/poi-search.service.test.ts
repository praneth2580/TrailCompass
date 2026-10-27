import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Coordinate } from '../routing/routing-adapter';
import type { PlaceHit } from '../types/trip-stop';

const mocks = vi.hoisted(() => ({
  bundledPoisNear: vi.fn(),
  nominatimSearch: vi.fn(),
  fetchOverpass: vi.fn(),
}));

vi.mock('./bundled-pois.service', () => ({
  bundledPoisNear: mocks.bundledPoisNear,
}));
vi.mock('./nominatim-client', () => ({
  nominatimSearch: mocks.nominatimSearch,
}));
vi.mock('../routing/overpass-client', () => ({
  fetchOverpass: mocks.fetchOverpass,
}));

const { findPois } = await import('./poi-search.service');

const mahad: Coordinate = [73.4166, 18.0833];

function station(id: string, eastMeters: number): PlaceHit {
  return {
    id,
    name: `Pump ${id}`,
    coordinate: [mahad[0] + eastMeters / 105_900, mahad[1]],
    kind: 'fuel',
  };
}

function nominatimRow(id: number, eastMeters: number) {
  return {
    place_id: id,
    display_name: `Pump ${id}`,
    name: `OSM pump ${id}`,
    lat: String(mahad[1]),
    lon: String(mahad[0] + eastMeters / 105_900),
    category: 'amenity',
    type: 'fuel',
  };
}

beforeEach(() => {
  mocks.bundledPoisNear.mockReset().mockResolvedValue([]);
  mocks.nominatimSearch.mockReset().mockResolvedValue([]);
  mocks.fetchOverpass.mockReset().mockResolvedValue({ elements: [] });
});

describe('findPois', () => {
  it('skips the network when the bundled data has enough stations', async () => {
    mocks.bundledPoisNear.mockResolvedValue([
      station('a', 100),
      station('b', 600),
      station('c', 1_200),
    ]);

    const hits = await findPois({ kind: 'fuel', near: mahad, radiusMeters: 2_000 });

    expect(hits.map((h) => h.id)).toEqual(['a', 'b', 'c']);
    expect(mocks.nominatimSearch).not.toHaveBeenCalled();
    expect(mocks.fetchOverpass).not.toHaveBeenCalled();
  });

  it('adds Nominatim results where bundled ones are few, merging duplicates', async () => {
    mocks.bundledPoisNear.mockResolvedValue([station('a', 100)]);
    mocks.nominatimSearch.mockResolvedValue([
      nominatimRow(1, 120), // same pump as "a", 20 m away
      nominatimRow(2, 900),
    ]);

    const hits = await findPois({ kind: 'fuel', near: mahad, radiusMeters: 2_000 });

    expect(hits.map((h) => h.name)).toEqual(['OSM pump 1', 'OSM pump 2']);
    expect(mocks.nominatimSearch.mock.calls[0]![0]).toMatchObject({
      q: '[fuel]',
      bounded: '1',
    });
  });

  it('falls back to Overpass when Nominatim fails', async () => {
    mocks.nominatimSearch.mockRejectedValue(new Error('Nominatim HTTP 503'));
    mocks.fetchOverpass.mockResolvedValue({
      elements: [
        { type: 'node', id: 7, lat: mahad[1], lon: mahad[0], tags: { name: 'IOC' } },
      ],
    });

    const hits = await findPois({ kind: 'fuel', near: mahad, radiusMeters: 2_000 });

    expect(hits.map((h) => h.name)).toEqual(['IOC']);
  });

  it('uses one Overpass query for a long stretch', async () => {
    const longRoute: Coordinate[] = [mahad, [mahad[0] + 1.5, mahad[1]]];

    await findPois({ kind: 'food', route: longRoute, radiusMeters: 1_500 });

    expect(mocks.nominatimSearch).not.toHaveBeenCalled();
    expect(mocks.fetchOverpass).toHaveBeenCalledTimes(1);
    expect(mocks.fetchOverpass.mock.calls[0]![0]).toContain('nwr["amenity"~');
  });

  it('explains a failure only when nothing was found', async () => {
    mocks.nominatimSearch.mockRejectedValue(new Error('Nominatim HTTP 503'));
    mocks.fetchOverpass.mockRejectedValue(new Error('Overpass HTTP 504'));

    await expect(
      findPois({ kind: 'fuel', near: mahad, radiusMeters: 2_000 }),
    ).rejects.toThrow(/Couldn't reach OpenStreetMap \(Overpass HTTP 504; Nominatim also failed\)/);

    mocks.bundledPoisNear.mockResolvedValue([station('a', 100)]);
    await expect(
      findPois({ kind: 'fuel', near: mahad, radiusMeters: 2_000 }),
    ).resolves.toHaveLength(1);
  });
});
