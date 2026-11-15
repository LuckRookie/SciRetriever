import {
  parseIntakePageSave as parseCaptureSave,
  parseIntakePagePreview,
  parseMetadataObservation,
  parseIntakeBatchId,
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

export class CaptureError extends Error {
  constructor(readonly code: string) {
    super("Capture request rejected");
  }
}
import { intakeDigest as hash } from "./intake-digest.js";
const id = (value: unknown) => hash(value, "uuid");
export interface CaptureOptions {
  readonly now?: () => number;
}
export class CaptureService {
  private readonly stop = new AbortController();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly saves = new Map<
    string,
    { hash: string; promise: Promise<CaptureResult> }
  >();
  private readonly now: () => number;
  constructor(
    private readonly database: SqliteWorker,
    private readonly identity: LiteratureIdentityService,
    private readonly folders: FolderService,
    private readonly complete: (
      literatureId: string,
      captureId: string,
      signal: AbortSignal,
    ) => Promise<CaptureCompletion>,
    options: CaptureOptions = {},
  ) {
    this.now = options.now ?? Date.now;
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
    metadata: ReturnType<typeof parseCaptureSave>["metadata"],
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
      const { metadata } = parseIntakePagePreview(value);
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
        pdf_url: null,
        possible_duplicates: [],
      };
    });
  }
  save(connection: string, value: unknown) {
    const r = parseCaptureSave(value),
      captureId = id([connection, r.request_id]),
      requestHash = hash(r);
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
      if (stored.result) return this.present(stored);
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
      const completion = await this.complete(
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
      return this.present(stored);
    });
    this.saves.set(captureId, { hash: requestHash, promise });
    const done = () => this.saves.delete(captureId);
    void promise.then(done, done);
    return promise;
  }
  private async present(stored: StoredCapture): Promise<CaptureResult> {
    if (!stored.result) throw new CaptureError("intake-metadata-pending");
    if (!stored.literature_id)
      throw new CaptureError("intake-literature-missing");
    let file = stored.file;
    if (file?.status === "pending")
      file = {
        ...file,
        action: (await this.database.currentFacts(file.literature_id))
          ?.primary_asset
          ? "hash"
          : "upload",
      };
    return { ...stored.result, file };
  }
  async close() {
    this.stop.abort();
    await Promise.allSettled([...this.pending]);
  }
}
