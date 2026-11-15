import {
  parseIntakePageSave as parseCaptureSave,
  parseIntakePagePreview,
  parseMetadataObservation,
  parseIntakeBatchId,
  IntakeItemEmptyError,
  type LiteratureMetadata,
  type ImportFileStatus,
  type WebPageData,
  intakeSourceUrl,
  type IntakePageResult as CaptureResult,
  type IntakePageCompletion as CaptureCompletion,
} from "@sciretriever/contracts";
import type { SqliteWorker } from "../storage/sqlite/worker.js";
import type {
  StoredCapture,
  CaptureWrite,
} from "../storage/sqlite/capture-engine.js";
import type { LiteratureIdentityService } from "../literature/identity.js";
import { FolderError, type FolderService } from "../literature/folders.js";
import { SOURCE_TYPE_MAPPING_VERSION } from "../literature/metadata-types.js";
import { decodeWebPage } from "../literature/web-page-adapter.js";
import { clueDois, clueArxiv } from "../literature/import-clues.js";
import type { ImportSessionService } from "./import-sessions.js";
import type { StoredImportSession } from "../storage/sqlite/import-engine.js";
import type { StoredIntakeItem } from "../storage/sqlite/intake-items.js";

export class CaptureError extends Error {
  constructor(readonly code: string) {
    super("Capture request rejected");
  }
}
import { intakeDigest as hash } from "./intake-digest.js";
const id = (value: unknown) => hash(value, "uuid");
export interface CaptureOptions {
  readonly now?: () => number;
  readonly recognizePage?: (
    literatureId: string,
    page: WebPageData,
    signal: AbortSignal,
  ) => Promise<CaptureCompletion>;
}
export class CaptureService {
  private readonly stop = new AbortController();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly saves = new Map<
    string,
    { hash: string; promise: Promise<CaptureResult> }
  >();
  private readonly now: () => number;
  private readonly recognizing = new Set<string>();
  private readonly pdfUploads = new Map<string, Promise<ImportFileStatus>>();
  constructor(
    private readonly database: SqliteWorker,
    private readonly identity: LiteratureIdentityService,
    private readonly folders: FolderService,
    private readonly complete: (
      literatureId: string,
      captureId: string,
      signal: AbortSignal,
    ) => Promise<CaptureCompletion>,
    private readonly options: CaptureOptions = {},
    private readonly intake?: ImportSessionService,
  ) {
    this.now = options.now ?? Date.now;
    intake?.setPagePdfHandler((s, item, chunks, signal) => {
      const previous = this.pdfUploads.get(item.item_id);
      const operation = this.tracked(async () => {
        if (previous) await previous.catch(() => undefined);
        signal.throwIfAborted();
        const current = await this.intake!.fileItems.read<StoredIntakeItem>({
          kind: "one",
          batch_id: s.batch_id,
          item_id: item.item_id,
        });
        if (current.literature_id)
          return this.intake!.upload(s.batch_id, item.item_id, chunks, signal);
        if (current.candidate_transfer_id)
          await this.intake!.fileItems.cleanup(s.batch_id, item.item_id);
        try {
          return await this.receivePdf(s, current, chunks, signal);
        } finally {
          if (signal.aborted)
            await this.intake!.fileItems.cleanup(s.batch_id, item.item_id);
        }
      });
      this.pdfUploads.set(item.item_id, operation);
      const done = () => {
        if (this.pdfUploads.get(item.item_id) === operation)
          this.pdfUploads.delete(item.item_id);
      };
      void operation.then(done, done);
      return operation;
    });
  }
  private tracked<T>(fn: () => Promise<T>): Promise<T> {
    if (this.stop.signal.aborted)
      return Promise.reject(new CaptureError("intake-closed"));
    const p = Promise.resolve().then(fn);
    this.pending.add(p);
    void p.then(
      () => this.pending.delete(p),
      () => this.pending.delete(p),
    );
    return p;
  }
  private async write(r: CaptureWrite): Promise<StoredCapture> {
    const v = await this.database.run<{
      ok: boolean;
      value: StoredCapture;
      code?: string;
    }>({ kind: "capture_write", action: r });
    if (!v.ok) throw new CaptureError(v.code ?? "intake-unavailable");
    return v.value;
  }
  private observation(
    metadata: LiteratureMetadata,
    captureId: string,
    at: string,
  ) {
    return parseMetadataObservation({
      observation_id: id([captureId, "observation"]),
      provenance: {
        provenance_id: id([captureId, "provenance"]),
        source_kind: "user",
        source_name: "web-capture",
        source_record_id: metadata.identifiers.length
          ? JSON.stringify(
              metadata.identifiers
                .filter((i) => ["doi", "arxiv"].includes(i.namespace))
                .sort((a, b) => a.namespace.localeCompare(b.namespace)),
            )
          : captureId,
        observed_at: at,
        input_sha256: hash(metadata),
        parameters_sha256: null,
      },
      source_type: null,
      source_type_mapping_version: SOURCE_TYPE_MAPPING_VERSION,
      metadata,
      version_role: null,
      version_links: [],
      declared_keywords: metadata.keywords,
      reference_texts: [],
      reference_count: null,
      cited_by_count: null,
      asset_hints: [],
    });
  }
  lookup(value: unknown) {
    return this.tracked(async () => {
      const { page } = parseIntakePagePreview(value),
        { metadata, pdf_url } = decodeWebPage(page);
      if (page.is_pdf)
        return {
          found: false,
          literature_id: null,
          library_title: null,
          metadata,
          has_pdf: false,
          pdf_url,
          possible_duplicates: [],
        };
      const decision = await this.identity.preview(
        this.observation(
          metadata,
          id(["preview", metadata]),
          "1970-01-01T00:00:00Z",
        ),
      );
      if (decision.disposition === "conflict")
        throw new CaptureError("intake-identity-conflict");
      const facts = decision.literature_id
        ? await this.database.currentFacts(decision.literature_id)
        : null;
      return {
        found: facts !== null,
        literature_id: facts?.literature.literature_id ?? null,
        library_title: facts?.literature.metadata.title ?? null,
        metadata,
        has_pdf: !!facts?.primary_asset,
        pdf_url,
        possible_duplicates: [],
      };
    });
  }
  save(connection: string, value: unknown) {
    const request = parseCaptureSave(value),
      decoded = decodeWebPage(request.page),
      r = {
        ...request,
        metadata: decoded.metadata,
        excluded: decoded.excluded,
      },
      captureId = id([connection, r.request_id]),
      requestHash = hash(r);
    if (
      !r.page.is_pdf &&
      !r.metadata.title &&
      !r.metadata.identifiers.length &&
      !r.file
    )
      throw new IntakeItemEmptyError();
    if (r.page.is_pdf && (!r.file || !this.intake))
      throw new IntakeItemEmptyError();
    if (r.duplicate_decision?.kind === "merge")
      throw new CaptureError("intake-decision-invalid");
    const active = this.saves.get(captureId);
    if (active) {
      if (active.hash !== requestHash)
        return Promise.reject(new CaptureError("intake-request-conflict"));
      return active.promise;
    }
    const promise = this.tracked(async () => {
      const at = new Date(this.now()).toISOString(),
        date = new Date(this.now()),
        day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`,
        batchId = parseIntakeBatchId(id([connection, day, "intake-batch"]));
      let stored = await this.write({
        op: "ensure",
        item_id: captureId,
        connection_id: connection,
        request_id: r.request_id,
        request_sha256: requestHash,
        day,
        now: at,
        title: r.metadata.title,
        file_name: r.file?.file_name ?? null,
        batch: {
          batch_id: batchId,
          kind: "import",
          label: `网页收藏 ${day}`,
          default_label: `网页收藏 ${day}`,
          renamed: false,
          origin: "web",
          created_at: at,
          finished_at: null,
          state: "running",
          result: null,
          confirmation: "per-item",
          confirmed_at: at,
          initiated_by: `device:${connection}`,
          source: {
            system: "web-page",
            library_id: "",
            identity: "adhoc",
            name: "网页收藏",
          },
          progress: {
            phase: "files",
            processed_items: 0,
            total_items: 0,
            files: { uploaded: 0, existing: 0, conflicts: 0, pending: 0 },
          },
          request: { format: "web-page", file_name: null },
          counts: {
            hits: 0,
            created: 0,
            enriched: 0,
            matched: 0,
            rejected: 0,
            restored: 0,
            conflicts: 0,
            possible_duplicates: 0,
            pending_decision: 0,
            needs_metadata: 0,
          },
          full_text: { total: 0, obtained: 0, missing: 0, exhausted: 0 },
          estimates: { acquire_pdf: 0, parse: 0 },
          pdf: { has_pdf: 0, unavailable: 0, pending: 0 },
          discovery_run_id: null,
          source_failures: 0,
        },
      });
      if (stored.disposition !== null && stored.literature_id === null)
        throw new CaptureError("intake-literature-missing");
      if (stored.result) {
        if (
          stored.result.metadata.status === "pending" &&
          stored.literature_id &&
          !r.metadata.identifiers.length
        )
          this.recognizePage(stored, r.page);
        return this.present(stored);
      }
      if (r.page.is_pdf) {
        if (!r.file || !this.intake)
          throw new CaptureError("intake-item-empty");
        const address = intakeSourceUrl(r.page.url);
        if (!address) throw new CaptureError("intake-input-invalid");
        await this.write({
          op: "pending",
          item_id: captureId,
          connection_id: connection,
          work: {
            page: {
              url: address,
              title: null,
              meta: [],
              json_ld: [],
              is_pdf: true,
            },
            url_identifiers: [
              ...clueDois(r.page.url),
              ...clueArxiv(r.page.url),
            ],
            excluded: r.excluded,
            folder_ids: r.folder_ids,
            source_url: r.file.source_url,
            declared_file: r.file,
            relative_path: null,
            paired_to: null,
            clues: null,
            result: null,
            reason: null,
          },
        });
        stored = await this.write({
          op: "result",
          item_id: captureId,
          connection_id: connection,
          result: {
            item_id: captureId,
            batch_id: stored.batch_id,
            literature_id: null,
            disposition: null,
            metadata: { status: "pending", job_id: null, code: null },
            missing_folder_ids: [],
          },
        });
        return this.present(stored);
      }
      if (!stored.literature_id) {
        const observation = this.observation(
          r.metadata,
          captureId,
          stored.created_at,
        );
        const replay =
          (await this.database.getObservation(observation.observation_id)) !==
          null;
        const decision = await this.identity.observe(observation, {
          intake_batch_id: parseIntakeBatchId(stored.batch_id),
        });
        if (decision.disposition !== "accepted")
          throw new CaptureError("intake-identity-conflict");
        const facts = await this.database.currentFacts(decision.literature_id);
        stored = await this.write({
          op: "accepted",
          item_id: captureId,
          connection_id: connection,
          literature_id: decision.literature_id,
          disposition: decision.outcome,
          replay,
          now: at,
          source_url: r.file?.source_url ?? null,
          excluded: r.excluded,
          file: r.file
            ? {
                file_id: id([captureId, "pdf"]),
                external_id: `${captureId}/pdf`,
                record_external_id: captureId,
                literature_id: decision.literature_id,
                file_name: r.file.file_name,
                size_bytes: r.file.size_bytes,
                expected_sha256: r.file.sha256,
                action: facts?.primary_asset ? "hash" : "upload",
                status: "pending",
                sha256: null,
                reason: null,
              }
            : null,
        });
      }
      const missing: string[] = [];
      for (const folder_id of r.folder_ids) {
        try {
          await this.folders.manage({
            operation: "add",
            request: { folder_id, literature_ids: [stored.literature_id!] },
          });
        } catch (error) {
          if (
            !(error instanceof FolderError) ||
            error.code !== "folder-not-found"
          )
            throw error;
          missing.push(folder_id);
        }
      }
      const completion: CaptureCompletion =
        !r.metadata.identifiers.length && this.options.recognizePage
          ? { status: "pending", job_id: null, code: null }
          : await this.complete(
              stored.literature_id!,
              captureId,
              this.stop.signal,
            );
      const result: Omit<CaptureResult, "file"> = {
        item_id: captureId,
        batch_id: stored.batch_id,
        literature_id: stored.literature_id!,
        disposition: stored.disposition!,
        metadata: completion,
        missing_folder_ids: missing,
      };
      stored = await this.write({
        op: "result",
        item_id: captureId,
        connection_id: connection,
        result,
      });
      if (completion.status === "pending" && !r.metadata.identifiers.length)
        this.recognizePage(stored, r.page);
      return this.present(stored);
    });
    this.saves.set(captureId, { hash: requestHash, promise });
    const done = () => this.saves.delete(captureId);
    void promise.then(done, done);
    return promise;
  }
  private async present(stored: StoredCapture): Promise<CaptureResult> {
    if (!stored.result) throw new CaptureError("intake-metadata-pending");
    if (
      !stored.literature_id &&
      stored.file?.literature_id !== null &&
      stored.result.metadata.status !== "failed"
    )
      throw new CaptureError("intake-literature-missing");
    let file = stored.file;
    if (file?.status === "pending" && file.literature_id !== null)
      file = {
        ...file,
        action: (await this.database.currentFacts(file.literature_id))
          ?.primary_asset
          ? "hash"
          : "upload",
      };
    return { ...stored.result, file };
  }
  private recognizePage(stored: StoredCapture, page: WebPageData) {
    if (!this.options.recognizePage || this.recognizing.has(stored.item_id))
      return;
    this.recognizing.add(stored.item_id);
    const pending = this.tracked(async () => {
      await new Promise<void>((resolve) => setImmediate(resolve));
      let completion: CaptureCompletion;
      try {
        completion = await this.options.recognizePage!(
          stored.literature_id!,
          page,
          this.stop.signal,
        );
      } catch {
        completion = {
          status: "failed",
          job_id: null,
          code: "metadata-source-failed",
        };
      }
      await this.write({
        op: "completion",
        item_id: stored.item_id,
        connection_id: stored.connection_id,
        completion,
      });
    });
    const done = () => this.recognizing.delete(stored.item_id);
    void pending.then(done, done);
  }
  private async receivePdf(
    s: StoredImportSession,
    item: StoredIntakeItem,
    chunks: AsyncIterable<Uint8Array>,
    signal: AbortSignal,
  ): Promise<ImportFileStatus> {
    const intake = this.intake!;
    const connection = s.initiated_by.slice("device:".length);
    const original = await this.database.run<{
      ok: boolean;
      value: StoredCapture;
    }>({
      kind: "capture_read",
      action: { item_id: item.item_id, connection_id: connection },
    });
    if (!original.ok) throw new CaptureError("intake-item-missing");
    await intake.fileItems.receive(
      s,
      item.file_name!,
      null,
      chunks,
      signal,
      item,
    );
    const staged = await intake.fileItems.read<StoredIntakeItem>({
      kind: "one",
      batch_id: s.batch_id,
      item_id: item.item_id,
    });
    if (staged.work?.reason) throw new CaptureError("intake-pdf-invalid");
    const candidate = await intake.fileItems.transfers.recover(
      staged.candidate_transfer_id!,
    );
    if (!candidate) throw new CaptureError("intake-unavailable");
    const declared = item.work?.declared_file;
    if (
      (declared?.sha256 && declared.sha256 !== candidate.sha256) ||
      (declared?.size_bytes !== undefined &&
        declared.size_bytes !== null &&
        declared.size_bytes !== candidate.size_bytes)
    ) {
      await intake.fileItems.cleanup(s.batch_id, item.item_id);
      throw new CaptureError(
        declared?.sha256 && declared.sha256 !== candidate.sha256
          ? "intake-file-hash-mismatch"
          : "intake-file-size-mismatch",
      );
    }
    const recognized = await intake.fileItems.recognizeItem(staged, signal);
    const owner = await intake.fileItems.read<{
      literature_id: string;
      asset_id: string;
      role: string;
      ambiguous?: number;
    } | null>({ kind: "hash", sha256: candidate.sha256 });
    signal.throwIfAborted();
    const accepted = owner?.ambiguous
      ? { disposition: "rejected" as const, reason: "file-identity-conflict" }
      : await this.identity.observe(
          this.observation(
            recognized.metadata,
            item.item_id,
            original.value.created_at,
          ),
          {
            signal,
            intake_batch_id: parseIntakeBatchId(s.batch_id),
            ...(owner ? { target_literature_id: owner.literature_id } : {}),
          },
        );
    if (accepted.disposition !== "accepted") {
      await this.write({
        op: "file-rejected",
        item_id: item.item_id,
        connection_id: connection,
        reason: owner ? "file-identity-conflict" : accepted.reason,
        result: {
          item_id: item.item_id,
          batch_id: s.batch_id,
          literature_id: null,
          disposition: null,
          metadata: {
            status: "failed",
            job_id: null,
            code: owner ? "file-identity-conflict" : "intake-identity-conflict",
          },
          missing_folder_ids: [],
        },
      });
      await intake.fileItems.cleanup(s.batch_id, item.item_id);
      throw new CaptureError("intake-identity-conflict");
    }
    if (recognized.observation)
      await this.identity.observe(recognized.observation, {
        signal,
        target_literature_id: accepted.literature_id,
      });
    if (
      accepted.outcome === "created" &&
      recognized.recognition.state !== "recognized"
    )
      await intake.fileItems.write({
        kind: "needs",
        literature_id: accepted.literature_id,
        needed: true,
        batch_id: s.batch_id,
        now: new Date(this.now()).toISOString(),
      });
    const facts = await this.database.currentFacts(accepted.literature_id);
    const file: ImportFileStatus = {
      file_id: item.item_id,
      external_id: `${item.item_id}/pdf`,
      record_external_id: item.item_id,
      literature_id: accepted.literature_id,
      file_name: item.file_name!,
      size_bytes: candidate.size_bytes,
      expected_sha256: candidate.sha256,
      action: facts?.primary_asset ? "hash" : "upload",
      status: "pending",
      sha256: null,
      reason: null,
    };
    await this.write({
      op: "accepted",
      item_id: item.item_id,
      connection_id: connection,
      literature_id: accepted.literature_id,
      disposition: owner ? "matched" : accepted.outcome,
      replay: false,
      file,
      source_url: item.work?.source_url ?? null,
      excluded: item.work?.excluded ?? [],
      now: new Date(this.now()).toISOString(),
    });
    const missing: string[] = [];
    for (const folder_id of item.work?.folder_ids ?? []) {
      try {
        await this.folders.manage({
          operation: "add",
          request: { folder_id, literature_ids: [accepted.literature_id] },
        });
      } catch (error) {
        if (
          !(error instanceof FolderError) ||
          error.code !== "folder-not-found"
        )
          throw error;
        missing.push(folder_id);
      }
    }
    const result = owner
      ? await intake.settleRetainedHash(
          s.batch_id,
          file.file_id,
          candidate.sha256,
        )
      : await intake.fileItems.transfers.withCandidate(candidate, (input) =>
          intake.upload(s.batch_id, file.file_id, input.chunks(), signal),
        );
    await this.write({
      op: "result",
      item_id: item.item_id,
      connection_id: connection,
      result: {
        item_id: item.item_id,
        batch_id: s.batch_id,
        literature_id: accepted.literature_id,
        disposition: owner ? "matched" : accepted.outcome,
        metadata: {
          status: recognized.observation ? "completed" : "partial",
          job_id: null,
          code: recognized.observation ? null : "intake-needs-metadata",
        },
        missing_folder_ids: missing,
      },
    });
    await intake.fileItems.cleanup(s.batch_id, item.item_id);
    return result;
  }
  async close() {
    this.stop.abort();
    await Promise.allSettled([...this.pending]);
  }
}
