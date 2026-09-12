import type { DurableCandidate } from "@sciretriever/contracts";
import type { BrowserTransferInput } from "../browser/transfers.js";
import { BrowserTransferCollector } from "../browser/transfer.js";
import {
  assessPdfIdentity,
  type PdfIdentityAssessment,
} from "./pdf-evidence.js";

export interface AssessedCandidate {
  readonly candidate: DurableCandidate;
  readonly assessment: PdfIdentityAssessment;
}
export interface IntakeTarget {
  readonly article_id: string;
  readonly identifier: string;
  readonly version: string;
}

/** One immutable article target per intake; late bytes cannot adopt a newer session target. */
export class BrowserCandidateIntake {
  constructor(
    private readonly collector: BrowserTransferCollector,
    private readonly target: IntakeTarget,
    private readonly maxBytes = 16 * 1024 * 1024,
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
    await this.collector.begin(input.transfer_id, this.maxBytes, input.capture);
    try {
      for await (const chunk of input.chunks) {
        check();
        await this.collector.append(input.transfer_id, chunk);
      }
      check();
      const bytes = await this.collector.bytes(input.transfer_id);
      const assessment = await assessPdfIdentity(
        bytes,
        this.target.identifier,
        this.target.version,
        input.signal,
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
    const bytes = await this.collector.candidateBytes(candidate);
    const assessment = await assessPdfIdentity(
      bytes,
      this.target.identifier,
      this.target.version,
      signal,
    );
    return Object.freeze({ candidate, assessment });
  }
}
