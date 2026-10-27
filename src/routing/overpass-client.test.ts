import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const MAIN = 'https://overpass-api.de/api/interpreter';

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** A server that accepts the connection and then never sends a byte. */
function silent(_url: string, init?: RequestInit): Promise<Response> {
  return new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () =>
      reject(new DOMException('Aborted', 'AbortError')),
    );
  });
}

/** A fresh module: mirror cooldowns are shared state. */
async function load() {
  vi.resetModules();
  return import('./overpass-client');
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('isRuntimeErrorRemark', () => {
  it('flags timeouts and out-of-memory remarks', async () => {
    const { isRuntimeErrorRemark } = await load();
    expect(
      isRuntimeErrorRemark(
        'runtime error: Query timed out in "query" at line 3 after 181 seconds.',
      ),
    ).toBe(true);
    expect(
      isRuntimeErrorRemark(
        'runtime error: Query run out of memory using about 2048 MB of RAM.',
      ),
    ).toBe(true);
  });

  it('ignores replies without an error remark', async () => {
    const { isRuntimeErrorRemark } = await load();
    expect(isRuntimeErrorRemark(undefined)).toBe(false);
    expect(isRuntimeErrorRemark('runtime remark: Timeout is 180')).toBe(false);
  });
});

describe('fetchOverpass', () => {
  it('retries the next mirror when a 200 reply carries a runtime error', async () => {
    const { fetchOverpass } = await load();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          remark: 'runtime error: Query timed out in "query" at line 3.',
          elements: [{ id: 1 }],
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ elements: [{ id: 1 }, { id: 2 }] }));
    vi.stubGlobal('fetch', fetchMock);

    const pending = fetchOverpass<{ id: number }>('[out:json][timeout:25];');
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await pending;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]![0]).not.toBe(fetchMock.mock.calls[1]![0]);
    expect(result.elements).toHaveLength(2);
  });

  it('drops a mirror that sends nothing, and skips it on the next request', async () => {
    const { fetchOverpass } = await load();
    const fetchMock = vi.fn((url: string, init?: RequestInit) =>
      url === MAIN ? silent(url, init) : Promise.resolve(jsonResponse({ elements: [{ id: 7 }] })),
    );
    vi.stubGlobal('fetch', fetchMock);
    const onRetry = vi.fn();

    // A road-tile query: the server may run for 180 s, but must start
    // answering within 75 s. Then a 2 s back-off before the next mirror.
    const pending = fetchOverpass('[out:json][timeout:180];', { onRetry });
    await vi.advanceTimersByTimeAsync(80_000);
    await expect(pending).resolves.toEqual({ elements: [{ id: 7 }] });
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      MAIN,
      'https://lz4.overpass-api.de/api/interpreter',
    ]);

    fetchMock.mockClear();
    await fetchOverpass('[out:json][timeout:180];');
    expect(fetchMock.mock.calls[0]![0]).not.toBe(MAIN);
  });

  it('tries the servers behind overpass-api.de when its front door is busy', async () => {
    const { fetchOverpass } = await load();
    const fetchMock = vi.fn((url: string) =>
      Promise.resolve(
        url === MAIN
          ? new Response('busy', { status: 502 })
          : jsonResponse({ elements: [] }),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const pending = fetchOverpass('[out:json][timeout:180];');
    await vi.advanceTimersByTimeAsync(5_000);
    await pending;

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      MAIN,
      'https://lz4.overpass-api.de/api/interpreter',
    ]);
  });
});
