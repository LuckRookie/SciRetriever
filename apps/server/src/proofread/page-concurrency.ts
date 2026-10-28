import type { ArchiveRateLimitRetry } from "@sciretriever/contracts";

/** One document's page workers and model attempts share a decreasing limit. */
export class PageProofreadConcurrency {
  private requests = 0;
  private pages = 0;
  private until = 0;
  private readonly waiters = new Set<() => void>();
  private limit: number;
  constructor(readonly initial = 3) {
    if (!Number.isSafeInteger(initial) || initial < 1 || initial > 8)
      throw new RangeError("invalid page concurrency");
    this.limit = initial;
  }
  private wake() {
    for (const wake of [...this.waiters]) wake();
  }
  private wait(signal?: AbortSignal, ms?: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const finish = () => {
        cleanup();
        resolve();
      };
      const abort = () => {
        cleanup();
        reject(signal!.reason);
      };
      const timer = ms === undefined ? undefined : setTimeout(finish, ms);
      const cleanup = () => {
        clearTimeout(timer);
        this.waiters.delete(finish);
        signal?.removeEventListener("abort", abort);
      };
      this.waiters.add(finish);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
    });
  }
  async acquireRequest(signal: AbortSignal): Promise<() => void> {
    for (;;) {
      signal.throwIfAborted();
      const remaining = this.until - Date.now();
      if (this.requests < this.limit && remaining <= 0) break;
      await this.wait(signal, remaining > 0 ? remaining : undefined);
    }
    this.requests++;
    return () => {
      this.requests--;
      this.wake();
    };
  }
  async rateLimited(
    page: number,
    retryAfterMs: number | undefined,
    signal: AbortSignal,
    record: (event: ArchiveRateLimitRetry) => void,
  ): Promise<void> {
    const previous = this.limit;
    this.limit = Math.max(1, this.limit - 1);
    const reduced = this.limit;
    // Network already bounds a service Retry-After. A missing hint uses 1 s.
    const delay = retryAfterMs ?? 1000;
    if (!Number.isSafeInteger(delay) || delay < 0 || delay > 120_000)
      throw new RangeError("invalid rate limit delay");
    this.until = Math.max(this.until, Date.now() + delay);
    this.wake();
    const started = performance.now();
    try {
      while (Date.now() < this.until)
        await this.wait(signal, this.until - Date.now());
    } finally {
      record({
        page_index: page,
        retry_after_ms: retryAfterMs ?? null,
        wait_ms: Math.round(performance.now() - started),
        concurrency_before: previous,
        concurrency_after: reduced,
      });
    }
  }
  async run<T>(
    items: readonly T[],
    work: (item: T) => Promise<void>,
    signal?: AbortSignal,
  ): Promise<void> {
    let next = 0;
    const errors: unknown[] = [];
    await Promise.all(
      Array.from({ length: Math.min(this.initial, items.length) }, async () => {
        while (next < items.length) {
          // On cancellation, still visit unstarted pages to record their disposition.
          while (!signal?.aborted && this.pages >= this.limit)
            await this.wait(undefined, 50);
          if (next >= items.length) return;
          const item = items[next++]!;
          this.pages++;
          try {
            await work(item);
          } catch (error) {
            errors.push(error);
          } finally {
            this.pages--;
            this.wake();
          }
        }
      }),
    );
    if (errors.length) throw errors[0];
  }
}
