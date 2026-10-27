import { Capacitor, CapacitorHttp } from '@capacitor/core';
import { abortError, throwIfAborted } from '../routing/abort';

const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
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
  throwIfAborted(signal);
  await waitForNominatimSlot(signal);
  throwIfAborted(signal);
  const url = `${NOMINATIM_URL}?${new URLSearchParams({ format: 'jsonv2', ...params })}`;

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
    const data: unknown =
      typeof response.data === 'string' ? JSON.parse(response.data) : response.data;
    return Array.isArray(data) ? (data as NominatimResult[]) : [];
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
    const data: unknown = await response.json();
    return Array.isArray(data) ? (data as NominatimResult[]) : [];
  } catch (e) {
    throwIfAborted(signal);
    if (timeout.signal.aborted) throw new Error('Nominatim timed out');
    throw e;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', forwardAbort);
  }
}
