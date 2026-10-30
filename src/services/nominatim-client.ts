import { Capacitor, CapacitorHttp } from '@capacitor/core';
import { abortError, throwIfAborted } from '../routing/abort';

const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
const NOMINATIM_REVERSE_URL = 'https://nominatim.openstreetmap.org/reverse';
/** Nominatim's usage policy allows at most one request per second. */
const NOMINATIM_MIN_INTERVAL_MS = 1_000;
const NOMINATIM_TIMEOUT_MS = 15_000;
/**
 * The policy asks apps to identify themselves; the WebView's stock browser
 * User-Agent does not, and fetch() cannot replace it. Native HTTP can.
 */
const APP_USER_AGENT =
  'TrailCompass (+https://github.com/praneth2580/TrailCompass)';

export interface NominatimResult {
  place_id: number;
  display_name: string;
  lat: string;
  lon: string;
  name?: string;
  type?: string;
  category?: string;
  class?: string;
  /** e.g. "city", "state_district", "state". */
  addresstype?: string;
  osm_type?: 'node' | 'way' | 'relation';
  osm_id?: number;
  /** [south, north, west, east] */
  boundingbox?: [string, string, string, string];
  /** With polygon_geojson=1. */
  geojson?: { type: string; coordinates: unknown };
}

let nextRequestAt = 0;

async function waitForNominatimSlot(signal?: AbortSignal): Promise<void> {
  const now = Date.now();
  const waitMs = Math.max(0, nextRequestAt - now);
  nextRequestAt = Math.max(now, nextRequestAt) + NOMINATIM_MIN_INTERVAL_MS;
  if (waitMs <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(done, waitMs);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    function done() {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** One Nominatim /search call (jsonv2), throttled to the policy's rate. */
export async function nominatimSearch(
  params: Record<string, string>,
  signal?: AbortSignal,
): Promise<NominatimResult[]> {
  const data = await nominatimGet(NOMINATIM_URL, params, signal);
  return Array.isArray(data) ? (data as NominatimResult[]) : [];
}

/** Parts of an address, as Nominatim names them (with addressdetails=1). */
export type NominatimAddress = Partial<
  Record<
    | 'road'
    | 'neighbourhood'
    | 'quarter'
    | 'suburb'
    | 'hamlet'
    | 'village'
    | 'town'
    | 'city'
    | 'county',
    string
  >
>;

/** One Nominatim /reverse call (jsonv2): what is at a point. Null where nothing is. */
export async function nominatimReverse(
  params: Record<string, string>,
  signal?: AbortSignal,
): Promise<(NominatimResult & { address?: NominatimAddress }) | null> {
  const data = await nominatimGet(NOMINATIM_REVERSE_URL, params, signal);
  if (!data || typeof data !== 'object' || 'error' in data) return null;
  return data as NominatimResult & { address?: NominatimAddress };
}

async function nominatimGet(
  endpoint: string,
  params: Record<string, string>,
  signal?: AbortSignal,
): Promise<unknown> {
  throwIfAborted(signal);
  await waitForNominatimSlot(signal);
  throwIfAborted(signal);
  const url = `${endpoint}?${new URLSearchParams({ format: 'jsonv2', ...params })}`;

  if (Capacitor.isNativePlatform()) {
    const response = await CapacitorHttp.get({
      url,
      headers: { Accept: 'application/json', 'User-Agent': APP_USER_AGENT },
      connectTimeout: NOMINATIM_TIMEOUT_MS,
      readTimeout: NOMINATIM_TIMEOUT_MS,
    });
    throwIfAborted(signal);
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Nominatim HTTP ${response.status}`);
    }
    return typeof response.data === 'string' ? JSON.parse(response.data) : response.data;
  }

  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), NOMINATIM_TIMEOUT_MS);
  const forwardAbort = () => timeout.abort();
  signal?.addEventListener('abort', forwardAbort, { once: true });
  try {
    const response = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: timeout.signal,
    });
    if (!response.ok) throw new Error(`Nominatim HTTP ${response.status}`);
    return (await response.json()) as unknown;
  } catch (e) {
    throwIfAborted(signal);
    if (timeout.signal.aborted) throw new Error('Nominatim timed out');
    throw e;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', forwardAbort);
  }
}
