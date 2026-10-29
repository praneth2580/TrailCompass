import { addProtocol, type StyleSpecification } from 'maplibre-gl';
import { zxyToTileId } from 'pmtiles';
import libertyStyle from './liberty-style.json';
import { anySignal } from '../routing/abort';
import { packFiles } from './pack-files';
import { tileStore } from './tile-store';

/**
 * The map's `tcmap://` protocol. Every basemap request goes through it:
 *
 * - `tcmap://tiles/{z}/{x}/{y}`: vector tiles from the phone's tile store
 *   (tile-store.ts) when it has the tile, else from OpenFreeMap.
 * - `tcmap://ne2/{z}/{x}/{y}`: the low-zoom relief raster, online only.
 * - `tcmap://fonts/…`, `tcmap://sprites/…`: label fonts and map icons,
 *   kept on the phone the first time they load, so labels and icons
 *   still draw offline.
 *
 * The style is a copy of OpenFreeMap's Liberty style (liberty-style.json)
 * with its URLs pointed here, so the map opens without a network.
 */

const SCHEME = 'tcmap';
export const OPENFREEMAP = 'https://tiles.openfreemap.org';
const PLANET_TILEJSON = `${OPENFREEMAP}/planet`;
const TILES_TEMPLATE_KEY = 'tc.ofmPlanetTiles';
const NETWORK_TIMEOUT_MS = 12_000;
const SPRITE = 'sprites/ofm_f384/ofm';
const FONTS = ['Noto Sans Regular', 'Noto Sans Bold', 'Noto Sans Italic'];
/**
 * Glyph ranges kept for offline use: Latin, punctuation, and the scripts
 * of Indian place names (Devanagari to Malayalam) and Urdu.
 */
const OFFLINE_GLYPH_RANGES = [
  '0-255', '256-511', '512-767', '768-1023', '1536-1791', '2304-2559',
  '2560-2815', '2816-3071', '3072-3327', '3328-3583', '8192-8447',
];
export const MAP_ATTRIBUTION =
  '<a href="https://openfreemap.org" target="_blank">OpenFreeMap</a> ' +
  '<a href="https://www.openmaptiles.org/" target="_blank">&copy; OpenMapTiles</a> ' +
  'Data from <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a>';

/** OpenMapTiles POI classes the fuel & food overlay draws itself. */
export const FUEL_CLASSES = ['fuel'];
export const FOOD_CLASSES = ['restaurant', 'fast_food', 'cafe'];

let registered = false;
let tilesTemplate: Promise<string> | null = null;

export function registerTileProtocol(): void {
  if (registered) return;
  registered = true;
  addProtocol(SCHEME, async (params, abortController) => {
    const [kind, ...rest] = params.url.slice(SCHEME.length + 3).split('/');
    const signal = abortController.signal;
    if (kind === 'tiles') {
      const [z, x, y] = rest.map(Number) as [number, number, number];
      return { data: await loadVectorTile(z, x, y, signal) };
    }
    if (kind === 'ne2') {
      return { data: await fetchBytes(`${OPENFREEMAP}/natural_earth/ne2sr/${rest.join('/')}.png`, signal) };
    }
    if (kind === 'fonts' || kind === 'sprites') {
      const bytes = await loadAsset(`${kind}/${rest.join('/')}`, signal);
      if (params.url.endsWith('.json')) return { data: JSON.parse(new TextDecoder().decode(bytes)) };
      return { data: bytes.buffer as ArrayBuffer };
    }
    throw new Error(`Unknown map request ${params.url}`);
  });
}

/** OpenFreeMap's Liberty style, reading everything through `tcmap://`. */
export function buildMapStyle(): StyleSpecification {
  const style = structuredClone(libertyStyle) as unknown as StyleSpecification;
  style.sources = {
    ...style.sources,
    openmaptiles: {
      type: 'vector',
      tiles: [`${SCHEME}://tiles/{z}/{x}/{y}`],
      minzoom: 0,
      maxzoom: 14,
      attribution: MAP_ATTRIBUTION,
    },
    ne2_shaded: {
      type: 'raster',
      tiles: [`${SCHEME}://ne2/{z}/{x}/{y}`],
      tileSize: 256,
      maxzoom: 6,
    },
  };
  style.glyphs = `${SCHEME}://fonts/{fontstack}/{range}.pbf`;
  style.sprite = `${SCHEME}://${SPRITE}`;
  // Fuel stations and places to eat get their own layers (map.service.ts).
  const ours: unknown = ['match', ['get', 'class'], [...FUEL_CLASSES, ...FOOD_CLASSES], false, true];
  for (const layer of style.layers) {
    if (layer.type === 'symbol' && 'source-layer' in layer && layer['source-layer'] === 'poi' && layer.filter) {
      layer.filter = ['all', layer.filter, ours] as typeof layer.filter;
    }
  }
  return style;
}

async function loadVectorTile(z: number, x: number, y: number, signal: AbortSignal): Promise<ArrayBuffer> {
  const local = await readOfflineTile(z, x, y, signal);
  if (local) return local;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    // MapLibre keeps showing the lower-zoom tile it already has.
    throw new Error('Offline and not in a saved map');
  }
  const template = await planetTilesTemplate();
  return fetchBytes(fillTemplate(template, z, x, y), signal).then((bytes) => bytes.buffer as ArrayBuffer);
}

/** The saved copy of a tile, if the phone has one. */
export async function readOfflineTile(
  z: number,
  x: number,
  y: number,
  signal?: AbortSignal,
): Promise<ArrayBuffer | null> {
  try {
    return await tileStore.readTile(zxyToTileId(z, x, y), signal);
  } catch (e) {
    if (signal?.aborted) throw e;
    // A damaged or just-deleted file: fetch it instead.
    return null;
  }
}

/**
 * OpenFreeMap's tile URL names the current planet build. Remembered, so
 * the map works when the TileJSON can't be fetched.
 */
export function planetTilesTemplate(options: { refresh?: boolean } = {}): Promise<string> {
  if (options.refresh) tilesTemplate = null;
  tilesTemplate ??= (async () => {
    const cached = readSetting(TILES_TEMPLATE_KEY);
    const fresh = fetchWithTimeout(PLANET_TILEJSON)
      .then((response) => response.json() as Promise<{ tiles?: string[] }>)
      .then((tilejson) => {
        const template = tilejson.tiles?.[0];
        if (!template?.startsWith(OPENFREEMAP)) throw new Error('Unexpected TileJSON');
        writeSetting(TILES_TEMPLATE_KEY, template);
        return template;
      });
    if (cached && !options.refresh) {
      fresh.catch(() => undefined);
      return cached;
    }
    return fresh.catch((e) => {
      tilesTemplate = null;
      if (cached) return cached;
      throw e;
    });
  })();
  return tilesTemplate;
}

/** "20261025_080012_pt" from a planet tile template. */
export function planetVersion(template: string): string {
  return template.match(/planet\/([^/]+)\//)?.[1] ?? 'unknown';
}

export function fillTemplate(template: string, z: number, x: number, y: number): string {
  return template.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y));
}

/** A font range or icon file: from the phone, else downloaded and kept. */
async function loadAsset(path: string, signal?: AbortSignal): Promise<Uint8Array> {
  const local = await packFiles.readBytes(assetPath(path));
  if (local && local.length > 0) return local;
  const bytes = await fetchBytes(`${OPENFREEMAP}/${path}`, signal);
  void packFiles.writeBytes(assetPath(path), bytes).catch(() => undefined);
  return bytes;
}

/** Saves the fonts and icons a map needs offline; skips what's already kept. */
export async function prefetchMapAssets(signal?: AbortSignal): Promise<void> {
  const paths = [
    ...['.json', '.png', '@2x.json', '@2x.png'].map((suffix) => `${SPRITE}${suffix}`),
    ...FONTS.flatMap((font) =>
      OFFLINE_GLYPH_RANGES.map((range) => `fonts/${encodeURIComponent(font)}/${range}.pbf`),
    ),
  ];
  for (const path of paths) {
    signal?.throwIfAborted();
    await loadAsset(path, signal);
  }
}

/** Font names have spaces and arrive URL-encoded: keep file names plain. */
function assetPath(path: string): string {
  return `assets/${decodeURIComponent(path).replace(/[^A-Za-z0-9._@/-]/g, '_')}`;
}

export async function fetchBytes(
  url: string,
  signal?: AbortSignal,
  timeoutMs = NETWORK_TIMEOUT_MS,
): Promise<Uint8Array> {
  const response = await fetchWithTimeout(url, signal, timeoutMs);
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return new Uint8Array(await response.arrayBuffer());
}

/** The timeout covers the whole body, not just the response headers. */
async function fetchWithTimeout(url: string, signal?: AbortSignal, timeoutMs = NETWORK_TIMEOUT_MS): Promise<Response> {
  const timeout = AbortSignal.timeout(timeoutMs);
  return fetch(url, { signal: signal ? anySignal([signal, timeout]) : timeout });
}

function readSetting(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeSetting(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Fetched again next time.
  }
}
