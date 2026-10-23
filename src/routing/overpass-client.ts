import type { RoutingProgressListener } from './routing-progress';
import { abortError, isAbortError, throwIfAborted } from './abort';
import { overpassScheduler } from './overpass-scheduler';

const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

/**
 * Run an Overpass QL query. One mirror at a time for a single query; the
 * scheduler may overlap a different request. On 429 / 5xx / network
 * failure, back off and try the other mirror — never both at once.
 */
export async function fetchOverpass<T>(
  query: string,
  options: { onProgress?: RoutingProgressListener; signal?: AbortSignal } = {},
): Promise<{ elements?: T[] }> {
  const { onProgress, signal } = options;
  let lastError: Error | undefined;
  let mirror = 0;
  const maxAttempts = OVERPASS_ENDPOINTS.length * 2;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    throwIfAborted(signal);
    const endpoint = OVERPASS_ENDPOINTS[mirror % OVERPASS_ENDPOINTS.length]!;
    const release = await overpassScheduler.acquire(signal);
    const started = performance.now();
    let backoffMs = 0;
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
          Accept: 'application/json',
        },
        body: `data=${encodeURIComponent(query)}`,
        signal,
      });

      if (isSaturatedStatus(response.status)) {
        overpassScheduler.noteSaturated();
        lastError = new Error(`Overpass HTTP ${response.status}`);
        mirror += 1;
        backoffMs = retryAfterMs(response) ?? backoffDelayMs(attempt);
      } else if (!response.ok) {
        lastError = new Error(`Overpass HTTP ${response.status}`);
        mirror += 1;
        backoffMs = backoffDelayMs(attempt);
      } else {
        const text = await readResponseText(response, onProgress);
        try {
          const parsed = JSON.parse(text) as { elements?: T[] };
          overpassScheduler.noteSuccess(performance.now() - started);
          return parsed;
        } catch {
          lastError = new Error('Overpass returned invalid JSON');
          mirror += 1;
          backoffMs = backoffDelayMs(attempt);
        }
      }
    } catch (e) {
      if (isAbortError(e)) throw e;
      overpassScheduler.noteSaturated();
      lastError = e instanceof Error ? e : new Error('Overpass request failed');
      mirror += 1;
      backoffMs = backoffDelayMs(attempt);
    } finally {
      release();
    }

    await sleep(backoffMs, signal);
  }

  throw lastError ?? new Error('Overpass request failed');
}

function isSaturatedStatus(status: number): boolean {
  return status === 429 || status === 502 || status === 503 || status === 504;
}

/** 2s, 4s, 8s — capped so a stuck mirror does not stall the trip. */
function backoffDelayMs(attempt: number): number {
  return Math.min(8_000, 2_000 * 2 ** attempt);
}

function retryAfterMs(response: Response): number | null {
  const raw = response.headers.get('retry-after');
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(30_000, seconds * 1_000);
  }
  const when = Date.parse(raw);
  if (Number.isNaN(when)) return null;
  return Math.min(30_000, Math.max(0, when - Date.now()));
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const timer = setTimeout(finish, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    function finish() {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Read body with byte progress when Content-Length is present.
 * If length is missing, percent stays null (indeterminate — no fake %).
 */
async function readResponseText(
  response: Response,
  onProgress?: RoutingProgressListener,
): Promise<string> {
  const totalHeader = response.headers.get('content-length');
  const bytesTotal =
    totalHeader && /^\d+$/.test(totalHeader) ? Number(totalHeader) : null;

  if (!response.body || bytesTotal == null || bytesTotal <= 0) {
    onProgress?.({
      phase: 'downloading-roads',
      label: 'Downloading connecting roads…',
      percent: null,
    });
    return response.text();
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytesReceived = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      bytesReceived += value.byteLength;
      const percent = Math.min(
        99,
        Math.round((bytesReceived / bytesTotal) * 100),
      );
      onProgress?.({
        phase: 'downloading-roads',
        label: 'Downloading connecting roads…',
        percent,
        bytesReceived,
        bytesTotal,
      });
    }
  }

  onProgress?.({
    phase: 'downloading-roads',
    label: 'Downloading connecting roads…',
    percent: 100,
    bytesReceived,
    bytesTotal,
  });

  const merged = new Uint8Array(bytesReceived);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}
