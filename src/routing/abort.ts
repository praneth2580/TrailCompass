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
