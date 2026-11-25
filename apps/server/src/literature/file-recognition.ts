import {
  parseLiteratureId,
  type ArtifactRef,
  type Asset,
  type LiteratureRecognizeResult,
  type LiteratureRecognizeSkipReason,
} from "@sciretriever/contracts";
import type { SqliteWorker } from "../storage/sqlite/worker.js";
import type {
  IntakeItemRead,
  RecognitionState,
} from "../storage/sqlite/intake-items.js";
import type { ScopedFileReader } from "../storage/files/reader.js";
import type { ArtifactReadOptions } from "../storage/files/reader.js";
import type { LiteratureIdentityService } from "./identity.js";
import { cluesUnreadReason, type FileClueReader } from "./file-clues.js";
import {
  fileRecognitionClues,
  type IntakeRecognitionService,
  type RecognitionResult,
} from "./intake-recognition.js";
import { adoptRecognition } from "./recognition-adoption.js";

export interface RecognitionFiles {
  withVerifiedFile<T>(
    reference: string,
    expected: ArtifactRef,
    consume: (file: ScopedFileReader) => Promise<T>,
    options?: ArtifactReadOptions,
  ): Promise<T>;
}

/**
 * Re-reads a marked literature's saved primary PDF and recognizes it with the
 * intake rules and sources (6.4.6 steps 1-3); the outcome is adopted as 8.4
 * describes. It never calls a model. One literature's failure is its own.
 */
export class LiteratureFileRecognitionService {
  constructor(
    private readonly database: SqliteWorker,
    private readonly files: RecognitionFiles,
    private readonly identity: LiteratureIdentityService,
    private readonly recognition: IntakeRecognitionService,
    private readonly clues: FileClueReader,
  ) {}
  private async read<T>(query: IntakeItemRead): Promise<T> {
    const r = await this.database.run<{ ok: boolean; value: T; code?: string }>(
      { kind: "import_read", action: { op: "items-read", query } },
    );
    if (!r.ok)
      throw Object.assign(new Error("recognition read failed"), {
        code: r.code ?? "intake-unavailable",
      });
    return r.value;
  }
  /** Marked literatures with a primary PDF, live (not deleted or withdrawn), in ID order. */
  needsMetadata(limit: number): Promise<string[]> {
    return this.read({ kind: "needs-pdf-literatures", limit });
  }
  async recognize(
    value: string,
    signal: AbortSignal,
  ): Promise<LiteratureRecognizeResult> {
    signal.throwIfAborted();
    const literature_id = parseLiteratureId(value);
    const skipped = (reason: LiteratureRecognizeSkipReason) =>
      ({
        literature_id,
        outcome: "skipped",
        reason,
        title_replaced: false,
      }) as const;
    const state = await this.read<RecognitionState | null>({
      kind: "recognition-state",
      literature_id,
    });
    if (!state) return skipped("missing");
    if (state.trashed) return skipped("trashed");
    if (state.withdrawn) return skipped("withdrawn");
    if (!state.needs_metadata) return skipped("not-marked");
    const facts = await this.database.currentFacts(literature_id);
    const asset: Asset | null = facts?.primary_asset ?? null;
    if (!asset) return skipped("no-pdf");
    const located = await this.database.locateArtifact(asset);
    if (!located)
      return {
        literature_id,
        outcome: "unread",
        reason: "reader-failed",
        title_replaced: false,
      };
    let clues;
    try {
      clues = await this.files.withVerifiedFile(
        located.reference,
        located.artifact,
        (file) =>
          this.clues.read(
            file,
            state.file_name ?? `${literature_id}.pdf`,
            signal,
          ),
        { signal },
      );
    } catch (error) {
      if (signal.aborted) throw error;
      // The stored bytes did not verify or could not be opened.
      return {
        literature_id,
        outcome: "unread",
        reason: "reader-failed",
        title_replaced: false,
      };
    }
    signal.throwIfAborted();
    const input = fileRecognitionClues(clues);
    const unread = cluesUnreadReason(clues);
    // An image-only PDF can still carry a DOI or title in its metadata; only a
    // read with nothing to look up is counted as unread.
    if (
      unread &&
      (unread !== "image-only" ||
        (!input.identifiers.length && !input.titles.length))
    )
      return {
        literature_id,
        outcome: "unread",
        reason: unread,
        title_replaced: false,
      };
    let result: RecognitionResult;
    try {
      result = await this.recognition.recognize(input, signal);
    } catch (error) {
      if (signal.aborted) throw error;
      result = this.recognition.fallback(input);
    }
    signal.throwIfAborted();
    // Not identified and no title inside the PDF: the temporary title stays.
    if (!result.observation && !input.titles.length)
      return {
        literature_id,
        outcome:
          result.recognition.state === "candidates"
            ? "candidates"
            : "unrecognized",
        reason: null,
        title_replaced: false,
      };
    const adoption = await adoptRecognition(
      this.database,
      this.identity,
      literature_id,
      // A background task has nobody to choose a candidate; the PDF's own title is used.
      result,
      {
        source_name: "file-recognition",
        observation_prefix: "file-recognition",
        source_record_id: asset.asset_id,
        input_sha256: asset.sha256,
        title: input.titles[0] ?? input.fallback,
      },
      signal,
    );
    if (adoption.status === "conflict")
      return {
        literature_id,
        outcome: "conflict",
        reason: adoption.reason,
        title_replaced: false,
      };
    return {
      literature_id,
      outcome: adoption.recognized
        ? "recognized"
        : result.recognition.state === "candidates"
          ? "candidates"
          : adoption.title_changed
            ? "title-replaced"
            : "unrecognized",
      reason: null,
      title_replaced: !adoption.recognized && adoption.title_changed,
    };
  }
}
