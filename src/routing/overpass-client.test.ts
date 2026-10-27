import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchOverpass, isRuntimeErrorRemark } from './overpass-client';

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('isRuntimeErrorRemark', () => {
  it('flags timeouts and out-of-memory remarks', () => {
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

  it('ignores replies without an error remark', () => {
    expect(isRuntimeErrorRemark(undefined)).toBe(false);
    expect(isRuntimeErrorRemark('runtime remark: Timeout is 180')).toBe(false);
  });
});

describe('fetchOverpass', () => {
  it('retries the next mirror when a 200 reply carries a runtime error', async () => {
    vi.useFakeTimers();
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
});
