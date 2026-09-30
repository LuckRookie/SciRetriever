/** Entry's operation-local submission boundary; it never owns business decisions. */
export type CompletionCommit = <T>(action: () => Promise<T>) => Promise<T>;

export const directCompletionCommit: CompletionCommit = (action) => action();

/** FIFO, drained by its owner before releasing the operation's write admission. */
export class CompletionSerialExecutor {
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly signal: AbortSignal) {}

  readonly run: CompletionCommit = <T>(action: () => Promise<T>) => {
    const pending = this.tail.then(() => {
      if (this.signal.aborted)
        throw new DOMException("Completion operation cancelled", "AbortError");
      return action();
    });
    // The caller receives the original rejection. A rejected item must not
    // strand subsequent callers or prevent the operation from draining.
    this.tail = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  };

  async drain(): Promise<void> {
    await this.tail;
  }
}

/**
 * Operation-local cohort lane. Preparation/acquisition can overlap up to the
 * caller's chunk width, while every durable write still uses CompletionSerialExecutor.
 * The lane is intentionally not a global queue: a new operation cannot consume a
 * previous operation's receipts or generation.
 */
export class CompletionCohortExecutor {
  private active = 0;
  private readonly drainWaiters = new Set<() => void>();
  private readonly pending: Array<{
    readonly action: () => Promise<unknown>;
    readonly resolve: (value: unknown) => void;
    readonly reject: (error: unknown) => void;
  }> = [];

  constructor(
    private readonly signal: AbortSignal,
    private readonly maxConcurrency: number,
  ) {
    if (!Number.isSafeInteger(maxConcurrency) || maxConcurrency < 1)
      throw new TypeError("cohort concurrency is invalid");
  }

  readonly run = <T>(action: () => Promise<T>): Promise<T> => {
    if (this.signal.aborted)
      return Promise.reject(
        new DOMException("Completion cohort cancelled", "AbortError"),
      );
    const promise = new Promise<T>((resolve, reject) => {
      this.pending.push({
        action,
        resolve: resolve as (value: unknown) => void,
        reject,
      });
    });
    this.pump();
    return promise;
  };

  private pump(): void {
    while (this.active < this.maxConcurrency && this.pending.length > 0) {
      const next = this.pending.shift()!;
      if (this.signal.aborted) {
        next.reject(
          new DOMException("Completion cohort cancelled", "AbortError"),
        );
        continue;
      }
      this.active += 1;
      void next
        .action()
        .then(next.resolve, next.reject)
        .finally(() => {
          this.active -= 1;
          this.pump();
        });
    }
    this.resolveDrained();
  }

  private resolveDrained(): void {
    if (this.active > 0 || this.pending.length > 0) return;
    for (const resolve of this.drainWaiters) resolve();
    this.drainWaiters.clear();
  }

  async drain(): Promise<void> {
    if (this.active === 0 && this.pending.length === 0) return;
    await new Promise<void>((resolve) => this.drainWaiters.add(resolve));
  }
}

interface CohortWaiter {
  readonly request: PdfAcquisitionRequest;
  readonly resolve: (outcome: PdfAcquisitionOutcome) => void;
  readonly reject: (error: unknown) => void;
}

/**
 * Synchronizes the active targets in one chunk into repeatable acquisition
 * generations. A target that does not need acquisition retires; a target that
 * exhausts a version or cleans NoUsableContent can join the next generation.
 * Tier-terminal outcomes are delivered in frozen participant order.
 */
export class CompletionAcquisitionCoordinator {
  private readonly order = new Map<string, number>();
  private readonly active = new Set<string>();
  private readonly waiting = new Map<string, CohortWaiter>();
  private readonly tasks = new Set<Promise<void>>();
  private generation = 1;
  private running = false;
  private closed = false;

  constructor(
    participantKeys: readonly string[],
    private readonly port: PdfAcquisitionPort | null,
    private readonly signal: AbortSignal,
    private readonly operationId: string,
    private readonly maxConcurrency: number,
  ) {
    if (
      participantKeys.some((key) => typeof key !== "string" || !key) ||
      new Set(participantKeys).size !== participantKeys.length
    )
      throw new TypeError("cohort participants are invalid");
    participantKeys.forEach((key, index) => {
      this.order.set(key, index);
      this.active.add(key);
    });
  }

  request(
    participantKey: string,
    request: PdfAcquisitionRequest,
  ): Promise<PdfAcquisitionOutcome> {
    if (
      this.closed ||
      !this.active.has(participantKey) ||
      this.waiting.has(participantKey)
    )
      return Promise.reject(
        new TypeError("completion cohort participant is unavailable"),
      );
    const result = new Promise<PdfAcquisitionOutcome>((resolve, reject) => {
      this.waiting.set(participantKey, { request, resolve, reject });
    });
    this.pump();
    return result;
  }

  retire(participantKey: string): void {
    this.active.delete(participantKey);
    const waiter = this.waiting.get(participantKey);
    if (waiter && !this.running) {
      this.waiting.delete(participantKey);
      waiter.reject(
        new DOMException("Completion cohort participant retired", "AbortError"),
      );
    }
    this.pump();
  }

  private pump(): void {
    if (
      this.closed ||
      this.running ||
      this.waiting.size === 0 ||
      [...this.active].some((key) => !this.waiting.has(key))
    )
      return;
    const indexed = [...this.active]
      .sort((left, right) => this.order.get(left)! - this.order.get(right)!)
      .map((key) => ({ key, waiter: this.waiting.get(key)! }));
    for (const { key } of indexed) this.waiting.delete(key);
    this.running = true;
    const generation = this.generation;
    const task = this.runGeneration(indexed, generation).finally(() => {
      this.tasks.delete(task);
      this.running = false;
      this.generation += 1;
      this.pump();
    });
    this.tasks.add(task);
  }

  private async runGeneration(
    indexed: readonly { readonly key: string; readonly waiter: CohortWaiter }[],
    generation: number,
  ): Promise<void> {
    const settled = new Set<number>();
    const deliver = (
      outcomes: readonly {
        readonly index: number;
        readonly outcome: PdfAcquisitionOutcome;
      }[],
    ) => {
      for (const { index, outcome } of [...outcomes].sort(
        (left, right) => left.index - right.index,
      )) {
        if (settled.has(index)) continue;
        settled.add(index);
        indexed[index]?.waiter.resolve(outcome);
      }
    };
    const requests = indexed.map(({ waiter }) => ({
      ...waiter.request,
      generation,
      operation_id: this.operationId,
    }));
    try {
      let outcomes: readonly PdfAcquisitionOutcome[];
      if (!this.port)
        throw new TypeError("completion acquisition port is unavailable");
      if (this.port.acquireCohort)
        outcomes = await this.port.acquireCohort(requests, {
          on_outcomes: deliver,
        });
      else {
        const lane = new CompletionCohortExecutor(
          this.signal,
          this.maxConcurrency,
        );
        outcomes = await Promise.all(
          requests.map((request) =>
            lane.run(() => this.port!.acquire(request)),
          ),
        );
        await lane.drain();
      }
      if (outcomes.length !== indexed.length)
        throw new TypeError("completion cohort partition is incomplete");
      deliver(outcomes.map((outcome, index) => ({ index, outcome })));
    } catch (error) {
      indexed.forEach(({ waiter }, index) => {
        if (!settled.has(index)) waiter.reject(error);
      });
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const waiter of this.waiting.values())
      waiter.reject(
        new DOMException("Completion cohort coordinator closed", "AbortError"),
      );
    this.waiting.clear();
    await Promise.allSettled([...this.tasks]);
  }
}

export interface CompletionExecution {
  readonly commit: CompletionCommit;
  /** Bounded PDF cohort lane; its durable acceptance still calls `commit`. */
  readonly acquire: CompletionCommit;
  readonly acquirePdf?: (
    request: PdfAcquisitionRequest,
  ) => Promise<PdfAcquisitionOutcome>;
  /** Generation local to the current operation chunk. */
  readonly generation: number;
  readonly operation_id: string;
}
import type {
  PdfAcquisitionOutcome,
  PdfAcquisitionPort,
  PdfAcquisitionRequest,
} from "./pdf-acquisition.js";
