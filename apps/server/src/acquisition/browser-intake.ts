import type { DurableCandidate } from "@sciretriever/contracts";
import type { BrowserTransferInput } from "../browser/transfers.js";
import { BrowserTransferCollector } from "../browser/transfer.js";
import { acceptPdfFile, type PdfAcceptance } from "./pdf-acceptance.js";

export interface AssessedCandidate {
  readonly candidate: DurableCandidate;
  readonly assessment: PdfAcceptance;
}
export interface IntakeTarget {
  readonly article_id: string;
  readonly identifier: string;
  /** The concrete version this intake is bound to; late bytes cannot change it. */
  readonly version: string;
}

/** One immutable article target per intake; late bytes cannot adopt a newer session target. */
export class BrowserCandidateIntake {
  constructor(
    private readonly collector: BrowserTransferCollector,
    private readonly target: IntakeTarget,
    private readonly maxBytes = Number.MAX_SAFE_INTEGER,
  ) {}
  async receive(input: BrowserTransferInput): Promise<AssessedCandidate> {
    const check = () => {
      if (
        input.signal.aborted ||
        input.capture.article_id !== this.target.article_id
      )
        throw new Error("candidate intake cancelled or misattributed");
    };
    check();
    await this.collector.begin(
      input.transfer_id,
      this.maxBytes,
      input.capture,
      "browser",
      null,
      input.signal,
    );
    try {
      for await (const chunk of input.chunks) {
        check();
        await this.collector.append(input.transfer_id, chunk);
      }
      check();
      const assessment = await this.collector.withStaged(
        input.transfer_id,
        (file) => acceptPdfFile(file, 10000, input.signal),
        { signal: input.signal },
      );
      check();
      const candidate = await this.collector.complete(input.transfer_id);
      return Object.freeze({ candidate, assessment });
    } catch (error) {
      await this.collector.discard(input.transfer_id);
      throw error;
    }
  }
  async assess(
    candidate: DurableCandidate,
    signal?: AbortSignal,
  ): Promise<AssessedCandidate> {
    if (candidate.capture?.article_id !== this.target.article_id)
      throw new Error("candidate article mismatch");
    const assessment = await this.collector.withCandidate(
      candidate,
      (file) => acceptPdfFile(file, 10000, signal),
      signal ? { signal } : {},
    );
    return Object.freeze({ candidate, assessment });
  }
}
