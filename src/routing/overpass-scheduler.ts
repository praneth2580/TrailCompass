import { abortError } from './abort';

/**
 * Public Overpass mirrors finish queries slowly and reject bursts.
 * Start at one in-flight request. After a fast clean response, allow two.
 * A 429, 5xx, or network failure drops back to one. Never go wider than two.
 */
const MAX_CONCURRENCY = 2;
const FAST_RESPONSE_MS = 4_000;

class OverpassScheduler {
  private limit = 1;
  private active = 0;
  private waiters: Array<() => void> = [];

  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) throw abortError();

    if (this.active < this.limit && this.waiters.length === 0) {
      this.active += 1;
      return this.releaser();
    }

    await new Promise<void>((resolve, reject) => {
      const wake = () => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      };
      const onAbort = () => {
        this.waiters = this.waiters.filter((waiter) => waiter !== wake);
        reject(abortError());
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.waiters.push(wake);
    });

    return this.releaser();
  }

  /** A quick 200 means the mirror can take one more request. */
  noteSuccess(elapsedMs: number): void {
    if (elapsedMs > FAST_RESPONSE_MS) return;
    if (this.limit >= MAX_CONCURRENCY) return;
    this.limit = MAX_CONCURRENCY;
    this.pump();
  }

  /** Rate limit or a dead mirror — stop overlapping requests. */
  noteSaturated(): void {
    this.limit = 1;
  }

  private releaser(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active = Math.max(0, this.active - 1);
      this.pump();
    };
  }

  private pump(): void {
    while (this.active < this.limit && this.waiters.length > 0) {
      const wake = this.waiters.shift();
      if (!wake) break;
      this.active += 1;
      wake();
    }
  }
}

export const overpassScheduler = new OverpassScheduler();
