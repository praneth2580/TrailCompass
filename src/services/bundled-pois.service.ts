import type { Coordinate } from '../routing/routing-adapter';
import type { PlaceHit, PoiKind } from '../types/trip-stop';
import {
  BUNDLED_POI_BASE,
  currentPoiData,
  onPoiDataChanged,
  type PoiManifest,
} from './poi-data.service';

/**
 * Fuel stations and places to eat for India from Overture Maps, in 1° tiles:
 * bundled with the app, or a newer release it downloaded
 * (poi-data.service.ts). OpenStreetMap maps few of either along Indian
 * highways; these work offline too. Built by scripts/build-poi-tiles.py;
 * see public/assets/poi/README.md.
 */
/** Grid cell inside a tile, in degrees (~5.5 km). */
const CELL_DEG = 0.05;
/** Tiles kept in memory; a long trip touches a few dozen. */
const MAX_CACHED_TILES = 24;

export interface PoiTileFile {
  v: number;
  /** Index 0 is the empty name (unnamed place). */
  names: string[];
  /** Flat [lonE5, latE5, nameIndex, …] triples. */
  p: number[];
}

interface PoiTile {
  names: string[];
  p: number[];
  /** Cell key → offsets of the places inside it. */
  cells: Map<string, number[]>;
}

let manifest: Promise<{ base: string; manifest: PoiManifest } | null> | null = null;
/** Insertion order doubles as least-recently-used order. */
const tiles = new Map<string, Promise<PoiTile | null>>();

// A newer release was downloaded: read from it from now on.
onPoiDataChanged(() => {
  manifest = null;
  tiles.clear();
});

function loadManifest(): Promise<{ base: string; manifest: PoiManifest } | null> {
  manifest ??= (async () => {
    const { base } = await currentPoiData();
    // A downloaded copy that went missing falls back to the bundled one.
    const bases = base === BUNDLED_POI_BASE ? [base] : [base, BUNDLED_POI_BASE];
    for (const candidate of bases) {
      try {
        return {
          base: candidate,
          manifest: await fetchJson<PoiManifest>(`${candidate}/manifest.json`),
        };
      } catch {
        // Try the next copy.
      }
    }
    manifest = null;
    return null;
  })();
  return manifest;
}

function loadTile(base: string, kind: PoiKind, key: string): Promise<PoiTile | null> {
  const id = `${kind}/${key}`;
  let tile = tiles.get(id);
  if (tile) {
    tiles.delete(id);
  } else {
    tile = fetchJson<PoiTileFile>(`${base}/${id}.json`)
      .then(indexPoiTile)
      .catch(() => {
        tiles.delete(id);
        return null;
      });
  }
  tiles.set(id, tile);
  while (tiles.size > MAX_CACHED_TILES) {
    tiles.delete(tiles.keys().next().value!);
  }
  return tile;
}

export function indexPoiTile(file: PoiTileFile): PoiTile {
  const cells = new Map<string, number[]>();
  for (let offset = 0; offset + 2 < file.p.length; offset += 3) {
    const key = cellKey(file.p[offset]! / 1e5, file.p[offset + 1]! / 1e5);
    const bucket = cells.get(key);
    if (bucket) bucket.push(offset);
    else cells.set(key, [offset]);
  }
  return { names: file.names, p: file.p, cells };
}

/**
 * Bundled places in the grid cells around `points` (a point or a sampled
 * route stretch), padded by `radiusMeters`. Callers do the exact distance
 * check. Empty when the data is not bundled or the area is outside it.
 */
export async function bundledPoisNear(
  kind: PoiKind,
  points: Coordinate[],
  radiusMeters: number,
): Promise<PlaceHit[]> {
  const loaded = await loadManifest();
  const index = loaded?.manifest;
  const available = new Set(index?.kinds[kind]?.tiles ?? []);
  if (!loaded || !index || available.size === 0) return [];

  const wanted = new Set<string>();
  for (const point of points) {
    const pad = padDegrees(point, radiusMeters);
    for (let x = Math.floor((point[0] - pad.lon) / index.tileDegrees); x <= Math.floor((point[0] + pad.lon) / index.tileDegrees); x++) {
      for (let y = Math.floor((point[1] - pad.lat) / index.tileDegrees); y <= Math.floor((point[1] + pad.lat) / index.tileDegrees); y++) {
        const key = `${x}_${y}`;
        if (available.has(key)) wanted.add(key);
      }
    }
  }

  const keys = [...wanted];
  const tileData = await Promise.all(
    keys.map((key) => loadTile(loaded.base, kind, key)),
  );
  return tileData.flatMap((tile, i) =>
    tile ? placesNear(tile, `${kind}-${keys[i]}`, kind, points, radiusMeters) : [],
  );
}

/**
 * Bundled places inside a map view, for the fuel & food map layer.
 * `covered` is false where the bundled data has no tiles (outside India),
 * so the map shows OpenStreetMap's places there instead.
 */
export async function bundledPoisInBounds(
  kind: PoiKind,
  bbox: [west: number, south: number, east: number, north: number],
  limit = 3_000,
): Promise<{ places: PlaceHit[]; covered: boolean }> {
  const loaded = await loadManifest();
  const index = loaded?.manifest;
  const available = new Set(index?.kinds[kind]?.tiles ?? []);
  if (!loaded || !index || available.size === 0) return { places: [], covered: false };

  const [west, south, east, north] = bbox;
  const keys: string[] = [];
  for (let x = Math.floor(west / index.tileDegrees); x <= Math.floor(east / index.tileDegrees); x++) {
    for (let y = Math.floor(south / index.tileDegrees); y <= Math.floor(north / index.tileDegrees); y++) {
      if (available.has(`${x}_${y}`)) keys.push(`${x}_${y}`);
    }
  }
  // A view this wide is zoomed out too far to show places.
  if (keys.length === 0 || keys.length > 6) return { places: [], covered: keys.length > 0 };

  const places: PlaceHit[] = [];
  const tileData = await Promise.all(keys.map((key) => loadTile(loaded.base, kind, key)));
  tileData.forEach((tile, i) => {
    if (!tile) return;
    for (let offset = 0; offset + 2 < tile.p.length && places.length < limit; offset += 3) {
      const lon = tile.p[offset]! / 1e5;
      const lat = tile.p[offset + 1]! / 1e5;
      if (lon < west || lon > east || lat < south || lat > north) continue;
      places.push({
        id: `ovt-${kind}-${keys[i]}-${offset / 3}`,
        name: tile.names[tile.p[offset + 2]!] || '',
        coordinate: [lon, lat],
        subtitle: 'Overture Maps',
        kind,
      });
    }
  });
  return { places, covered: true };
}

export function placesNear(
  tile: PoiTile,
  idPrefix: string,
  kind: PoiKind,
  points: Coordinate[],
  radiusMeters: number,
): PlaceHit[] {
  const seen = new Set<number>();
  const hits: PlaceHit[] = [];
  for (const point of points) {
    const pad = padDegrees(point, radiusMeters);
    const x0 = Math.floor((point[0] - pad.lon) / CELL_DEG);
    const x1 = Math.floor((point[0] + pad.lon) / CELL_DEG);
    const y0 = Math.floor((point[1] - pad.lat) / CELL_DEG);
    const y1 = Math.floor((point[1] + pad.lat) / CELL_DEG);
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        for (const offset of tile.cells.get(`${x}:${y}`) ?? []) {
          if (seen.has(offset)) continue;
          seen.add(offset);
          hits.push({
            id: `ovt-${idPrefix}-${offset / 3}`,
            name:
              tile.names[tile.p[offset + 2]!] ||
              (kind === 'fuel' ? 'Fuel station' : 'Place to eat'),
            coordinate: [tile.p[offset]! / 1e5, tile.p[offset + 1]! / 1e5],
            subtitle: 'Overture Maps',
            kind,
          });
        }
      }
    }
  }
  return hits;
}

function padDegrees(
  point: Coordinate,
  radiusMeters: number,
): { lon: number; lat: number } {
  const cosLat = Math.max(0.2, Math.cos((point[1] * Math.PI) / 180));
  return { lon: radiusMeters / (111_320 * cosLat), lat: radiusMeters / 110_540 };
}

function cellKey(lon: number, lat: number): string {
  return `${Math.floor(lon / CELL_DEG)}:${Math.floor(lat / CELL_DEG)}`;
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return (await response.json()) as T;
}
