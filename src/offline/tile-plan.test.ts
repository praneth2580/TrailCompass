import { describe, expect, it } from 'vitest';
import type { Coordinate } from '../routing/routing-adapter';
import {
  areaTiles,
  corridorTiles,
  latToTileY,
  lonToTileX,
  MAX_TILES,
  planAreaTiles,
  planRouteTiles,
  tileBounds,
  type AreaShape,
} from './tile-plan';

/** A straight route from `a` to `b` with a point every ~1 km. */
function line(a: Coordinate, b: Coordinate, points = 400): Coordinate[] {
  return Array.from({ length: points + 1 }, (_, i) => [
    a[0] + ((b[0] - a[0]) * i) / points,
    a[1] + ((b[1] - a[1]) * i) / points,
  ]);
}

describe('tile maths', () => {
  it('finds the tile containing a point', () => {
    const [z, lon, lat] = [14, 72.8777, 19.076];
    const x = lonToTileX(lon, z);
    const y = latToTileY(lat, z);
    const [west, south, east, north] = tileBounds(z, x, y);
    expect(lon).toBeGreaterThanOrEqual(west);
    expect(lon).toBeLessThan(east);
    expect(lat).toBeGreaterThanOrEqual(south);
    expect(lat).toBeLessThan(north);
  });
});

describe('planRouteTiles', () => {
  it('keeps full street detail along a city ride', () => {
    const plan = planRouteTiles(line([72.83, 18.93], [72.88, 19.11], 40));
    expect(plan.maxZoom).toBe(14);
    expect(plan.tiles.length).toBeLessThan(400);
    // Every tile the road passes through at z14 is in the plan.
    const keys = new Set(plan.tiles.map((t) => t.join('/')));
    for (const [lon, lat] of line([72.83, 18.93], [72.88, 19.11], 200)) {
      expect(keys.has(`14/${lonToTileX(lon, 14)}/${latToTileY(lat, 14)}`)).toBe(true);
    }
  });

  it('stays under the download limit on a long trip, low zoom first', () => {
    // Mumbai to Goa, roughly.
    const plan = planRouteTiles(line([72.87, 19.07], [73.83, 15.49], 600));
    expect(plan.tiles.length).toBeLessThanOrEqual(MAX_TILES);
    expect(plan.maxZoom).toBeGreaterThanOrEqual(13);
    const zooms = plan.tiles.map(([z]) => z);
    expect(zooms).toEqual([...zooms].sort((a, b) => a - b));
    expect(plan.tiles[0]).toEqual([0, 0, 0]);
  });

  it('trims detail on a cross-country trip instead of failing', () => {
    // Mumbai to Delhi and on to Srinagar.
    const route = [...line([72.87, 19.07], [77.2, 28.61], 1400), ...line([77.2, 28.61], [74.8, 34.08], 800)];
    const plan = planRouteTiles(route);
    expect(plan.tiles.length).toBeLessThanOrEqual(MAX_TILES);
    expect(plan.maxZoom).toBeGreaterThanOrEqual(10);
    expect(new Set(plan.tiles.map((t) => t.join('/'))).size).toBe(plan.tiles.length);
  });

  it('includes tiles either side of the road', () => {
    const route = line([73.0, 18.5], [73.2, 18.5], 20);
    const narrow = corridorTiles(route, 14, 0);
    const wide = corridorTiles(route, 14, 1_500);
    expect(wide.length).toBeGreaterThan(narrow.length * 2);
  });
});

/** A closed ring, as GeoJSON writes them. */
function ring(points: Coordinate[]): Coordinate[] {
  return [...points, points[0]!];
}

describe('planAreaTiles', () => {
  const box: AreaShape['bbox'] = [72.8, 18.9, 73.0, 19.1];

  it('covers a square outline exactly like its box', () => {
    const square: AreaShape = {
      bbox: box,
      polygons: [[ring([[72.8, 18.9], [73.0, 18.9], [73.0, 19.1], [72.8, 19.1]])]],
    };
    for (const z of [8, 11, 14]) {
      expect(areaTiles(square, z)).toEqual(areaTiles({ bbox: box }, z));
    }
  });

  it('leaves out tiles outside a triangle but keeps every tile it touches', () => {
    const corners: Coordinate[] = [[72.8, 18.9], [73.0, 18.9], [72.8, 19.1]];
    const triangle: AreaShape = { bbox: box, polygons: [[ring(corners)]] };
    const tiles = areaTiles(triangle, 14);
    const all = areaTiles({ bbox: box }, 14);
    expect(tiles.length).toBeLessThan(all.length * 0.7);
    expect(tiles.length).toBeGreaterThan(all.length * 0.4);
    const keys = new Set(tiles.map(([, x, y]) => `${x}/${y}`));
    for (const [lon, lat] of [...corners, [72.85, 18.95] as Coordinate]) {
      expect(keys.has(`${lonToTileX(lon, 14)}/${latToTileY(lat, 14)}`)).toBe(true);
    }
    // Far corner, outside the hypotenuse.
    expect(keys.has(`${lonToTileX(72.99, 14)}/${latToTileY(19.09, 14)}`)).toBe(false);
  });

  it('skips holes and covers each polygon of a multipolygon', () => {
    const outer = ring([[72.8, 18.9], [73.0, 18.9], [73.0, 19.1], [72.8, 19.1]]);
    const hole = ring([[72.85, 18.95], [72.95, 18.95], [72.95, 19.05], [72.85, 19.05]]);
    const island = ring([[73.2, 18.9], [73.25, 18.9], [73.25, 18.95], [73.2, 18.95]]);
    const shape: AreaShape = { bbox: [72.8, 18.9, 73.25, 19.1], polygons: [[outer, hole], [island]] };
    const keys = new Set(areaTiles(shape, 14).map(([, x, y]) => `${x}/${y}`));
    expect(keys.has(`${lonToTileX(72.9, 14)}/${latToTileY(19.0, 14)}`)).toBe(false);
    expect(keys.has(`${lonToTileX(72.81, 14)}/${latToTileY(19.0, 14)}`)).toBe(true);
    expect(keys.has(`${lonToTileX(73.22, 14)}/${latToTileY(18.92, 14)}`)).toBe(true);
    expect(keys.has(`${lonToTileX(73.1, 14)}/${latToTileY(19.0, 14)}`)).toBe(false);
  });

  it('keeps full street detail for a city', () => {
    const plan = planAreaTiles({ bbox: box });
    expect(plan.maxZoom).toBe(14);
    expect(plan.tiles.length).toBeLessThanOrEqual(MAX_TILES);
    // Every zoom from 0, low zoom first.
    expect(plan.tiles[0]).toEqual([0, 0, 0]);
    expect(new Set(plan.tiles.map(([z]) => z)).size).toBe(15);
  });

  it('keeps less detail for a state, staying under the limit', () => {
    // Roughly Maharashtra's box.
    const plan = planAreaTiles({ bbox: [72.6, 15.6, 80.9, 22.0] });
    expect(plan.tiles.length).toBeLessThanOrEqual(MAX_TILES);
    expect(plan.maxZoom).toBeGreaterThanOrEqual(9);
    expect(plan.maxZoom).toBeLessThan(12);
    expect(Math.max(...plan.tiles.map(([z]) => z))).toBe(plan.maxZoom);
  });
});

