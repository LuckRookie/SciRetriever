import { createHash } from "node:crypto";
import {
  canonicalJsonBytes,
  EMPTY_METADATA,
  parseCaptureSave,
  parseCaptureIdentifiers,
  parseFolderNode,
  parseMetadataObservation,
  parseAssetId,
  parseIntakeBatchId,
  importObject,
  importInteger,
  type CaptureResult,
  type CaptureCompletion,
} from "@sciretriever/contracts";
import type { SqliteWorker } from "../storage/sqlite/worker.js";
import type {
  StoredCapture,
  CaptureRead,
  CaptureWrite,
} from "../storage/sqlite/capture-engine.js";
import type { CatalogWriteAdmission } from "../storage/write-admission.js";
import type { LiteratureIdentityService } from "../literature/identity.js";
import { FolderError, type FolderService } from "../literature/folders.js";
import { SOURCE_TYPE_MAPPING_VERSION } from "../literature/metadata-types.js";
import {
  ImportSessionError,
  settleFileState,
  type ImportFileChannel,
  type FileSettlement,
} from "./import-files.js";

export class CaptureError extends Error {
  constructor(readonly code: string) {
    super("Capture request rejected");
  }
}
const hash = (value: unknown) =>
  createHash("sha256").update(canonicalJsonBytes(value)).digest("hex");
const id = (value: unknown) => {
  const h = hash(value);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
};
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
    private readonly channel: ImportFileChannel,
    private readonly writes: CatalogWriteAdmission,
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
      return Promise.reject(new CaptureError("capture-closed"));
    const p = Promise.resolve().then(fn);
    this.pending.add(p);
    void p.then(
      () => this.pending.delete(p),
      () => this.pending.delete(p),
    );
    return p;
  }
  private async read(r: CaptureRead): Promise<StoredCapture> {
    const v = await this.database.run<{
      ok: boolean;
      value: StoredCapture;
      code?: string;
    }>({ kind: "capture_read", action: r });
    if (!v.ok) throw new CaptureError(v.code ?? "capture-unavailable");
    return v.value;
  }
  private async write(r: CaptureWrite): Promise<StoredCapture> {
    const v = await this.database.run<{
      ok: boolean;
      value: StoredCapture;
      code?: string;
    }>({ kind: "capture_write", action: r });
    if (!v.ok) throw new CaptureError(v.code ?? "capture-unavailable");
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
        source_record_id: JSON.stringify(
          metadata.identifiers
            .filter((i) => ["doi", "arxiv"].includes(i.namespace))
            .sort((a, b) => a.namespace.localeCompare(b.namespace)),
        ),
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
      const r = importObject(value, ["identifiers"]),
        identifiers = parseCaptureIdentifiers(r.identifiers);
      const decision = await this.identity.preview(
        this.observation(
          { ...EMPTY_METADATA, identifiers },
          id(["lookup", identifiers]),
          "1970-01-01T00:00:00Z",
        ),
      );
      if (decision.disposition === "conflict")
        throw new CaptureError("capture-identity-conflict");
      const facts = decision.literature_id
        ? await this.database.currentFacts(decision.literature_id)
        : null;
      return {
        found: facts !== null,
        literature_id: facts?.literature.literature_id ?? null,
        title: facts?.literature.metadata.title ?? null,
        has_pdf: !!facts?.primary_asset,
        sha256: facts?.primary_asset?.sha256 ?? null,
      };
    });
  }
  listFolders(value: unknown) {
    return this.tracked(async () => {
      const r = importObject(value, [], ["cursor", "limit"]),
        limit = r.limit === undefined ? 50 : importInteger(r.limit, 200);
      if (!limit) throw new CaptureError("capture-input-invalid");
      const cursor = r.cursor == null ? null : parseAssetId(r.cursor);
      const list = importObject(
        await this.folders.query({ operation: "list", request: {} }),
        ["items"],
      );
      if (!Array.isArray(list.items))
        throw new CaptureError("capture-unavailable");
      const items = list.items
        .map(parseFolderNode)
        .sort((a, b) => a.folder_id.localeCompare(b.folder_id))
        .filter((f) => cursor === null || f.folder_id > cursor);
      return {
        items: items.slice(0, limit),
        next_cursor: items.length > limit ? items[limit - 1]!.folder_id : null,
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
        return Promise.reject(new CaptureError("capture-request-conflict"));
      return active.promise;
    }
    const promise = this.tracked(async () => {
      const at = new Date(this.now()).toISOString(),
        day = at.slice(0, 10),
        batchId = parseIntakeBatchId(id([connection, day, "capture-batch"]));
      let stored = await this.write({
        op: "ensure",
        capture_id: captureId,
        connection_id: connection,
        request_id: r.request_id,
        request_sha256: requestHash,
        day,
        now: at,
        batch: {
          batch_id: batchId,
          kind: "import",
          label: `网页收藏 ${day}`,
          default_label: `网页收藏 ${day}`,
          renamed: false,
          origin: "web",
          created_at: at,
          finished_at: null,
          status: "running",
          request: { format: "web-capture", file_name: null },
          counts: { hits: 0, created: 0, enriched: 0, matched: 0, rejected: 0 },
          pdf: { has_pdf: 0, unavailable: 0, pending: 0 },
          discovery_run_id: null,
          source_failures: 0,
        },
      });
      if (stored.disposition !== null && stored.literature_id === null)
        throw new CaptureError("capture-literature-missing");
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
          throw new CaptureError("capture-identity-conflict");
        const facts = await this.database.currentFacts(decision.literature_id);
        stored = await this.write({
          op: "accepted",
          capture_id: captureId,
          connection_id: connection,
          literature_id: decision.literature_id,
          disposition: decision.outcome,
          replay,
          now: at,
          file: r.file
            ? {
                file_id: id([captureId, "pdf"]),
                external_id: "pdf",
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
        capture_id: captureId,
        batch_id: stored.batch_id,
        literature_id: stored.literature_id!,
        disposition: stored.disposition!,
        metadata: completion,
        missing_folder_ids: missing,
      };
      stored = await this.write({
        op: "result",
        capture_id: captureId,
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
    if (!stored.result) throw new CaptureError("capture-pending");
    if (!stored.literature_id)
      throw new CaptureError("capture-literature-missing");
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
  status(connection: string, captureId: string) {
    return this.tracked(async () =>
      this.present(
        await this.read({
          capture_id: parseAssetId(captureId),
          connection_id: connection,
        }),
      ),
    );
  }
  private async file(connection: string, captureId: string) {
    const stored = await this.read({
      capture_id: parseAssetId(captureId),
      connection_id: connection,
    });
    if (!stored.literature_id)
      throw new CaptureError("capture-literature-missing");
    if (!stored.file) throw new CaptureError("capture-file-missing");
    if (stored.file.status !== "pending") return stored.file;
    return {
      ...stored.file,
      action: (await this.database.currentFacts(stored.literature_id))
        ?.primary_asset
        ? ("hash" as const)
        : ("upload" as const),
    };
  }
  private settlement(connection: string, captureId: string): FileSettlement {
    return (file, sha, asset, uploaded) =>
      this.writes.run(async () => {
        const current = await this.file(connection, captureId),
          settled = settleFileState(current, sha, asset, uploaded);
        if (current.status !== "pending") return settled;
        await this.write({
          op: "file",
          capture_id: captureId,
          connection_id: connection,
          file: settled,
        });
        return settled;
      });
  }
  reportHash(connection: string, captureId: string, sha256: string) {
    return this.tracked(async () =>
      this.channel.reportHash(
        await this.file(connection, captureId),
        sha256,
        this.settlement(connection, captureId),
      ),
    );
  }
  upload(
    connection: string,
    captureId: string,
    chunks: AsyncIterable<Uint8Array>,
    signal?: AbortSignal,
    cancelSource?: () => void,
  ) {
    return this.tracked(async () => {
      const active = AbortSignal.any([
          this.stop.signal,
          ...(signal ? [signal] : []),
        ]),
        abort = () => cancelSource?.();
      active.addEventListener("abort", abort, { once: true });
      try {
        return await this.channel.upload(
          captureId,
          await this.file(connection, captureId),
          chunks,
          active,
          async () => {
            if (active.aborted)
              throw new ImportSessionError("import-upload-cancelled");
            await this.file(connection, captureId);
          },
          this.settlement(connection, captureId),
          "web-capture",
        );
      } finally {
        active.removeEventListener("abort", abort);
      }
    });
  }
  async close() {
    this.stop.abort();
    await Promise.allSettled([...this.pending]);
  }
}
