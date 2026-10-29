import type { Coordinate } from '../routing/routing-adapter';
import { haversineMeters } from '../routing/geo';

/**
 * Which map tiles to save. For a route: the whole area at low zoom, and
 * narrower bands along the road as the zoom goes up. For an area (a city,
 * a state): every tile of its outline, zoom by zoom. OpenFreeMap allows
 * offline downloads of at most 3,000 tiles (https://openfreemap.org), so
 * long routes and big areas keep less detail.
 */

export type TileKey = [z: number, x: number, y: number];

export interface TilePlan {
  /** Low zoom first, then along the route, so a download cut short keeps the overview. */
  tiles: TileKey[];
  minZoom: number;
  maxZoom: number;
  /** [west, south, east, north] */
  bbox: [number, number, number, number];
}

/** An area to save: its outline, or just a box. */
export interface AreaShape {
  /** [west, south, east, north] */
  bbox: [number, number, number, number];
  /** Polygons as in GeoJSON: each a list of rings of [lon, lat], outer ring first. */
  polygons?: Coordinate[][][];
}

/** Zoom → metres either side of the route. */
type Corridor = Partial<Record<number, number>>;

/** Every tile of the route's area up to this zoom. */
const OVERVIEW_MAX_ZOOM = 8;
const OVERVIEW_MARGIN_METERS = 10_000;
export const MAX_ZOOM = 14;
export const MAX_TILES = 3_000;

/** Tried in order until one fits under the limit. */
const CORRIDORS: Corridor[] = [
  { 9: 30_000, 10: 25_000, 11: 12_000, 12: 6_000, 13: 4_000, 14: 2_500 },
  { 9: 20_000, 10: 20_000, 11: 8_000, 12: 5_000, 13: 2_500, 14: 1_200 },
  { 9: 15_000, 10: 15_000, 11: 6_000, 12: 3_000, 13: 1_500, 14: 500 },
  { 9: 15_000, 10: 10_000, 11: 5_000, 12: 2_000, 13: 800, 14: 0 },
  { 9: 10_000, 10: 8_000, 11: 3_000, 12: 1_500, 13: 0 },
  { 9: 10_000, 10: 5_000, 11: 2_000, 12: 0 },
  { 9: 5_000, 10: 2_000, 11: 0 },
  { 9: 2_000, 10: 0 },
];

export function lonToTileX(lon: number, z: number): number {
  const n = 2 ** z;
  return clamp(Math.floor(((lon + 180) / 360) * n), 0, n - 1);
}

export function latToTileY(lat: number, z: number): number {
  const n = 2 ** z;
  const rad = (clamp(lat, -85.0511, 85.0511) * Math.PI) / 180;
  const y = ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n;
  return clamp(Math.floor(y), 0, n - 1);
}

/** [west, south, east, north] of a tile. */
export function tileBounds(z: number, x: number, y: number): [number, number, number, number] {
  const n = 2 ** z;
  const lat = (row: number) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * row) / n))) * 180) / Math.PI;
  return [(x / n) * 360 - 180, lat(y + 1), ((x + 1) / n) * 360 - 180, lat(y)];
}

export function planRouteTiles(route: Coordinate[], maxTiles = MAX_TILES): TilePlan {
  if (route.length === 0) throw new Error('Route has no points');
  const bbox = paddedBbox(route, OVERVIEW_MARGIN_METERS);
  const overview: TileKey[] = [];
  for (let z = 0; z <= OVERVIEW_MAX_ZOOM; z++) {
    for (let x = lonToTileX(bbox[0], z); x <= lonToTileX(bbox[2], z); x++) {
      for (let y = latToTileY(bbox[3], z); y <= latToTileY(bbox[1], z); y++) overview.push([z, x, y]);
    }
  }

  let fallback: TilePlan | null = null;
  for (const corridor of CORRIDORS) {
    const tiles = [...overview];
    for (let z = OVERVIEW_MAX_ZOOM + 1; z <= MAX_ZOOM; z++) {
      const radius = corridor[z];
      if (radius == null) break;
      tiles.push(...corridorTiles(route, z, radius));
    }
    const plan: TilePlan = { tiles, minZoom: 0, maxZoom: tiles[tiles.length - 1]![0], bbox };
    if (tiles.length <= maxTiles) return plan;
    fallback = plan;
  }
  // A route this long keeps only its first tiles.
  const tiles = fallback!.tiles.slice(0, maxTiles);
  return { ...fallback!, tiles, maxZoom: tiles[tiles.length - 1]![0] };
}

/** Every zoom of the area up to the closest one that fits under `maxTiles`. */
export function planAreaTiles(area: AreaShape, maxTiles = MAX_TILES): TilePlan {
  const tiles: TileKey[] = [];
  let maxZoom = 0;
  for (let z = 0; z <= MAX_ZOOM; z++) {
    const level = areaTiles(area, z);
    if (tiles.length + level.length > maxTiles) break;
    tiles.push(...level);
    maxZoom = z;
  }
  return { tiles, minZoom: 0, maxZoom, bbox: area.bbox };
}

/** The tiles at zoom `z` that touch the area. */
export function areaTiles(area: AreaShape, z: number): TileKey[] {
  const [west, south, east, north] = area.bbox;
  const x0 = lonToTileX(west, z);
  const x1 = lonToTileX(east, z);
  const rings = area.polygons?.flat().filter((ring) => ring.length >= 3) ?? [];
  const out: TileKey[] = [];
  for (let y = latToTileY(north, z); y <= latToTileY(south, z); y++) {
    if (rings.length === 0) {
      for (let x = x0; x <= x1; x++) out.push([z, x, y]);
      continue;
    }
    const [, rowSouth, , rowNorth] = tileBounds(z, 0, y);
    const xs = new Set<number>();
    const mark = (lonA: number, lonB: number) => {
      const from = Math.max(x0, lonToTileX(Math.min(lonA, lonB), z));
      const to = Math.min(x1, lonToTileX(Math.max(lonA, lonB), z));
      for (let x = from; x <= to; x++) xs.add(x);
    };
    // Tiles the outline passes through…
    const middle = (rowSouth + rowNorth) / 2;
    const crossings: number[] = [];
    for (const ring of rings) {
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i]!;
        const b = ring[(i + 1) % ring.length]!;
        const low = Math.min(a[1], b[1]);
        const high = Math.max(a[1], b[1]);
        if (high < rowSouth || low > rowNorth) continue;
        if (a[1] === b[1]) {
          mark(a[0], b[0]);
        } else {
          const lonAt = (lat: number) => a[0] + ((b[0] - a[0]) * (lat - a[1])) / (b[1] - a[1]);
          mark(lonAt(Math.max(low, rowSouth)), lonAt(Math.min(high, rowNorth)));
          if (a[1] > middle !== b[1] > middle) crossings.push(lonAt(middle));
        }
      }
    }
    // …and the ones inside it, between pairs of crossings across the row's middle.
    crossings.sort((a, b) => a - b);
    for (let i = 0; i + 1 < crossings.length; i += 2) mark(crossings[i]!, crossings[i + 1]!);
    for (const x of [...xs].sort((a, b) => a - b)) out.push([z, x, y]);
  }
  return out;
}

/** Tiles within `radius` metres of the route at zoom `z`, in route order. */
export function corridorTiles(route: Coordinate[], z: number, radius: number): TileKey[] {
  const seen = new Set<string>();
  const out: TileKey[] = [];
  const add = (point: Coordinate) => {
    const [padLon, padLat] = padDegrees(point, radius);
    for (let x = lonToTileX(point[0] - padLon, z); x <= lonToTileX(point[0] + padLon, z); x++) {
      for (let y = latToTileY(point[1] + padLat, z); y <= latToTileY(point[1] - padLat, z); y++) {
        const key = `${x}/${y}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push([z, x, y]);
      }
    }
  };
  // Check often enough that no tile the road crosses is skipped.
  const tileMeters = (40_075_000 * Math.cos((route[0]![1] * Math.PI) / 180)) / 2 ** z;
  const step = Math.max(50, Math.min(tileMeters / 3, radius || tileMeters / 3));
  add(route[0]!);
  for (let i = 1; i < route.length; i++) {
    const a = route[i - 1]!;
    const b = route[i]!;
    const parts = Math.ceil(haversineMeters(a, b) / step);
    for (let k = 1; k <= parts; k++) {
      add([a[0] + ((b[0] - a[0]) * k) / parts, a[1] + ((b[1] - a[1]) * k) / parts]);
    }
  }
  return out;
}

function paddedBbox(route: Coordinate[], meters: number): [number, number, number, number] {
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (const [lon, lat] of route) {
    west = Math.min(west, lon);
    east = Math.max(east, lon);
    south = Math.min(south, lat);
    north = Math.max(north, lat);
  }
  const [padLon, padLat] = padDegrees([(west + east) / 2, (south + north) / 2], meters);
  return [
    Math.max(-180, west - padLon),
    Math.max(-85, south - padLat),
    Math.min(180, east + padLon),
    Math.min(85, north + padLat),
  ];
}

function padDegrees(point: Coordinate, meters: number): [number, number] {
  const cosLat = Math.max(0.2, Math.cos((point[1] * Math.PI) / 180));
  return [meters / (111_320 * cosLat), meters / 110_540];
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
