import {
  EMPTY_METADATA,
  IMPORT_LIMITS,
  parseLiteratureId,
  parseLiteratureMetadata,
  type ImportAdapterItem,
  type ImportAdapterResult,
  type IntakeDecision,
  type IntakeLookupItem,
  type IntakeLookupSummary,
  type LiteratureMetadata,
} from "@sciretriever/contracts";
import type { CatalogWriteAdmission } from "../storage/write-admission.js";
import type { StoredImportSession } from "../storage/sqlite/import-engine.js";
import type {
  IntakeItemWork,
  StoredIntakeItem,
} from "../storage/sqlite/intake-items.js";
import type {
  IntakeRecognitionService,
  RecognitionResult,
} from "../literature/intake-recognition.js";
import { createLogger } from "../logging/index.js";
import { ImportSessionError } from "./import-files.js";
import { intakeDigest } from "./intake-digest.js";
import type { IntakeFileItems } from "./intake-file-items.js";

/** Lines not admitted without a decision; they are reported as excluded. */
export const LOOKUP_NOT_ADMITTED = new Set([
  "duplicate-line",
  "lookup-candidates",
  "lookup-unrecognized",
  "lookup-pending",
]);
export const lookupItemId = (
  batchId: string,
  sequence: number,
  recordIndex: number,
) => intakeDigest(["intake-item", batchId, sequence, recordIndex], "uuid");

/** What a page shows for one `lookup` line while its batch is open. */
export function lookupView(item: StoredIntakeItem): IntakeLookupItem | null {
  const line = item.work?.lookup;
  if (!line) return null;
  const result = item.work?.result ?? null,
    state = result?.recognition.state;
  const found = state === "recognized" ? result!.metadata : null;
  return {
    line: line.line,
    text: line.text,
    kind: line.kind,
    reason: line.reason,
    outcome:
      line.reason === "duplicate-line"
        ? "duplicate"
        : line.reason
          ? "rejected"
          : !result
            ? "pending"
            : state === "recognized"
              ? result.recognition.literature_id
                ? "existing"
                : "recognized"
              : state === "candidates"
                ? "candidates"
                : "unrecognized",
    included: item.work?.included === true,
    found: found
      ? {
          title: found.title,
          first_author: found.authors[0]?.display_name ?? null,
          publication_year: found.publication_year,
          identifiers: found.identifiers,
        }
      : null,
  };
}
/**
 * Line counts. Preview counts "existing" from the recognition's library match;
 * a report counts it from the admitted disposition.
 */
export function lookupSummary(
  items: readonly StoredIntakeItem[],
  admitted = false,
): IntakeLookupSummary {
  const summary = {
    lines: 0,
    recognized: 0,
    existing: 0,
    candidates: 0,
    unrecognized: 0,
    included: 0,
    rejected: 0,
    duplicates: 0,
    pending: 0,
  };
  for (const item of items) {
    const line = item.work?.lookup;
    if (!line) continue;
    summary.lines++;
    const result = item.work?.result;
    if (line.reason === "duplicate-line") summary.duplicates++;
    else if (line.reason) summary.rejected++;
    else if (!result) summary.pending++;
    else if (result.recognition.state === "recognized") {
      if (
        admitted
          ? item.disposition === "matched" ||
            item.disposition === "enriched" ||
            item.disposition === "restored"
          : !!result.recognition.literature_id
      )
        summary.existing++;
      else summary.recognized++;
    } else if (result.recognition.state === "candidates") summary.candidates++;
    else {
      summary.unrecognized++;
      if (item.work?.included === true) summary.included++;
    }
  }
  return summary;
}
/** The bibliography a line keeps when nothing is recognized. */
export function lookupGiven(work: IntakeItemWork): LiteratureMetadata {
  const seed = work.record!.metadata,
    id = seed.identifiers[0];
  // Only a DOI may stand without a title (metadata acceptance); arXiv and
  // PMID lines keep their text as a temporary title marked needs-metadata.
  return parseLiteratureMetadata({
    ...EMPTY_METADATA,
    identifiers: seed.identifiers,
    title:
      seed.title ?? (id && id.namespace !== "doi" ? work.lookup!.text : null),
  });
}
/** Step 1: the identifier names a paper of this library; no source is asked. */
function libraryMatch(
  literatureId: string,
  metadata: LiteratureMetadata,
): RecognitionResult {
  return {
    recognition: {
      state: "recognized",
      step: 1,
      literature_id: parseLiteratureId(literatureId),
      candidates: [],
    },
    metadata,
    observation: null,
    candidates: [],
  };
}
/** The library paper a line was matched to in step 1, admitted as a member only. */
export function lookupLibraryMatch(
  result: RecognitionResult | null | undefined,
) {
  return result?.recognition.state === "recognized" &&
    result.recognition.step === 1 &&
    result.observation === null
    ? result.recognition.literature_id
    : null;
}
function recognitionPending(item: StoredIntakeItem) {
  return (
    !!item.work?.lookup &&
    !item.work.lookup.reason &&
    (!item.work.result || item.work.result.recognition.state === "cancelled") &&
    !item.decision
  );
}

/**
 * Recognition, decisions and admission records for `lookup` lines
 * (literature materials 6.4.12). It shares the item store, the recognition
 * service and the progress and cancellation semantics of file items.
 */
export class IntakeLookupItems {
  private readonly logger = createLogger("intake-lookup-items");
  private readonly recognizing = new Map<
    string,
    { stop: AbortController; promise: Promise<void> }
  >();
  constructor(
    private readonly items: IntakeFileItems,
    private readonly writes: CatalogWriteAdmission,
    private readonly recognition: IntakeRecognitionService,
    private readonly now: () => number,
    /**
     * The paper this identifier line names when it is already in the library,
     * by the identity rules (deleted and withdrawn papers included).
     */
    private readonly library: (
      s: StoredImportSession,
      work: IntakeItemWork,
    ) => Promise<{
      readonly literature_id: string;
      readonly metadata: LiteratureMetadata;
    } | null> = async () => null,
  ) {}
  /** Stage every decoded line and return the stored lookup items by item ID. */
  async stage(
    s: StoredImportSession,
    decoded: ReadonlyMap<number, ImportAdapterResult>,
  ) {
    const sequences = [...decoded.keys()].filter(
        (sequence) => sequence !== IMPORT_LIMITS.parts,
      ),
      staged: StoredIntakeItem[] = [];
    for (const sequence of sequences)
      for (const value of decoded.get(sequence)!.items)
        staged.push({
          item_id: lookupItemId(s.batch_id, sequence, value.record_index),
          batch_id: s.batch_id,
          origin: "data",
          sequence,
          record_index: value.record_index,
          external_id: value.external_id ?? null,
          title: value.record?.metadata.title ?? null,
          file_name: null,
          candidate_transfer_id: null,
          recognition: null,
          possible_duplicates: [],
          unpaired: false,
          needs_decision: false,
          decision: null,
          disposition: null,
          literature_id: null,
          decided_by: null,
          decided_at: null,
          work: {
            relative_path: null,
            paired_to: null,
            clues: null,
            result: null,
            reason: null,
            source_url: null,
            ...(value.record ? { record: value.record } : {}),
            lookup: {
              line: value.record_index + 1,
              text: value.external_id ?? "",
              kind: value.record
                ? ((value.record.metadata.identifiers[0]?.namespace ??
                    "title") as "doi" | "arxiv" | "pmid" | "title")
                : null,
              reason: value.record
                ? null
                : (value.reason as NonNullable<
                    NonNullable<IntakeItemWork["lookup"]>["reason"]
                  >),
            },
          },
        });
    if (sequences.length)
      await this.writes.run(() =>
        this.items.write({
          kind: "lookup-stage",
          batch_id: s.batch_id,
          sequences,
          items: staged,
          now: new Date(this.now()).toISOString(),
        }),
      );
    return this.read(s.batch_id);
  }
  async read(batchId: string) {
    return new Map(
      (
        await this.items.read<StoredIntakeItem[]>({
          kind: "all",
          batch_id: batchId,
        })
      )
        .filter((i) => i.origin === "data" && i.work?.lookup)
        .map((i) => [i.item_id, i]),
    );
  }
  /** Replace a line's given identifier or title by what recognition and decisions settled. */
  adapterItem(
    batchId: string,
    sequence: number,
    value: ImportAdapterItem,
    stored: ReadonlyMap<string, StoredIntakeItem>,
  ): ImportAdapterItem {
    if (!value.record) return value;
    const item = stored.get(
        lookupItemId(batchId, sequence, value.record_index),
      ),
      result = item?.work?.result;
    if (!item || !result)
      return { ...value, record: null, reason: "lookup-pending" };
    const admitted = {
      ...value,
      record: { ...value.record, metadata: result.metadata },
    };
    if (result.recognition.state === "recognized") return admitted;
    if (item.decision?.kind === "exclude")
      return { ...value, record: null, reason: "excluded" };
    if (item.work?.included === true) return admitted;
    return {
      ...value,
      record: null,
      reason:
        result.recognition.state === "candidates"
          ? "lookup-candidates"
          : "lookup-unrecognized",
    };
  }
  pending(items: Iterable<StoredIntakeItem>) {
    for (const item of items)
      if (item.work?.lookup && !item.work.lookup.reason && !item.work.result)
        return true;
    return false;
  }
  progress(batchId: string, items: Iterable<StoredIntakeItem>) {
    const eligible = [...items].filter(
      (i) => i.work?.lookup && !i.work.lookup.reason,
    );
    return {
      state: this.recognizing.has(batchId)
        ? ("running" as const)
        : eligible.some((i) => i.recognition?.state === "cancelled")
          ? ("cancelled" as const)
          : eligible.every((i) => i.work?.result)
            ? ("done" as const)
            : ("idle" as const),
      recognized: eligible.filter((i) => i.work?.result).length,
      total: eligible.length,
    };
  }
  start(s: StoredImportSession, items: Iterable<StoredIntakeItem>) {
    if (this.recognizing.has(s.batch_id)) return;
    const pending = [...items].filter(recognitionPending);
    if (!pending.length) return;
    const stop = new AbortController();
    const promise = new Promise<void>((resolve) => setImmediate(resolve))
      .then(async () => {
        for (const item of pending) {
          if (stop.signal.aborted) break;
          const work = item.work!,
            seed = work.record!.metadata,
            fallback = lookupGiven(work),
            identifier = seed.identifiers[0];
          let result: RecognitionResult;
          try {
            const known = identifier ? await this.library(s, work) : null;
            result = known
              ? libraryMatch(known.literature_id, known.metadata)
              : await this.recognition.recognizeNamed(
                  identifier ? { identifier } : { title: seed.title! },
                  fallback,
                  stop.signal,
                );
          } catch {
            if (stop.signal.aborted) break;
            result = this.recognition.unrecognized(fallback);
          }
          if (stop.signal.aborted) break;
          await this.writes.run(async () => {
            // A decision may have arrived after the snapshot; keep it.
            const current = await this.items.read<StoredIntakeItem>({
              kind: "one",
              batch_id: s.batch_id,
              item_id: item.item_id,
            });
            if (!recognitionPending(current)) return;
            await this.items.write({
              kind: "update",
              batch_id: s.batch_id,
              item_id: item.item_id,
              work: { ...current.work!, result },
              needs_decision: result.recognition.state === "candidates",
              now: new Date(this.now()).toISOString(),
            });
          });
        }
      })
      .finally(() => this.recognizing.delete(s.batch_id));
    this.recognizing.set(s.batch_id, { stop, promise });
    void promise.catch(() =>
      this.logger.warn(
        "Lookup recognition interrupted; a later preview may retry",
      ),
    );
  }
  /** Local synchronous entries wait for the recognition a preview started. */
  async wait(batchId: string) {
    await this.recognizing.get(batchId)?.promise.catch(() => undefined);
  }
  async cancel(s: StoredImportSession) {
    const current = this.recognizing.get(s.batch_id);
    current?.stop.abort();
    if (current) await current.promise.catch(() => undefined);
    if (!["collecting", "awaiting-confirmation", "running"].includes(s.state))
      return;
    for (const item of (await this.read(s.batch_id)).values())
      if (item.work?.lookup && !item.work.lookup.reason && !item.work.result)
        await this.writes.run(() =>
          this.items.write({
            kind: "update",
            batch_id: s.batch_id,
            item_id: item.item_id,
            work: {
              ...item.work!,
              result: this.recognition.unrecognized(
                lookupGiven(item.work!),
                "cancelled",
              ),
            },
            now: new Date(this.now()).toISOString(),
          }),
        );
  }
  /**
   * candidate adopts a listed candidate; unrecognized rejects them; include
   * or exclude decide whether an unrecognized line is added as given. Any of
   * the last three settles the line as unrecognized, keeping the candidates.
   */
  async decide(
    s: StoredImportSession,
    item: StoredIntakeItem,
    decision: IntakeDecision,
    actor: string,
  ) {
    if (!["collecting", "awaiting-confirmation"].includes(s.state))
      throw new ImportSessionError("intake-batch-state");
    const work = item.work!,
      result = work.result;
    if (work.lookup!.reason || !result)
      throw new ImportSessionError("intake-decision-invalid");
    const state = result.recognition.state;
    let next: IntakeItemWork;
    if (decision.kind === "candidate") {
      const chosen = result.candidates.find(
        (c) => c.candidate_id === decision.candidate_id,
      );
      if (!chosen) throw new ImportSessionError("intake-decision-invalid");
      next = {
        ...work,
        included: false,
        result: {
          ...result,
          metadata: chosen.observation.metadata,
          observation: chosen.observation,
          recognition: {
            ...result.recognition,
            state: "recognized",
            literature_id: null,
          },
        },
      };
    } else if (
      decision.kind === "unrecognized" ||
      decision.kind === "include" ||
      decision.kind === "exclude"
    ) {
      if (
        state === "recognized" &&
        (decision.kind !== "unrecognized" || !result.candidates.length)
      )
        throw new ImportSessionError("intake-decision-invalid");
      next = {
        ...work,
        included: decision.kind === "include",
        result: {
          ...result,
          metadata: lookupGiven(work),
          observation: null,
          recognition: {
            ...result.recognition,
            state: "unrecognized",
            step: 4,
            literature_id: null,
          },
        },
      };
    } else throw new ImportSessionError("intake-decision-invalid");
    return this.writes.run(() =>
      this.items.write<StoredIntakeItem>({
        kind: "update",
        batch_id: s.batch_id,
        item_id: item.item_id,
        decision,
        actor,
        work: next,
        needs_decision: false,
        now: new Date(this.now()).toISOString(),
      }),
    );
  }
  async close() {
    for (const r of this.recognizing.values()) r.stop.abort();
    await Promise.allSettled(
      [...this.recognizing.values()].map((r) => r.promise),
    );
  }
}
