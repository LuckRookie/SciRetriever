import type {
  AcquisitionAttempt,
  LiteratureId,
  PdfSourceResult,
} from "@sciretriever/contracts";
/** Entry's operation-local submission boundary; it never owns business decisions. */
export type CompletionCommit = <T>(action: () => Promise<T>) => Promise<T>;

export const directCompletionCommit: CompletionCommit = (action) => action();

/** FIFO, drained by its owner before returning the operation report. */
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

export interface CompletionExecution {
  readonly on_pdf_source_result?: (result: PdfSourceResult) => Promise<void>;
  readonly on_acquisition_attempt?: (
    literatureId: LiteratureId,
    attempt: AcquisitionAttempt,
  ) => Promise<void>;
  readonly commit: CompletionCommit;
  /** PDF acquisition remains within the enclosing target worker. */
  readonly acquire: CompletionCommit;
  /** Stable operation epoch; a normal target refill does not invalidate siblings. */
  readonly generation: number;
  readonly operation_id: string;
}
