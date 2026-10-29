export function abortError(): DOMException {
  return new DOMException('Route planning cancelled', 'AbortError');
}

export function isAbortError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error != null &&
    'name' in error &&
    (error as { name?: string }).name === 'AbortError'
  );
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

/**
 * Aborts when any of `signals` does. AbortSignal.any needs Chrome 116;
 * older Android WebViews lack it.
 */
export function anySignal(signals: AbortSignal[]): AbortSignal {
  const controller = new AbortController();
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
}
