import type { RoutingProgressListener } from './routing-progress';
import { abortError, isAbortError, throwIfAborted } from './abort';
import { overpassScheduler } from './overpass-scheduler';
import { downloadPolicy } from '../services/download-policy.service';

const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  // The two servers behind overpass-api.de. They often still answer when
  // its front door returns 502 or 504.
  'https://lz4.overpass-api.de/api/interpreter',
  'https://z.overpass-api.de/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];
/** Give up on a mirror this long after the query's own server timeout. */
const CLIENT_TIMEOUT_GRACE_MS = 15_000;
const DEFAULT_CLIENT_TIMEOUT_MS = 120_000;
/**
 * A working server starts answering within about 40 s even for a large
 * road area. One that has sent nothing by now never does, so stop waiting.
 */
const FIRST_BYTE_TIMEOUT_MS = 75_000;
/** Skip a mirror that never answered for this long… */
const SILENT_MIRROR_COOLDOWN_MS = 10 * 60_000;
/** …and one that said it was busy or failed for this long. */
const BUSY_MIRROR_COOLDOWN_MS = 60_000;

/** Endpoint → time it may be tried again. Shared by every request. */
const mirrorCooldownUntil = new Map<string, number>();

/**
 * Run an Overpass QL query. One mirror at a time for a single query; the
 * scheduler may overlap a different request. On 429 / 5xx / network
 * failure or a mirror that stops answering, back off and try the next
 * mirror — never several at once. Mirrors that just failed are skipped by
 * later requests too, so one dead server costs a trip only once.
 */
export async function fetchOverpass<T>(
  query: string,
  options: {
    onProgress?: RoutingProgressListener;
    signal?: AbortSignal;
    /** Interactive lookups pass fewer tries so a fallback can take over sooner. */
    maxAttempts?: number;
    /** Called when an attempt failed and another mirror will be tried. */
    onRetry?: () => void;
    /** Road data for routing: waits while the Wi-Fi only setting holds it. */
    roadData?: boolean;
  } = {},
): Promise<{ elements?: T[] }> {
  const { onProgress, signal } = options;
  let lastError: Error | undefined;
  let mirror = 0;
  const maxAttempts = options.maxAttempts ?? OVERPASS_ENDPOINTS.length * 2;
  const timeoutMs = clientTimeoutMs(query);

  for (let attemptIndex = 0; attemptIndex < maxAttempts; attemptIndex++) {
    throwIfAborted(signal);
    if (options.roadData) await downloadPolicy.waitForRoads(signal);
    mirror = nextAvailableMirror(mirror);
    const endpoint = OVERPASS_ENDPOINTS[mirror]!;
    const release = await overpassScheduler.acquire(signal);
    const started = performance.now();
    let backoffMs = 0;
    // Per-attempt signal: the caller's abort, or this mirror going silent.
    const attempt = new AbortController();
    let timedOut = false;
    let silent = false;
    const timer = setTimeout(() => {
      timedOut = true;
      attempt.abort();
    }, timeoutMs);
    const firstByteTimer = setTimeout(() => {
      silent = true;
      attempt.abort();
    }, Math.min(FIRST_BYTE_TIMEOUT_MS, timeoutMs));
    const forwardAbort = () => attempt.abort();
    signal?.addEventListener('abort', forwardAbort, { once: true });
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
          Accept: 'application/json',
        },
        body: `data=${encodeURIComponent(query)}`,
        signal: attempt.signal,
      });
      clearTimeout(firstByteTimer);

      if (isSaturatedStatus(response.status)) {
        overpassScheduler.noteSaturated();
        coolDown(endpoint, BUSY_MIRROR_COOLDOWN_MS);
        lastError = new Error(`Overpass HTTP ${response.status}`);
        mirror += 1;
        backoffMs = retryAfterMs(response) ?? backoffDelayMs(attemptIndex);
      } else if (!response.ok) {
        coolDown(endpoint, BUSY_MIRROR_COOLDOWN_MS);
        lastError = new Error(`Overpass HTTP ${response.status}`);
        mirror += 1;
        backoffMs = backoffDelayMs(attemptIndex);
      } else {
        const text = await readResponseText(response, onProgress);
        let parsed: { elements?: T[]; remark?: string } | null = null;
        try {
          parsed = JSON.parse(text) as { elements?: T[]; remark?: string };
        } catch {
          lastError = new Error('Overpass returned invalid JSON');
          mirror += 1;
          backoffMs = backoffDelayMs(attemptIndex);
        }
        if (parsed && isRuntimeErrorRemark(parsed.remark)) {
          // HTTP 200 with a cut-off element list: never hand it on to be cached.
          overpassScheduler.noteSaturated();
          coolDown(endpoint, BUSY_MIRROR_COOLDOWN_MS);
          lastError = new Error(`Overpass ${parsed.remark!.trim()}`);
          mirror += 1;
          backoffMs = backoffDelayMs(attemptIndex);
        } else if (parsed) {
          overpassScheduler.noteSuccess(performance.now() - started);
          return parsed;
        }
      }
    } catch (e) {
      if (signal?.aborted) throw abortError();
      if (isAbortError(e) && !timedOut && !silent) throw e;
      overpassScheduler.noteSaturated();
      // No answer at all, or no connection: likely down for a while.
      coolDown(endpoint, silent || !timedOut ? SILENT_MIRROR_COOLDOWN_MS : BUSY_MIRROR_COOLDOWN_MS);
      lastError = silent
        ? new Error('Overpass mirror did not answer')
        : timedOut
          ? new Error('Overpass mirror timed out')
          : e instanceof Error
            ? e
            : new Error('Overpass request failed');
      mirror += 1;
      backoffMs = backoffDelayMs(attemptIndex);
    } finally {
      clearTimeout(timer);
      clearTimeout(firstByteTimer);
      signal?.removeEventListener('abort', forwardAbort);
      release();
    }

    if (attemptIndex < maxAttempts - 1) {
      options.onRetry?.();
      await sleep(backoffMs, signal);
    }
  }

  throw lastError ?? new Error('Overpass request failed');
}

/**
 * The first mirror from `start` (in rotation) that is not cooling down,
 * or the one that recovers soonest when all are.
 */
function nextAvailableMirror(start: number): number {
  const now = Date.now();
  let best = start % OVERPASS_ENDPOINTS.length;
  for (let step = 0; step < OVERPASS_ENDPOINTS.length; step++) {
    const index = (start + step) % OVERPASS_ENDPOINTS.length;
    const until = mirrorCooldownUntil.get(OVERPASS_ENDPOINTS[index]!) ?? 0;
    if (until <= now) return index;
    if (until < (mirrorCooldownUntil.get(OVERPASS_ENDPOINTS[best]!) ?? 0)) best = index;
  }
  return best;
}

function coolDown(endpoint: string, ms: number): void {
  mirrorCooldownUntil.set(endpoint, Date.now() + ms);
}

/** The query's `[timeout:N]` plus a grace period, or a default. */
function clientTimeoutMs(query: string): number {
  const match = query.match(/\[timeout:(\d+)\]/);
  return match
    ? Number(match[1]) * 1_000 + CLIENT_TIMEOUT_GRACE_MS
    : DEFAULT_CLIENT_TIMEOUT_MS;
}

/**
 * Overpass reports a timeout or out-of-memory as HTTP 200 with a
 * "runtime error: …" remark and whatever elements it had gathered so far.
 */
export function isRuntimeErrorRemark(remark: unknown): boolean {
  return typeof remark === 'string' && /runtime error/i.test(remark);
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
