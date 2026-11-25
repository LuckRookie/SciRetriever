import { randomUUID } from "node:crypto";
import {
  EMPTY_METADATA,
  IMPORT_LIMITS,
  type ImportAdapterResult,
  type ImportFile,
  type IntakeBatchItem,
  type IntakeDecision,
} from "@sciretriever/contracts";
import type { SqliteWorker } from "../storage/sqlite/worker.js";
import type { FileStore } from "../storage/files/store.js";
import type { CatalogWriteAdmission } from "../storage/write-admission.js";
import type { ArtifactRecovery } from "../storage/files/recovery.js";
import type { BrowserDownloadResources } from "../browser/resources.js";
import { BrowserTransferCollector } from "../browser/transfer.js";
import {
  acceptPdfFile,
  PdfAcceptanceError,
} from "../acquisition/pdf-acceptance.js";
import { CandidateAbandonmentService } from "../acquisition/candidate-abandonment.js";
import { FileClueReader } from "../literature/file-clues.js";
import { clueArxiv, clueDois } from "../literature/import-clues.js";
import {
  fileRecognitionClues,
  IntakeRecognitionService,
} from "../literature/intake-recognition.js";
import type {
  IntakeItemRead,
  IntakeItemWrite,
  StoredIntakeItem,
} from "../storage/sqlite/intake-items.js";
import type { StoredImportSession } from "../storage/sqlite/import-engine.js";
import {
  ImportSessionError,
  uploadChunks,
  intakeResourceFailure,
} from "./import-files.js";
import { createLogger } from "../logging/index.js";
import { lookupView } from "./intake-lookup-items.js";

export function publicIntakeItem(item: StoredIntakeItem): IntakeBatchItem {
  const {
    batch_id,
    candidate_transfer_id,
    literature_id,
    work,
    retain_until,
    ...value
  } = item;
  void batch_id;
  void candidate_transfer_id;
  void literature_id;
  void work;
  void retain_until;
  const lookup = lookupView(item);
  return lookup ? { ...value, lookup } : value;
}
function suffix(a: string, b: string) {
  const left = a.replace(/\\/gu, "/").toLowerCase().split("/"),
    right = b.toLowerCase().split("/");
  let count = 0;
  while (
    count < Math.min(left.length, right.length) &&
    left[left.length - count - 1] === right[right.length - count - 1]
  )
    count++;
  return count;
}
export function pairIntakeFile(
  reference: ImportFile,
  items: readonly StoredIntakeItem[],
  sizes: ReadonlyMap<string, number>,
) {
  const paths = items
    .filter((i) => i.work?.relative_path)
    .map((i) => ({
      item: i,
      count: suffix(reference.external_id, i.work!.relative_path!),
    }));
  const best = Math.max(0, ...paths.map((p) => p.count));
  const found = paths.filter((p) => p.count === best && best > 0);
  if (found.length === 1) return found[0]!.item;
  const names = items.filter(
    (i) => i.file_name?.toLowerCase() === reference.file_name.toLowerCase(),
  );
  return names.length === 1 &&
    (reference.size_bytes === null ||
      reference.size_bytes === undefined ||
      sizes.get(names[0]!.item_id) === reference.size_bytes)
    ? names[0]!
    : null;
}
export class IntakeFileItems {
  private readonly logger = createLogger("intake-file-items");
  readonly transfers: BrowserTransferCollector;
  private readonly abandonment: CandidateAbandonmentService;
  private readonly recognizing = new Map<
    string,
    { stop: AbortController; promise: Promise<void> }
  >();
  constructor(
    private readonly database: SqliteWorker,
    files: FileStore,
    private readonly writes: CatalogWriteAdmission,
    recovery: ArtifactRecovery,
    resources: BrowserDownloadResources,
    readonly recognition: IntakeRecognitionService,
    private readonly clues = new FileClueReader(),
    private readonly now = Date.now,
  ) {
    this.transfers = new BrowserTransferCollector(files, database, resources);
    this.abandonment = new CandidateAbandonmentService(
      database,
      this.transfers,
      recovery,
      writes,
    );
  }
  async read<T>(query: IntakeItemRead): Promise<T> {
    const r = await this.database.run<{ ok: boolean; value: T; code?: string }>(
      { kind: "import_read", action: { op: "items-read", query } },
    );
    if (!r.ok) throw new ImportSessionError(r.code ?? "intake-unavailable");
    return r.value;
  }
  async write<T = unknown>(action: IntakeItemWrite): Promise<T> {
    const r = await this.database.run<{ ok: boolean; value: T; code?: string }>(
      { kind: "import_write", action: { op: "items-write", action } },
    );
    if (!r.ok) throw new ImportSessionError(r.code ?? "intake-unavailable");
    return r.value;
  }
  async receive(
    s: StoredImportSession,
    fileName: string,
    relativePath: string | null,
    chunks: AsyncIterable<Uint8Array>,
    signal: AbortSignal,
    pageItem?: StoredIntakeItem,
  ) {
    if (!pageItem && s.record_count >= IMPORT_LIMITS.records)
      throw new ImportSessionError("intake-batch-limit");
    if (
      (pageItem
        ? s.state !== "running"
        : !["collecting", "awaiting-confirmation"].includes(s.state)) ||
      s.metadata_only
    )
      throw new ImportSessionError("intake-batch-state");
    const itemId = pageItem?.item_id ?? randomUUID(),
      transferId = `intake-${randomUUID()}`,
      now = new Date(this.now()).toISOString();
    let retained = false,
      completed = false;
    try {
      await this.transfers.begin(
        transferId,
        Number.MAX_SAFE_INTEGER,
        {
          session_id: s.batch_id,
          article_id: itemId,
          page_id: itemId,
          document_generation: 0,
          source_url: "https://sciretriever.local/intake",
          captured_at: now,
        },
        "import",
        null,
        signal,
      );
      for await (const chunk of uploadChunks(chunks, signal))
        if (chunk.length) await this.transfers.append(transferId, chunk);
      let reason: string | null = null;
      try {
        await this.transfers.withStaged(transferId, (file) =>
          acceptPdfFile(file, 10000, signal),
        );
      } catch (error) {
        if (!(error instanceof PdfAcceptanceError) || error.cause) throw error;
        reason = error.reason;
      }
      signal.throwIfAborted();
      if (!reason) {
        await this.transfers.complete(transferId);
        completed = true;
      }
      const item = pageItem
        ? await this.writes.run(() => {
            signal.throwIfAborted();
            return this.write<StoredIntakeItem>({
              kind: "attach",
              batch_id: s.batch_id,
              item_id: itemId,
              transfer_id: reason ? null : transferId,
              work: { ...pageItem.work!, reason },
            });
          })
        : await this.writes.run(() => {
            signal.throwIfAborted();
            return this.write<StoredIntakeItem>({
              kind: "put",
              now,
              item: {
                item_id: itemId,
                batch_id: s.batch_id,
                origin: "file",
                sequence: null,
                record_index: null,
                external_id: itemId,
                title: fileName.replace(/\.[^.]+$/u, ""),
                file_name: fileName,
                candidate_transfer_id: reason ? null : transferId,
                recognition: null,
                possible_duplicates: [],
                unpaired: s.format !== "file",
                needs_decision: s.format !== "file",
                decision: null,
                disposition: reason ? "rejected" : null,
                literature_id: null,
                decided_by: null,
                decided_at: null,
                work: {
                  relative_path: relativePath,
                  paired_to: null,
                  clues: null,
                  result: null,
                  reason,
                  source_url: null,
                },
              },
            });
          });
      retained = true;
      if (signal.aborted) {
        await this.cleanup(s.batch_id, itemId);
        signal.throwIfAborted();
      }
      return publicIntakeItem(item);
    } catch (error) {
      throw intakeResourceFailure(error);
    } finally {
      if (!completed) await this.transfers.discard(transferId);
      else if (!retained) {
        const c = await this.transfers.recover(transferId);
        if (c)
          await this.abandonment.abandon({
            article_id: itemId,
            transfer_id: transferId,
            sha256: c.sha256,
          });
      }
    }
  }
  async prepare(
    s: StoredImportSession,
    decoded: Map<number, ImportAdapterResult>,
  ) {
    let items = (
      await this.read<StoredIntakeItem[]>({ kind: "all", batch_id: s.batch_id })
    ).filter((i) => i.origin === "file");
    const sizes = new Map<string, number>();
    for (const item of items)
      if (item.candidate_transfer_id) {
        const c = await this.transfers.recover(item.candidate_transfer_id);
        if (c) sizes.set(item.item_id, c.size_bytes);
      }
    const paired = new Map<string, StoredIntakeItem>(),
      assignments = new Map<string, string>(),
      // A file-only record (a source's standalone PDF) gives its delivered
      // file the record's place: the file stays a file-only item, included.
      released = new Map<string, string>();
    if (!s.metadata_only)
      for (const data of decoded.values())
        for (const value of data.items)
          if (value.record) {
            const ref = value.record.files.find(
              (f) => f.preferred && f.media_type === "application/pdf",
            );
            if (!ref) continue;
            const item = pairIntakeFile(
              ref,
              items.filter(
                (i) => !i.work?.reason && !assignments.has(i.item_id),
              ),
              sizes,
            );
            if (item) {
              assignments.set(item.item_id, value.record.external_id);
              if (value.record.file_only)
                released.set(value.record.external_id, item.item_id);
              else paired.set(value.record.external_id, item);
            }
          }
    const releasedItems = new Set(released.values());
    for (const item of items)
      if (item.work) {
        const own = releasedItems.has(item.item_id),
          paired_to = own ? null : (assignments.get(item.item_id) ?? null),
          unpaired = !own && !paired_to && s.format !== "file";
        if (item.work.paired_to !== paired_to || item.unpaired !== unpaired)
          await this.writes.run(() =>
            this.write({
              kind: "update",
              batch_id: s.batch_id,
              item_id: item.item_id,
              work: { ...item.work!, paired_to },
              unpaired,
              needs_decision:
                unpaired &&
                item.decision?.kind !== "include" &&
                !item.work?.included &&
                item.decision?.kind !== "exclude",
              now: new Date(this.now()).toISOString(),
            }),
          );
      }
    items = (
      await this.read<StoredIntakeItem[]>({ kind: "all", batch_id: s.batch_id })
    ).filter((i) => i.origin === "file");
    const standalone = items.filter((i) => !i.work?.paired_to);
    if (standalone.length)
      decoded.set(IMPORT_LIMITS.parts, {
        groups: [],
        excluded: [],
        items: standalone.map((item, record_index) => {
          const reason =
            item.work?.reason ??
            (item.decision?.kind === "exclude"
              ? "excluded"
              : item.unpaired &&
                  item.decision?.kind !== "include" &&
                  !item.work?.included
                ? "unpaired-file"
                : null);
          const metadata = item.work?.result?.metadata ?? {
            ...EMPTY_METADATA,
            title: item.title,
          };
          return {
            record_index,
            external_id: item.item_id,
            reason,
            record: reason
              ? null
              : {
                  external_id: item.item_id,
                  metadata,
                  source_type: null,
                  groups: [],
                  user_tags: [],
                  annotations: [],
                  files: [
                    {
                      external_id: item.item_id,
                      file_name: item.file_name!,
                      media_type: "application/pdf",
                      preferred: true,
                      size_bytes: sizes.get(item.item_id) ?? null,
                      sha256: null,
                    },
                  ],
                },
          };
        }),
      });
    return { items, paired, standalone, released };
  }
  progress(items: readonly StoredIntakeItem[]) {
    const eligible = items.filter(
      (i) =>
        !i.work?.reason &&
        !i.work?.paired_to &&
        (!i.unpaired ||
          i.decision?.kind === "include" ||
          i.work?.included === true),
    );
    return {
      state: this.recognizing.has(items[0]?.batch_id ?? "")
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
  start(s: StoredImportSession, items: readonly StoredIntakeItem[]) {
    if (this.recognizing.has(s.batch_id)) return;
    const pending = items.filter(
      (i) =>
        i.work &&
        !i.work.reason &&
        !i.work.paired_to &&
        (!i.unpaired ||
          i.decision?.kind === "include" ||
          i.work?.included === true) &&
        (!i.work.result || i.recognition?.state === "cancelled"),
    );
    if (!pending.length) return;
    const stop = new AbortController();
    const promise = new Promise<void>((resolve) => setImmediate(resolve))
      .then(async () => {
        for (const item of pending) {
          if (stop.signal.aborted) break;
          const candidate = item.candidate_transfer_id
            ? await this.transfers.recover(item.candidate_transfer_id)
            : null;
          if (!candidate) throw new ImportSessionError("intake-file-missing");
          const clues =
            item.work?.clues ??
            (await this.transfers.withCandidate(candidate, (file) =>
              this.clues.read(file, item.file_name!, stop.signal),
            ));
          const input = fileRecognitionClues(clues);
          let result;
          try {
            result = await this.recognition.recognize(input, stop.signal);
          } catch (error) {
            if (stop.signal.aborted) break;
            result = this.recognition.fallback(input);
            void error;
          }
          if (stop.signal.aborted) break;
          await this.writes.run(() =>
            this.write({
              kind: "update",
              batch_id: s.batch_id,
              item_id: item.item_id,
              work: { ...item.work!, clues, result },
              needs_decision: result.recognition.state === "candidates",
              now: new Date(this.now()).toISOString(),
            }),
          );
        }
      })
      .finally(() => this.recognizing.delete(s.batch_id));
    this.recognizing.set(s.batch_id, { stop, promise });
    void promise.catch(() =>
      this.logger.warn(
        "Recognition work interrupted; a later preview may retry",
      ),
    );
  }
  async cancel(s: StoredImportSession) {
    const current = this.recognizing.get(s.batch_id);
    current?.stop.abort();
    if (current) await current.promise.catch(() => undefined);
    const items = await this.read<StoredIntakeItem[]>({
      kind: "all",
      batch_id: s.batch_id,
    });
    for (const i of items)
      if (
        i.origin === "file" &&
        i.work &&
        !i.work.result &&
        !i.work.reason &&
        !i.work.paired_to &&
        ["collecting", "awaiting-confirmation", "running"].includes(s.state)
      ) {
        const input = {
          identifiers: [],
          titles: [],
          text: "",
          corroboration: "",
          fallback: i.title ?? i.file_name ?? "document",
        };
        await this.writes.run(() =>
          this.write({
            kind: "update",
            batch_id: s.batch_id,
            item_id: i.item_id,
            work: {
              ...i.work!,
              result: this.recognition.fallback(input, "cancelled"),
            },
            now: new Date(this.now()).toISOString(),
          }),
        );
      }
  }
  async decide(
    s: StoredImportSession,
    itemId: string,
    decision: IntakeDecision,
    actor: string,
  ) {
    if (!["collecting", "awaiting-confirmation"].includes(s.state))
      throw new ImportSessionError("intake-batch-state");
    const item = await this.read<StoredIntakeItem>({
      kind: "one",
      batch_id: s.batch_id,
      item_id: itemId,
    });
    if (!item.work || item.work.paired_to)
      throw new ImportSessionError("intake-decision-invalid");
    let work = item.work;
    if (decision.kind === "include" || decision.kind === "exclude")
      work = { ...work, included: decision.kind === "include" };
    if (decision.kind === "candidate") {
      const candidate = work.result?.candidates.find(
        (c) => c.candidate_id === decision.candidate_id,
      );
      if (!candidate) throw new ImportSessionError("intake-decision-invalid");
      work = {
        ...work,
        result: {
          ...work.result!,
          metadata: candidate.observation.metadata,
          observation: candidate.observation,
          recognition: { ...work.result!.recognition, state: "recognized" },
        },
      };
    } else if (decision.kind === "unrecognized") {
      if (!work.clues) throw new ImportSessionError("intake-decision-invalid");
      work = {
        ...work,
        result: this.recognition.fallback(fileRecognitionClues(work.clues)),
      };
    } else if (
      !["include", "exclude"].includes(decision.kind) ||
      !item.unpaired
    )
      throw new ImportSessionError("intake-decision-invalid");
    return publicIntakeItem(
      await this.writes.run(() =>
        this.write<StoredIntakeItem>({
          kind: "update",
          batch_id: s.batch_id,
          item_id: itemId,
          decision,
          actor,
          work,
          needs_decision: false,
          now: new Date(this.now()).toISOString(),
        }),
      ),
    );
  }
  async cleanup(batchId: string, itemId?: string, preservePending = false) {
    const items = await this.read<StoredIntakeItem[]>({
      kind: "all",
      batch_id: batchId,
    });
    const pendingFiles = new Set(
      preservePending
        ? await this.read<string[]>({
            kind: "pending-resolution-files",
            batch_id: batchId,
            now: new Date(this.now()).toISOString(),
          })
        : [],
    );
    const kept = new Set(
      items
        .filter(
          (i) =>
            preservePending &&
            (i.disposition === "pending-decision" ||
              pendingFiles.has(i.item_id)) &&
            !!i.work?.record &&
            !!i.retain_until &&
            i.retain_until > new Date(this.now()).toISOString(),
        )
        .flatMap((i) => [
          i.item_id,
          ...(i.work?.retained_item_id ? [i.work.retained_item_id] : []),
        ]),
    );
    for (const item of items) {
      if (itemId && item.item_id !== itemId) continue;
      if (kept.has(item.item_id)) continue;
      const transferId =
        item.candidate_transfer_id ?? item.work?.retiring_transfer_id;
      if (!transferId) continue;
      const candidate = await this.transfers.recover(transferId);
      await this.writes.run(() =>
        this.write({
          kind: "detach",
          batch_id: batchId,
          item_id: item.item_id,
        }),
      );
      if (candidate)
        await this.abandonment.abandon({
          article_id: item.item_id,
          transfer_id: candidate.transfer_id,
          sha256: candidate.sha256,
        });
      await this.writes.run(() =>
        this.write({
          kind: "retired",
          batch_id: batchId,
          item_id: item.item_id,
        }),
      );
    }
    // A process can stop after a transfer commits but before its item is linked.
    // The immutable capture scope also owns these unpublished orphan candidates.
    const orphans = await this.read<
      import("@sciretriever/contracts").DurableCandidate[]
    >({
      kind: "batch-candidates",
      batch_id: batchId,
      ...(itemId ? { item_id: itemId } : {}),
    });
    for (const candidate of orphans)
      if (candidate.capture && !kept.has(candidate.capture.article_id))
        await this.abandonment.abandon({
          article_id: candidate.capture.article_id,
          transfer_id: candidate.transfer_id,
          sha256: candidate.sha256,
        });
  }
  async recognizeItem(item: StoredIntakeItem, signal: AbortSignal) {
    if (!item.candidate_transfer_id)
      throw new ImportSessionError("intake-file-missing");
    const candidate = await this.transfers.recover(item.candidate_transfer_id);
    if (!candidate) throw new ImportSessionError("intake-file-missing");
    const clues = await this.transfers.withCandidate(candidate, (file) =>
      this.clues.read(file, item.file_name!, signal),
    );
    const input = fileRecognitionClues(clues);
    return this.recognition.recognize(
      {
        ...input,
        identifiers: input.identifiers.length
          ? input.identifiers
          : item.work?.url_identifiers?.length
            ? item.work.url_identifiers
            : item.work?.page
              ? [
                  ...clueDois(item.work.page.url),
                  ...clueArxiv(item.work.page.url),
                ]
              : [],
      },
      signal,
    );
  }
  async close() {
    for (const r of this.recognizing.values()) r.stop.abort();
    await Promise.allSettled(
      [...this.recognizing.values()].map((r) => r.promise),
    );
  }
}
