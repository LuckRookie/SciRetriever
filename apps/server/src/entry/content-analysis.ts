import type { NoUsableContentService } from "./no-usable-content.js";
import {
  parseAnalysisInputIdentity,
  parseLiteratureId,
  type AnalysisInputIdentity,
  type LiteratureContent,
} from "@sciretriever/contracts";
import type { AnalysisResult } from "../analysis/service.js";
import type { LiteratureContentService } from "../literature/content.js";

export interface ContentAnalysisPort {
  analyzeContent(
    literatureId: string,
    signal?: AbortSignal,
  ): Promise<AnalysisResult>;
}
export type ContentAnalysisResult =
  | Awaited<ReturnType<NoUsableContentService["cleanup"]>>
  | {
      readonly outcome: "content_accepted";
      readonly literature_id: string;
      readonly content: LiteratureContent;
    }
  | {
      readonly outcome: "no_usable_content";
      readonly input: AnalysisInputIdentity;
    };
export class ContentAnalysisFailure extends Error {
  constructor(
    readonly code:
      | "content-analysis-closed"
      | "content-analysis-cancelled"
      | "content-analysis-contract",
  ) {
    super("content analysis operation failed");
  }
}

/** Entry composes Analysis proposals with the Literature owner's acceptance transaction. */
export class ContentAnalysisService {
  private readonly stop = new AbortController();
  private readonly active = new Set<Promise<ContentAnalysisResult>>();
  constructor(
    private readonly analysis: ContentAnalysisPort,
    private readonly literature: Pick<LiteratureContentService, "accept">,
    private readonly cleanup?: Pick<NoUsableContentService, "cleanup">,
  ) {}
  analyzeCurrent(
    value: unknown,
    signal?: AbortSignal,
  ): Promise<ContentAnalysisResult> {
    if (this.stop.signal.aborted)
      return Promise.reject(
        new ContentAnalysisFailure("content-analysis-closed"),
      );
    const active = signal
      ? AbortSignal.any([signal, this.stop.signal])
      : this.stop.signal;
    const pending = this.execute(value, active);
    this.active.add(pending);
    void pending.then(
      () => this.active.delete(pending),
      () => this.active.delete(pending),
    );
    return pending;
  }
  private async execute(
    value: unknown,
    signal: AbortSignal,
  ): Promise<ContentAnalysisResult> {
    const id = parseLiteratureId(value);
    const check = () => {
      if (signal.aborted)
        throw new ContentAnalysisFailure("content-analysis-cancelled");
    };
    check();
    const result = await this.analysis.analyzeContent(id, signal);
    check();
    if (result.outcome === "no_usable_content") {
      const input = parseAnalysisInputIdentity(result.input);
      if (input.literature_id !== id)
        throw new ContentAnalysisFailure("content-analysis-contract");
      if (this.cleanup)
        return this.cleanup.cleanup(
          { outcome: "no_usable_content", input },
          signal,
        );
      // Standalone Analysis adapters may return the decision for a separately composed caller.
      return Object.freeze({ outcome: "no_usable_content", input });
    }
    if (result.proposal.literature_id !== id)
      throw new ContentAnalysisFailure("content-analysis-contract");
    const content = await this.literature.accept(
      result.proposal,
      result.markdownBytes,
      signal,
    );
    // Once the Literature transaction starts, report its actual commit even if cancellation races it.
    return Object.freeze({
      outcome: "content_accepted",
      literature_id: id,
      content,
    });
  }
  async close(): Promise<void> {
    this.stop.abort();
    await Promise.allSettled([...this.active]);
  }
}
