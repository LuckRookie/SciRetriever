import type { DurableCandidate } from "@sciretriever/contracts";

/** One file-validated candidate retained for a single Browser operation. */
export interface BrowserCaptureBatchItem {
  readonly transfer_id: string;
  readonly candidate: DurableCandidate;
  readonly accepted: boolean;
}

type Waiter = {
  readonly resolve: (item: BrowserCaptureBatchItem | null) => void;
  readonly reject: (error: unknown) => void;
  readonly signal: AbortSignal;
  readonly abort: () => void;
};

/**
 * Operation-local capture state.
 *
 * A response/download is an observation of a possible PDF, not a terminal Browser
 * result. The batch keeps accepted candidates until the article flow stops, which
 * covers popup/viewer hand-offs and responses that settle after the model action.
 * It never crosses an operation boundary: closing the batch makes late candidates
 * reject admission and lets the owner retire their already-spooled bytes.
 */
export class BrowserCaptureBatch {
  private readonly queue: BrowserCaptureBatchItem[] = [];
  private readonly waiters = new Set<Waiter>();
  private readonly seenHashes = new Set<string>();
  private closed = false;

  constructor(private readonly capacity = 8) {
    if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 64)
      throw new TypeError("invalid Browser capture batch capacity");
  }

  /** Adds a candidate while the operation is live; false means the owner must retire it. */
  add(item: BrowserCaptureBatchItem): boolean {
    if (
      this.closed ||
      this.queue.length >= this.capacity ||
      this.seenHashes.has(item.candidate.sha256)
    )
      return false;
    this.seenHashes.add(item.candidate.sha256);
    const waiter = [...this.waiters][0];
    if (waiter) {
      this.waiters.delete(waiter);
      waiter.signal.removeEventListener("abort", waiter.abort);
      waiter.resolve(item);
      return true;
    }
    this.queue.push(item);
    return true;
  }

  hasCandidate(): boolean {
    return this.queue.length > 0;
  }

  /** Reads the next accepted candidate, waiting until capture or operation close. */
  next(signal: AbortSignal): Promise<BrowserCaptureBatchItem | null> {
    if (signal.aborted) return Promise.reject(new TypeError("cancelled"));
    const item = this.queue.shift();
    if (item) return Promise.resolve(item);
    if (this.closed) return Promise.resolve(null);
    return new Promise<BrowserCaptureBatchItem | null>((resolve, reject) => {
      const waiter: Waiter = {
        resolve,
        reject,
        signal,
        abort: () => {
          this.waiters.delete(waiter);
          reject(new TypeError("cancelled"));
        },
      };
      this.waiters.add(waiter);
      signal.addEventListener("abort", waiter.abort, { once: true });
      if (signal.aborted) waiter.abort();
    });
  }

  /** Closes the operation and returns candidates that were never handed to Intake. */
  close(): readonly BrowserCaptureBatchItem[] {
    if (this.closed) return [];
    this.closed = true;
    const leftovers = this.queue.splice(0);
    for (const waiter of this.waiters) {
      this.waiters.delete(waiter);
      waiter.signal.removeEventListener("abort", waiter.abort);
      waiter.resolve(null);
    }
    return leftovers;
  }
}
