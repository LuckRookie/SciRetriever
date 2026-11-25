import { randomUUID } from "node:crypto";
import {
  canonicalJsonBytes,
  emptyIntakeCluesUnread,
  parseMetadataObservation,
  parseIntakeBatch,
  parseIntakeBatchId,
  parseIntakeCreate,
  parseFolderOperation,
  parseIntakeFileName,
  parseIntakeRelativePath,
  type IntakeDecision,
  importInteger,
  IMPORT_LIMITS,
  type ImportAdapter,
  type ImportAdapterResult,
  type ImportRecord,
  type ImportGroup,
  type ImportSummary,
  type ImportFileStatus,
  type ImportRecordResult,
  type ExternalObjectMapping,
  type IntakeBatch,
  type MetadataObservation,
} from "@sciretriever/contracts";
import {
  SqliteWorkerError,
  type SqliteWorker,
} from "../storage/sqlite/worker.js";
import { WriteAdmissionError } from "../storage/write-admission.js";
import type {
  ImportRead,
  ImportWrite,
  ImportPart,
  StoredImportSession,
  ImportReportSnapshot,
} from "../storage/sqlite/import-engine.js";
import type { FileStore } from "../storage/files/store.js";
import type { CatalogWriteAdmission } from "../storage/write-admission.js";
import type { ArtifactRecovery } from "../storage/files/recovery.js";
import type {
  LiteratureIdentityService,
  LiteratureIdentityDecision,
} from "../literature/identity.js";
import { FolderError, type FolderService } from "../literature/folders.js";
import { activityContext } from "../logging/activity.js";
import { IntakeWithdrawalService } from "../literature/intake-withdrawal.js";
import { importAdapters } from "../literature/import-adapters.js";
import { SOURCE_TYPE_MAPPING_VERSION } from "../literature/metadata-types.js";
import {
  bibliographyText,
  type BibliographyInputFormat,
  type BibliographyImportResult,
} from "../literature/bibliography-import.js";
import { artifactReference } from "../storage/artifact-layout.js";
import { createLogger } from "../logging/index.js";
import {
  BrowserDownloadResources,
  type BrowserDownloadResourceOptions,
} from "../browser/resources.js";
import {
  ImportSessionError,
  ImportFileChannel,
  settleFileState,
} from "./import-files.js";
export { ImportSessionError } from "./import-files.js";
import { intakeDigest as hash } from "./intake-digest.js";
import { IntakeFileItems, publicIntakeItem } from "./intake-file-items.js";
import { IntakeRecognitionService } from "../literature/intake-recognition.js";
import type { FileClueReader } from "../literature/file-clues.js";
import type { StoredIntakeItem } from "../storage/sqlite/intake-items.js";
import {
  PossibleDuplicateService,
  type PossibleDuplicatePaper,
} from "../literature/possible-duplicates.js";
const intakeId = (value: unknown) => hash(value, "uuid");

export type ImportActor =
  | { readonly kind: "device"; readonly connection_id: string }
  | { readonly kind: "local"; readonly origin: "web" | "cli" | "mcp" };
export interface ImportSessionOptions {
  readonly recognition?: IntakeRecognitionService;
  readonly clueReader?: FileClueReader;
  readonly adapters?: readonly ImportAdapter[];
  readonly now?: () => number;
  readonly availableBytes?: BrowserDownloadResourceOptions["available_bytes"];
  /** Only long-lived service entry points enable recovery and expiry. */
  readonly maintain?: boolean;
}
function storageFailure(error: unknown): boolean {
  let current = error;
  for (let i = 0; i < 8 && current && typeof current === "object"; i++) {
    if (
      current instanceof SqliteWorkerError ||
      current instanceof WriteAdmissionError
    )
      return true;
    const r = current as { code?: string; cause?: unknown };
    if (
      /^(?:SQLITE_|E(?:IO|NOENT|NOSPC|ACCES|PERM|ROFS|MFILE|NFILE|DQUOT|STALE)$)/u.test(
        r.code ?? "",
      ) ||
      [
        "intake-unavailable",
        "intake-disk-space",
        "intake-disk-unavailable",
        "file-store",
        "file-staging",
        "file-publication",
        "file-read",
      ].includes(r.code ?? "")
    )
      return true;
    current = r.cause;
  }
  return false;
}
function blank(): ImportSummary {
  return {
    full_text: { total: 0, obtained: 0, missing: 0, exhausted: 0 },
    records: {
      created: 0,
      enriched: 0,
      matched: 0,
      conflicts: 0,
      rejected: 0,
      restored: 0,
      possible_duplicates: 0,
      pending_decision: 0,
      needs_metadata: 0,
      clues_unread: emptyIntakeCluesUnread(),
    },
    files: {
      upload: 0,
      hash: 0,
      uploaded: 0,
      existing: 0,
      conflicts: 0,
      missing: 0,
      unpaired: 0,
    },
    annotations: { supported: 0, unsupported: 0, imported: 0, deferred: 0 },
    excluded: [],
  };
}
function selected(record: ImportRecord) {
  return (
    record.files.find(
      (f) => f.preferred && f.media_type === "application/pdf",
    ) ?? null
  );
}
/** Summaries saved before `clues_unread` existed report it as zero. */
function withCluesUnread<T extends Pick<ImportSummary, "records">>(
  summary: T,
): T {
  return summary.records.clues_unread
    ? summary
    : {
        ...summary,
        records: { ...summary.records, clues_unread: emptyIntakeCluesUnread() },
      };
}
function addExcluded(summary: ImportSummary, kind: string, count = 1) {
  const values = summary.excluded as { kind: string; count: number }[];
  const old = values.find((v) => v.kind === kind);
  if (old) old.count += count;
  else values.push({ kind, count });
}

/** Import projections shared by read-only and durable workflow object graphs. */
export class ImportSessionReadService {
  protected readonly stop = new AbortController();
  protected readonly pending = new Set<Promise<unknown>>();
  constructor(protected readonly database: SqliteWorker) {}
  protected tracked<T>(work: () => Promise<T>): Promise<T> {
    if (this.stop.signal.aborted)
      return Promise.reject(new ImportSessionError("intake-closed"));
    const pending = work();
    this.pending.add(pending);
    void pending.then(
      () => this.pending.delete(pending),
      () => this.pending.delete(pending),
    );
    return pending;
  }
  protected async read<T>(action: ImportRead): Promise<T> {
    const r = await this.database.run<{ ok: boolean; value: T; code?: string }>(
      { kind: "import_read", action },
    );
    if (!r.ok) throw new ImportSessionError(r.code ?? "intake-unavailable");
    return r.value;
  }
  protected project(value: StoredImportSession) {
    return this.read<IntakeBatch>({ op: "batch", batch_id: value.batch_id });
  }
  protected stored(id: string) {
    return this.read<StoredImportSession>({ op: "workflow", batch_id: id });
  }
  status(id: string) {
    return this.tracked(() =>
      this.read<IntakeBatch>({ op: "batch", batch_id: id }),
    );
  }
  /** HTTP device admission only; local Web and read-purpose MCP remain unrestricted. */
  requireOwner(id: string, actor: ImportActor) {
    return this.tracked(async () => {
      const s = await this.read<{ initiated_by: string }>({
        op: "owner",
        batch_id: id,
      });
      if (
        actor.kind === "device" &&
        s.initiated_by !== `device:${actor.connection_id}`
      )
        throw new ImportSessionError("intake-batch-missing");
    });
  }
  list(cursor: string | null = null, limit = 50, actor?: ImportActor) {
    return this.tracked(async () => {
      const r = await this.read<{
        items: IntakeBatch[];
        next_cursor: string | null;
      }>({
        op: "sessions",
        cursor,
        limit,
        initiated_by:
          actor?.kind === "device" ? `device:${actor.connection_id}` : null,
      });
      return r;
    });
  }
  protected async summary(s: StoredImportSession) {
    const counts = await this.read<Pick<ImportSummary, "records" | "files">>({
      op: "aggregate",
      batch_id: s.batch_id,
    });
    return withCluesUnread({ ...blank(), ...s.summary, ...counts });
  }
  report(
    id: string,
    cursor: string | null = null,
    limit: number = IMPORT_LIMITS.page_items,
  ) {
    return this.tracked(async () => {
      const {
        batch,
        summary: storedSummary,
        counts,
        items,
        next_cursor,
      } = await this.read<ImportReportSnapshot>({
        op: "report-snapshot",
        batch_id: id,
        cursor,
        limit,
      });
      const summary = {
        ...blank(),
        ...storedSummary,
        ...counts,
        full_text: batch.full_text,
      };
      if (!counts) {
        Object.assign(summary.records, {
          created: batch.counts.created,
          enriched: batch.counts.enriched,
          matched: batch.counts.matched,
          restored: batch.counts.restored,
          rejected: batch.counts.rejected,
        });
      }
      return {
        batch,
        estimated: false as const,
        summary: withCluesUnread(summary),
        items,
        next_cursor,
      };
    });
  }

  async close() {
    this.stop.abort();
    await Promise.allSettled([...this.pending]);
  }
}

/** Durable workflow; its read projections are the exact same read-only service. */
export class ImportSessionService extends ImportSessionReadService {
  withdrawal(id: string) {
    return this.tracked(() =>
      this.database.withReadSnapshot(async (reader) => ({
        batch: parseIntakeBatch(
          await reader.intakeBatches({
            operation: "get",
            request: { batch_id: id },
          }),
        ),
        withdrawal: await new IntakeWithdrawalService(reader).read(id),
      })),
    );
  }
  restorePreview(id: string) {
    return this.tracked(() =>
      this.database.withReadSnapshot(async (reader) => ({
        batch: parseIntakeBatch(
          await reader.intakeBatches({
            operation: "get",
            request: { batch_id: id },
          }),
        ),
        restore: await new IntakeWithdrawalService(reader).restorePreview(id),
      })),
    );
  }
  withdrawalPreview(id: string) {
    return this.tracked(async () => ({
      batch: await this.database.intakeBatches({
        operation: "get",
        request: { batch_id: id },
      }),
      withdrawal: await new IntakeWithdrawalService(this.database).preview(id),
    }));
  }
  withdraw(id: string) {
    return this.tracked(async () => {
      const withdrawal = await new IntakeWithdrawalService(
        this.database,
      ).withdraw(id);
      return {
        batch: await this.database.intakeBatches({
          operation: "get",
          request: { batch_id: id },
        }),
        withdrawal,
      };
    });
  }
  restore(id: string) {
    return this.tracked(async () => {
      const restoration = await new IntakeWithdrawalService(
        this.database,
      ).restore(id);
      return {
        batch: await this.database.intakeBatches({
          operation: "get",
          request: { batch_id: id },
        }),
        restoration,
      };
    });
  }
  private readonly adapters: ReadonlyMap<string, ImportAdapter>;
  private readonly now: () => number;
  private readonly confirmations = new Map<string, Promise<IntakeBatch>>();
  private readonly admissions = new Map<string, Promise<IntakeBatch>>();
  private readonly background = new Map<string, Promise<void>>();
  private readonly preparedConfirmations = new Map<
    string,
    Awaited<ReturnType<ImportSessionService["prepare"]>>
  >();
  private readonly retries = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly failures = new Map<
    string,
    { count: number; at: number; storage: boolean }
  >();
  private readonly stopping = new Set<string>();
  private readonly uploads = new Map<string, Set<Promise<unknown>>>();
  private readonly uploadStops = new Map<string, Set<AbortController>>();
  readonly fileChannel: ImportFileChannel;
  readonly fileItems: IntakeFileItems;
  readonly possibleDuplicates: PossibleDuplicateService;
  private pagePdfHandler?: (
    s: StoredImportSession,
    item: StoredIntakeItem,
    chunks: AsyncIterable<Uint8Array>,
    signal: AbortSignal,
  ) => Promise<ImportFileStatus>;
  setPagePdfHandler(
    handler: NonNullable<ImportSessionService["pagePdfHandler"]>,
  ) {
    this.pagePdfHandler = handler;
  }
  private readonly logger = createLogger("import-sessions");
  private timer: ReturnType<typeof setInterval> | undefined;
  private maintenance: Promise<void> | undefined;
  constructor(
    database: SqliteWorker,
    private readonly identity: LiteratureIdentityService,
    private readonly folders: FolderService,
    private readonly files: FileStore,
    private readonly writes: CatalogWriteAdmission,
    private readonly recovery: ArtifactRecovery,
    options: ImportSessionOptions = {},
  ) {
    super(database);
    this.adapters = importAdapters(options.adapters);
    this.now = options.now ?? Date.now;
    const resources = new BrowserDownloadResources({
      temporary_bytes: Number.MAX_SAFE_INTEGER,
      disk_reserve_bytes: IMPORT_LIMITS.disk_reserve_bytes,
      ...(options.availableBytes
        ? { available_bytes: options.availableBytes }
        : {}),
    });
    this.fileChannel = new ImportFileChannel(
      database,
      files,
      writes,
      recovery,
      resources,
      this.now,
    );
    this.fileItems = new IntakeFileItems(
      database,
      files,
      writes,
      recovery,
      resources,
      options.recognition ??
        new IntakeRecognitionService({
          lookup: async () => [],
          search: async () => [],
        }),
      options.clueReader,
      this.now,
    );
    this.possibleDuplicates = new PossibleDuplicateService(
      () =>
        this.fileItems.read<PossibleDuplicatePaper[]>({
          kind: "duplicate-candidates",
        }),
      identity,
    );
    if (options.maintain === true) {
      this.timer = setInterval(() => {
        void this.sweep().catch(() =>
          this.logger.warn("Import maintenance failed"),
        );
      }, 60_000);
      this.timer.unref();
    }
  }
  private async write<T = unknown>(action: ImportWrite): Promise<T> {
    const r = await this.database.run<{ ok: boolean; value: T; code?: string }>(
      { kind: "import_write", action },
    );
    if (!r.ok) throw new ImportSessionError(r.code ?? "intake-unavailable");
    return r.value;
  }
  formats(): readonly string[] {
    return [...this.adapters.keys()]
      .filter((f) => f !== "web-page")
      .concat("file");
  }
  listFolders() {
    return this.tracked(() =>
      this.folders.query({ operation: "list", request: {} }),
    );
  }
  create(value: unknown, actor: ImportActor) {
    return this.tracked(() =>
      this.createOwned(parseIntakeCreate(value), actor),
    );
  }
  private async createOwned(
    r: ReturnType<typeof parseIntakeCreate>,
    actor: ImportActor,
  ) {
    if (r.source?.system === "bibliography-file")
      throw new ImportSessionError("intake-input-invalid");
    if (
      r.format === "web-page" ||
      (!this.adapters.has(r.format) && r.format !== "file")
    )
      throw new ImportSessionError("intake-format-unsupported");
    if (r.source?.identity === "local" && actor.kind !== "device")
      throw new ImportSessionError("intake-local-identity-required");
    const adhoc = r.source === null;
    const source = r.source ?? {
      system: "file",
      library_id: "",
      identity: "adhoc" as const,
      name: r.file_name ?? "",
    };
    const identity_scope = adhoc
      ? `adhoc:${randomUUID()}`
      : source.identity === "global"
        ? "global"
        : actor.kind === "device"
          ? `device:${actor.connection_id}`
          : "local";
    const now = new Date(this.now()).toISOString(),
      batchId = parseIntakeBatchId(randomUUID());
    const origin = actor.kind === "device" ? "web" : actor.origin;
    const label = (adhoc ? (r.file_name ?? r.format) : source.name).slice(
      0,
      120,
    );
    const batch: IntakeBatch = {
      batch_id: batchId,
      kind: "import",
      label,
      default_label: label,
      renamed: false,
      origin,
      created_at: now,
      finished_at: null,
      state: "collecting",
      result: null,
      confirmation: "batch",
      confirmed_at: null,
      initiated_by:
        actor.kind === "device"
          ? `device:${actor.connection_id}`
          : `local:${actor.origin}`,
      source,
      progress: null,
      request: {
        format: r.format,
        file_name: r.file_name,
        metadata_only: r.metadata_only,
      },
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
    };
    await this.write({
      op: "create",
      batch,
      library_key: hash([
        "sciretriever.import-source.v1",
        source.system,
        identity_scope,
        source.library_id,
      ]),
      source,
      format: r.format,
      scope: r.scope,
      file_name: r.file_name,
      import_user_tags: adhoc ? false : r.import_user_tags,
      identity_scope,
    });
    return this.project(await this.stored(batchId));
  }
  private decode(
    format: string,
    data: unknown,
    sequence: number,
  ): ImportAdapterResult {
    const adapter = this.adapters.get(format);
    if (!adapter) throw new ImportSessionError("intake-format-unsupported");
    const result = adapter.decode(data, sequence);
    if (result.items.length > IMPORT_LIMITS.records)
      throw new ImportSessionError("intake-batch-limit");
    return result;
  }
  putData(id: string, sequence: number, data: unknown) {
    return this.tracked(() => this.putDataOwned(id, sequence, data));
  }
  private async putDataOwned(id: string, sequence: number, data: unknown) {
    importInteger(sequence, IMPORT_LIMITS.parts - 1);
    const s = await this.stored(id);
    if (
      ["bibtex", "biblatex", "ris", "csl-json"].includes(s.format) &&
      typeof data !== "string"
    )
      throw new ImportSessionError("intake-input-invalid");
    const decoded = this.decode(s.format, data, sequence);
    const bytes = canonicalJsonBytes({ import_data: data });
    if (bytes.byteLength > IMPORT_LIMITS.request_bytes)
      throw new ImportSessionError("intake-request-too-large");
    const stage = await this.files.stage({
      maxBytes: IMPORT_LIMITS.request_bytes,
      signal: this.stop.signal,
    });
    try {
      await stage.write(bytes);
      const description = await stage.seal();
      const artifact = {
        sha256: description.sha256,
        byte_size: description.size,
        media_type: "application/json",
      };
      const descriptor = {
        reference: artifactReference("import-source", artifact),
        artifact,
      };
      const keys: { kind: string; id: string }[] = decoded.groups.map((g) => ({
        kind: "group",
        id: g.external_id,
      }));
      for (const item of decoded.items)
        if (item.record) {
          keys.push({ kind: "record", id: item.record.external_id });
          if (!s.metadata_only)
            for (const f of item.record.files)
              keys.push({ kind: "file", id: f.external_id });
        }
      await this.writes.run(async () => {
        const old = (
          await this.read<ImportPart[]>({ op: "parts", batch_id: id })
        ).find((v) => v.sequence === sequence);
        const ticket = await this.recovery.prepare([
          descriptor,
          ...(old
            ? [{ reference: old.reference, artifact: old.artifact }]
            : []),
        ]);
        try {
          await this.files.publish(stage, descriptor.reference);
          await this.write({
            op: "part",
            batch_id: id,
            sequence,
            part: descriptor,
            artifact_id: `import-source:${description.sha256}`,
            records: decoded.items.length,
            keys,
            now: new Date(this.now()).toISOString(),
          });
        } finally {
          await this.recovery.complete(ticket);
        }
      });
      return this.project(await this.stored(id));
    } finally {
      await stage.discard();
    }
  }
  private async decodePart(format: string, part: ImportPart) {
    const data = await this.files.withVerified(
      part.reference,
      part.artifact,
      async (chunks) => {
        const values: Buffer[] = [];
        for await (const chunk of chunks) values.push(Buffer.from(chunk));
        return JSON.parse(Buffer.concat(values).toString("utf8")) as {
          import_data: unknown;
        };
      },
      { maxBytes: IMPORT_LIMITS.request_bytes, signal: this.stop.signal },
    );
    return this.decode(format, data.import_data, part.sequence);
  }
  private async prepare(s: StoredImportSession) {
    const parts = await this.read<ImportPart[]>({
        op: "parts",
        batch_id: s.batch_id,
      }),
      groups = new Map<string, ImportGroup>(),
      references = new Set<string>(),
      decoded = new Map<number, ImportAdapterResult>(),
      summary = blank();
    for (const part of parts) {
      const data = await this.decodePart(s.format, part);
      decoded.set(part.sequence, data);
      if (s.source.identity === "adhoc") {
        if (data.groups.length)
          addExcluded(summary, "groups", data.groups.length);
      } else
        for (const group of data.groups) groups.set(group.external_id, group);
      for (const e of data.excluded)
        addExcluded(
          summary,
          s.metadata_only &&
            ["additional-file", "non-pdf-file"].includes(e.kind)
            ? "metadata-only-attachment"
            : e.kind,
          e.count,
        );
      for (const item of data.items)
        if (item.record) {
          const record = item.record,
            primary = s.metadata_only ? null : selected(record);
          if (s.source.identity !== "adhoc")
            for (const id of record.groups) references.add(id);
          if (s.metadata_only) {
            if (record.files.length)
              addExcluded(
                summary,
                "metadata-only-attachment",
                record.files.length,
              );
          } else
            for (const f of record.files)
              if (f !== primary)
                addExcluded(
                  summary,
                  f.media_type === "application/pdf"
                    ? "additional-file"
                    : "non-pdf-file",
                );
          if (!s.import_user_tags && record.user_tags.length)
            addExcluded(summary, "user-tags-disabled", record.user_tags.length);
          for (const a of record.annotations) {
            if (
              !["highlight", "underline", "region"].includes(a.kind) ||
              a.note.length > 20000 ||
              a.quote.length > 4000
            ) {
              (summary.annotations as { unsupported: number }).unsupported++;
              addExcluded(
                summary,
                a.note.length > 20000
                  ? "annotation-note-too-long"
                  : a.quote.length > 4000
                    ? "annotation-quote-too-long"
                    : "unsupported-annotation",
              );
            } else {
              (summary.annotations as { supported: number; deferred: number })
                .supported++;
              (summary.annotations as { deferred: number }).deferred++;
            }
          }
        }
    }
    const visiting = new Set<string>(),
      depths = new Map<string, number>();
    const visit = (id: string): number => {
      const cached = depths.get(id);
      if (cached !== undefined) return cached;
      if (visiting.has(id)) throw new ImportSessionError("intake-group-cycle");
      const group = groups.get(id);
      if (!group) throw new ImportSessionError("intake-group-missing");
      if (visiting.size >= 128)
        throw new ImportSessionError("intake-group-depth");
      visiting.add(id);
      const depth =
        group.parent_external_id === null
          ? 1
          : 1 + visit(group.parent_external_id);
      visiting.delete(id);
      if (depth > 128) throw new ImportSessionError("intake-group-depth");
      depths.set(id, depth);
      return depth;
    };
    for (const id of groups.keys()) visit(id);
    for (const id of references) visit(id);
    const fileItems = await this.fileItems.prepare(s, decoded);
    const dataItems: StoredIntakeItem[] = [];
    for (const [sequence, data] of decoded) {
      if (sequence === IMPORT_LIMITS.parts) continue;
      for (const value of data.items)
        dataItems.push({
          item_id: intakeId([
            "intake-item",
            s.batch_id,
            sequence,
            value.record_index,
          ]),
          batch_id: s.batch_id,
          origin: "data",
          sequence,
          record_index: value.record_index,
          external_id: value.record?.external_id ?? value.external_id ?? null,
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
          work: value.record
            ? {
                relative_path: null,
                paired_to: null,
                clues: null,
                result: null,
                reason: null,
                source_url: null,
                record: value.record,
                ...(fileItems.paired.get(value.record.external_id)
                  ? {
                      retained_item_id: fileItems.paired.get(
                        value.record.external_id,
                      )!.item_id,
                    }
                  : {}),
              }
            : null,
        });
    }
    if (dataItems.length)
      await this.writes.run(() =>
        this.fileItems.write({
          kind: "stage-data",
          batch_id: s.batch_id,
          items: dataItems,
          now: new Date(this.now()).toISOString(),
        }),
      );
    (summary.files as { unpaired: number }).unpaired = fileItems.items.filter(
      (i) => i.unpaired,
    ).length;
    for (const item of fileItems.items)
      if (item.work?.clues?.reason)
        addExcluded(summary, item.work.clues.reason);
    return {
      parts,
      sequences: [...decoded.keys()],
      groups,
      summary,
      decoded,
      fileItems,
    };
  }
  private async assertFileSnapshot(
    id: string,
    items: readonly StoredIntakeItem[],
  ) {
    const current = (
      await this.fileItems.read<StoredIntakeItem[]>({
        kind: "all",
        batch_id: id,
      })
    ).filter((i) => i.origin === "file");
    if (hash(current) !== hash(items))
      throw new ImportSessionError("intake-data-changed");
  }
  private mapping(
    library_key: string,
    object_kind: ExternalObjectMapping["object_kind"],
    external_id: string,
  ) {
    return this.read<ExternalObjectMapping | null>({
      op: "mapping",
      library_key,
      object_kind,
      external_id,
    });
  }
  private observation(
    s: StoredImportSession,
    record: ImportRecord,
    fileSha?: string,
  ): MetadataObservation {
    const content = hash(record),
      legacy =
        s.source.identity === "adhoc" &&
        s.format !== "web-page" &&
        fileSha === undefined;
    return parseMetadataObservation({
      observation_id: intakeId([
        s.library_key,
        record.external_id,
        content,
        "observation",
      ]),
      provenance: {
        provenance_id: intakeId([
          s.library_key,
          record.external_id,
          content,
          "provenance",
        ]),
        source_kind: "user",
        source_name:
          s.format === "web-page"
            ? "web-capture"
            : legacy
              ? "bibliographic-import"
              : "import",
        source_record_id: legacy
          ? null
          : JSON.stringify([s.library_key, record.external_id]),
        observed_at: s.confirmed_at ?? s.created_at,
        input_sha256: legacy ? null : (fileSha ?? content),
        parameters_sha256: null,
      },
      source_type: record.source_type,
      source_type_mapping_version: SOURCE_TYPE_MAPPING_VERSION,
      metadata: record.metadata,
      version_role: null,
      version_links: record.metadata.identifiers.length
        ? [{ record_id: null, identifiers: [record.metadata.identifiers[0]!] }]
        : [],
      declared_keywords: record.metadata.keywords,
      reference_texts: [],
      reference_count: null,
      cited_by_count: null,
      asset_hints: [],
    });
  }
  private async assessRecord(
    s: StoredImportSession,
    record: ImportRecord,
    mapping: ExternalObjectMapping | null,
    fileSha?: string,
  ) {
    if (mapping?.content_sha256 === hash(record)) {
      const facts = await this.database.currentFacts(mapping.internal_id);
      const withdrawn = await this.database.literatureWithdrawn(
        mapping.internal_id,
      );
      return facts
        ? {
            disposition: withdrawn
              ? ("restored" as const)
              : ("matched" as const),
            literature_id: mapping.internal_id,
            reason: null,
            unchanged: true,
          }
        : {
            disposition: "conflict" as const,
            literature_id: null,
            reason: "external-target-missing",
            unchanged: false,
          };
    }
    return {
      ...(await this.identity.preview(
        this.observation(s, record, fileSha),
        mapping?.internal_id,
      )),
      unchanged: false,
    };
  }
  private async observeRecord(
    s: StoredImportSession,
    record: ImportRecord,
    observation: MetadataObservation,
    mapping: ExternalObjectMapping | null,
    unchanged: boolean,
    resolving?: StoredIntakeItem,
  ): Promise<LiteratureIdentityDecision> {
    // Carry the same retained-item guard into identity publication, so a new
    // literature, its member and ownership commit together even after confirm.
    const resolution = resolving
      ? {
          item_id: resolving.item_id,
          now: new Date(this.now()).toISOString(),
        }
      : undefined;
    if (unchanged) {
      const facts = await this.database.currentFacts(mapping!.internal_id);
      const withdrawn = await this.database.literatureWithdrawn(
        mapping!.internal_id,
      );
      if (!facts)
        return { disposition: "rejected", reason: "external-target-missing" };
      await this.database.writeIntake({
        operation: "member",
        member: {
          batch_id: parseIntakeBatchId(s.batch_id!),
          literature_id: mapping!.internal_id,
          disposition: withdrawn ? "restored" : "matched",
          ...(resolution ? { resolution } : {}),
        },
      });
      return {
        disposition: "accepted",
        literature_id: mapping!.internal_id,
        meta_literature_id: facts.literature.meta_literature_id,
        outcome: withdrawn ? "restored" : "matched",
        created: false,
      };
    }
    try {
      return await this.identity.observe(observation, {
        intake_batch_id: parseIntakeBatchId(s.batch_id!),
        ...(resolution ? { intake_resolution: resolution } : {}),
        ...(mapping ? { target_literature_id: mapping.internal_id } : {}),
      });
    } catch (error) {
      if (s.source.identity !== "adhoc" || storageFailure(error)) throw error;
      return { disposition: "rejected", reason: "identity-failed" };
    }
  }
  preview(id: string) {
    return this.tracked(async () => {
      const s = await this.stored(id);
      if (!["collecting", "awaiting-confirmation"].includes(s.state))
        throw new ImportSessionError("intake-batch-state");
      const prepared = await this.prepare(s),
        summary = prepared.summary;
      this.fileItems.start(s, prepared.fileItems.items);
      let duplicateSnapshot: readonly PossibleDuplicatePaper[] | undefined;
      for (const sequence of prepared.sequences)
        for (const item of prepared.decoded.get(sequence)!.items) {
          if (!item.record) {
            if (item.reason === "unpaired-file")
              (summary.records as { pending_decision: number })
                .pending_decision++;
            else if (item.reason !== "excluded")
              (summary.records as { rejected: number }).rejected++;
            continue;
          }
          const record = item.record;
          const retained =
            sequence === IMPORT_LIMITS.parts
              ? prepared.fileItems.items.find(
                  (i) => i.item_id === record.external_id,
                )
              : prepared.fileItems.paired.get(record.external_id);
          let mapping = await this.mapping(
            s.library_key,
            "record",
            record.external_id,
          );
          const candidate = retained?.candidate_transfer_id
            ? await this.fileItems.transfers.recover(
                retained.candidate_transfer_id,
              )
            : null;
          const owner =
            candidate &&
            (s.source.identity === "adhoc" || sequence === IMPORT_LIMITS.parts)
              ? await this.fileItems.read<{
                  literature_id: string;
                  withdrawn: number;
                  ambiguous?: number;
                } | null>({ kind: "hash", sha256: candidate.sha256 })
              : null;
          if (owner)
            mapping = {
              library_key: s.library_key,
              object_kind: "record",
              external_id: record.external_id,
              internal_id: owner.literature_id,
              content_sha256: null,
              observation_id: null,
              state: "settled",
            };
          if (owner?.ambiguous) {
            (summary.records as { conflicts: number }).conflicts++;
            continue;
          }
          const decision = await this.assessRecord(
            s,
            record,
            mapping,
            sequence === IMPORT_LIMITS.parts ? candidate?.sha256 : undefined,
          );
          if (decision.disposition === "conflict") {
            if (decision.reason === "missing-title-or-doi")
              (summary.records as { rejected: number }).rejected++;
            else (summary.records as { conflicts: number }).conflicts++;
            continue;
          }
          if (
            (s.source.identity === "adhoc" ||
              sequence === IMPORT_LIMITS.parts) &&
            (!record.metadata.identifiers.length ||
              !!retained?.possible_duplicates.length)
          ) {
            if (decision.disposition === "created")
              duplicateSnapshot ??= await this.fileItems.read<
                PossibleDuplicatePaper[]
              >({ kind: "duplicate-candidates" });
            const candidates = owner
              ? []
              : await this.possibleDuplicates.find(
                  this.observation(s, record),
                  false,
                  {
                    assessment: decision,
                    ...(duplicateSnapshot
                      ? { snapshot: duplicateSnapshot }
                      : {}),
                  },
                );
            const itemId =
              sequence === IMPORT_LIMITS.parts
                ? record.external_id
                : intakeId(["intake-item", id, sequence, item.record_index]);
            await this.writes.run(() =>
              this.fileItems.write({
                kind: "duplicates",
                batch_id: id,
                item_id: itemId,
                candidates,
                now: new Date(this.now()).toISOString(),
              }),
            );
            if (candidates.length) {
              (summary.records as { possible_duplicates: number })
                .possible_duplicates++;
              continue;
            }
          }
          if (owner?.withdrawn || decision.disposition === "restored")
            (summary.records as { restored: number }).restored++;
          else if (owner) (summary.records as { matched: number }).matched++;
          else if (decision.disposition === "created")
            (summary.records as { created: number }).created++;
          else (summary.records as { matched: number }).matched++;
          if (
            !owner &&
            retained?.work?.result &&
            retained.work.result.recognition.state !== "recognized"
          )
            (summary.records as { needs_metadata: number }).needs_metadata++;
          if (!s.metadata_only && selected(record) && !candidate) {
            const facts = decision.literature_id
              ? await this.database.currentFacts(decision.literature_id)
              : null;
            if (facts?.primary_asset)
              (summary.files as { hash: number }).hash++;
            else (summary.files as { upload: number }).upload++;
            (summary.files as { missing: number }).missing++;
          }
        }
      const batch = await this.project(s);
      // Clue reads continue in the background; each preview counts those saved so far.
      (summary.records as { clues_unread: unknown }).clues_unread =
        await this.fileItems.read({
          kind: "clues-unread",
          batch_id: s.batch_id,
        });
      return {
        batch,
        estimated: true as const,
        summary: { ...summary, full_text: batch.full_text },
        recognition: this.fileItems.progress(prepared.fileItems.items),
      };
    });
  }
  receiveFileItem(
    id: string,
    fileName: string,
    relativePath: string | null,
    chunks: AsyncIterable<Uint8Array>,
    signal?: AbortSignal,
    cancelSource?: () => void,
  ) {
    const control = new AbortController(),
      active = AbortSignal.any([
        control.signal,
        this.stop.signal,
        ...(signal ? [signal] : []),
      ]);
    const cancel = () => cancelSource?.();
    active.addEventListener("abort", cancel, { once: true });
    const stops = this.uploadStops.get(id) ?? new Set<AbortController>();
    stops.add(control);
    this.uploadStops.set(id, stops);
    const pending = this.tracked(async () => {
      if (this.stopping.has(id))
        throw new ImportSessionError("intake-batch-state");
      const name = parseIntakeFileName(fileName),
        path = parseIntakeRelativePath(relativePath, name);
      return this.fileItems.receive(
        await this.stored(id),
        name,
        path,
        chunks,
        active,
      );
    });
    const uploads = this.uploads.get(id) ?? new Set<Promise<unknown>>();
    uploads.add(pending);
    this.uploads.set(id, uploads);
    const done = () => {
      active.removeEventListener("abort", cancel);
      stops.delete(control);
      uploads.delete(pending);
      if (!stops.size) this.uploadStops.delete(id);
      if (!uploads.size) this.uploads.delete(id);
    };
    void pending.then(done, done);
    return pending;
  }
  items(
    id: string,
    cursor: string | null = null,
    limit = 50,
    needs: "decision" | "unpaired" | null = null,
  ) {
    return this.tracked(async () => {
      await this.stored(id);
      const all = (
        await this.fileItems.read<StoredIntakeItem[]>({
          kind: "all",
          batch_id: id,
        })
      )
        .filter(
          (i) =>
            !i.work?.paired_to &&
            (!cursor || i.item_id > cursor) &&
            (needs === "decision"
              ? i.needs_decision
              : needs === "unpaired"
                ? i.unpaired
                : true),
        )
        .sort((a, b) => a.item_id.localeCompare(b.item_id));
      return {
        items: all.slice(0, limit).map(publicIntakeItem),
        next_cursor: all.length > limit ? all[limit - 1]!.item_id : null,
      };
    });
  }
  item(id: string, itemId: string) {
    return this.tracked(async () =>
      publicIntakeItem(
        await this.fileItems.read<StoredIntakeItem>({
          kind: "one",
          batch_id: id,
          item_id: itemId,
        }),
      ),
    );
  }
  decide(
    id: string,
    itemId: string,
    decision: IntakeDecision,
    actor: ImportActor,
  ) {
    return this.tracked(async () => {
      await this.requireOwner(id, actor);
      const who =
        actor.kind === "device"
          ? `device:${actor.connection_id}`
          : actor.origin;
      if (decision.kind !== "new" && decision.kind !== "merge")
        return this.fileItems.decide(
          await this.stored(id),
          itemId,
          decision,
          who,
        );
      const settle = await this.writes.run(async () => {
        const s = await this.stored(id);
        const item = await this.fileItems.write<StoredIntakeItem>({
          kind: "duplicate-decision",
          batch_id: id,
          item_id: itemId,
          decision,
          actor: who,
          now: new Date(this.now()).toISOString(),
        });
        if (s.state === "finished") {
          const all = await this.fileItems.read<StoredIntakeItem[]>({
            kind: "all",
            batch_id: id,
          });
          const retained =
            item.origin === "file"
              ? item
              : all.find((i) => i.item_id === item.work?.retained_item_id);
          const prepared = {
            groups: new Map<string, ImportGroup>(),
            summary: { ...blank(), ...s.summary },
            fileItems: {
              items: retained ? [retained] : [],
              paired: new Map(
                retained && item.work?.record
                  ? [[item.work.record.external_id, retained]]
                  : [],
              ),
              standalone: [],
            },
          };
          const recordItem = {
            record_index: item.record_index!,
            external_id: item.external_id ?? item.work!.record!.external_id,
            record: item.work!.record!,
            reason: null,
          };
          await this.admitRecord(s, prepared, item.sequence!, recordItem, item);
          return async () => {
            await this.admitRetainedFile(
              id,
              prepared,
              item.sequence!,
              recordItem,
            );
            await this.cleanParts(id);
          };
        }
        return null;
      });
      if (settle) await settle();
      return publicIntakeItem(
        await this.fileItems.read<StoredIntakeItem>({
          kind: "one",
          batch_id: id,
          item_id: itemId,
        }),
      );
    });
  }
  cancelPreview(id: string) {
    return this.tracked(async () => {
      const s = await this.stored(id);
      if (!["collecting", "awaiting-confirmation"].includes(s.state))
        throw new ImportSessionError("intake-batch-state");
      await this.fileItems.cancel(s);
      const items = await this.fileItems.read<StoredIntakeItem[]>({
        kind: "all",
        batch_id: id,
      });
      return {
        batch: await this.project(s),
        recognition: this.fileItems.progress(items),
      };
    });
  }
  /** HTTP admission only. Local bibliography wrappers keep the synchronous confirm(). */
  confirmInBackground(id: string): Promise<IntakeBatch> {
    const current = this.admissions.get(id);
    if (current) return current;
    const admitted = this.tracked(async () => {
      const s = await this.stored(id);
      let prepared:
        | Awaited<ReturnType<ImportSessionService["prepare"]>>
        | undefined;
      if (this.stopping.has(id))
        throw new ImportSessionError("intake-batch-state");
      if (s.state === "awaiting-confirmation") {
        const ready = await this.prepare(s);
        if (
          ready.fileItems.items.some(
            (i) =>
              !i.work?.reason &&
              !i.work?.paired_to &&
              (!i.unpaired ||
                i.decision?.kind === "include" ||
                i.work?.included === true) &&
              !i.work?.result,
          )
        )
          throw new ImportSessionError("intake-recognition-pending");
        await this.writes.run(async () => {
          const parts = await this.read<ImportPart[]>({
            op: "parts",
            batch_id: id,
          });
          if (hash(parts) !== hash(ready.parts))
            throw new ImportSessionError("intake-data-changed");
          await this.assertFileSnapshot(id, ready.fileItems.items);
          await this.write({
            op: "begin",
            batch_id: id,
            summary: ready.summary,
            now: new Date(this.now()).toISOString(),
          });
        });
        prepared = ready;
      } else if (!["running", "finished"].includes(s.state))
        throw new ImportSessionError("intake-batch-state");
      const batch = await this.status(id);
      if (prepared) this.preparedConfirmations.set(id, prepared);
      setImmediate(() => {
        if (!this.stop.signal.aborted) void this.runInBackground(id);
      });
      return batch;
    });
    this.admissions.set(id, admitted);
    const done = () => this.admissions.delete(id);
    void admitted.then(done, done);
    return admitted;
  }
  private scheduleRetry(id: string, due: number) {
    if (
      this.stop.signal.aborted ||
      this.stopping.has(id) ||
      this.retries.has(id)
    )
      return;
    const timer = setTimeout(
      () => {
        this.retries.delete(id);
        if (!this.stop.signal.aborted) void this.runInBackground(id);
      },
      Math.max(0, due - this.now()),
    );
    timer.unref();
    this.retries.set(id, timer);
  }
  private async checkpointFailure(
    id: string,
    failure: { count: number; at: number; storage: boolean },
  ) {
    try {
      await this.writes.run(() =>
        this.write({
          op: "processing-failure",
          batch_id: id,
          failures: failure.count,
          storage: failure.storage,
          now: new Date(failure.at).toISOString(),
        }),
      );
      const state = await this.stored(id);
      if (state.state !== "running" || state.metadata_complete) {
        this.failures.delete(id);
        if (state.state === "finished") await this.cleanParts(id);
      } else this.scheduleRetry(id, failure.at + 60_000);
    } catch {
      // Storage may also reject the failure checkpoint. Keep the processing
      // budget in memory; after three failures only this checkpoint is retried.
      this.logger.warn("Intake failure checkpoint unavailable");
      failure.at = this.now();
      this.scheduleRetry(id, failure.at + 60_000);
    }
  }
  private runInBackground(id: string): Promise<void> {
    const current = this.background.get(id);
    if (current) return current;
    if (
      this.confirmations.has(id) ||
      this.stop.signal.aborted ||
      this.stopping.has(id)
    )
      return Promise.resolve();
    const pending = this.tracked(async () => {
      try {
        const s = await this.stored(id);
        if (s.state !== "running" || s.metadata_complete) {
          this.failures.delete(id);
          return;
        }
        let failure = this.failures.get(id);
        if (s.storage_failures > (failure?.count ?? 0)) {
          failure = {
            count: s.storage_failures,
            at: Date.parse(s.updated_at),
            storage: true,
          };
          this.failures.set(id, failure);
        }
        if (failure && this.now() - failure.at < 60_000) {
          this.scheduleRetry(id, failure.at + 60_000);
          return;
        }
        const retry = this.retries.get(id);
        if (retry) {
          clearTimeout(retry);
          this.retries.delete(id);
        }
        if (failure && (!failure.storage || failure.count >= 3)) {
          await this.checkpointFailure(id, failure);
          return;
        }
        await this.confirm(id);
      } catch (error) {
        if (this.stop.signal.aborted || this.stopping.has(id)) return;
        const previous = this.failures.get(id);
        const failure =
          previous && (!previous.storage || previous.count >= 3)
            ? previous
            : {
                count: Math.min(3, (previous?.count ?? 0) + 1),
                at: this.now(),
                storage: storageFailure(error),
              };
        this.failures.set(id, failure);
        await this.checkpointFailure(id, failure);
      }
    });
    this.background.set(id, pending);
    const done = () => this.background.delete(id);
    void pending.then(done, done);
    return pending;
  }
  confirm(id: string): Promise<IntakeBatch> {
    if (this.stopping.has(id))
      return Promise.reject(new ImportSessionError("intake-batch-state"));
    const current = this.confirmations.get(id);
    if (current) return current;
    const pending = this.tracked(() => this.confirmOwned(id));
    this.confirmations.set(id, pending);
    void pending.then(
      () => this.confirmations.delete(id),
      () => this.confirmations.delete(id),
    );
    return pending;
  }
  private async confirmOwned(id: string): Promise<IntakeBatch> {
    let s = await this.stored(id);
    if (
      s.state === "finished" ||
      (s.state === "running" && s.metadata_complete)
    )
      return this.project(s);
    const prepared =
      this.preparedConfirmations.get(id) ?? (await this.prepare(s));
    this.preparedConfirmations.delete(id);
    if (
      prepared.fileItems.items.some(
        (i) =>
          !i.work?.reason &&
          !i.work?.paired_to &&
          (!i.unpaired ||
            i.decision?.kind === "include" ||
            i.work?.included === true) &&
          !i.work?.result,
      )
    )
      throw new ImportSessionError("intake-recognition-pending");
    await this.writes.run(async () => {
      const current = await this.read<ImportPart[]>({
        op: "parts",
        batch_id: id,
      });
      if (hash(current) !== hash(prepared.parts))
        throw new ImportSessionError("intake-data-changed");
      await this.assertFileSnapshot(id, prepared.fileItems.items);
      await this.write({
        op: "begin",
        batch_id: id,
        summary: prepared.summary,
        now: new Date(this.now()).toISOString(),
      });
      s = await this.stored(id);
    });
    const groupCache = new Map<string, string>();
    for (const group of prepared.groups.keys())
      await this.writes.run(async () => {
        if (
          this.stop.signal.aborted ||
          this.stopping.has(id) ||
          (await this.stored(id)).state !== "running"
        )
          return;
        try {
          await this.sourceGroup(s, prepared.groups, group, groupCache);
        } catch (error) {
          if (!(error instanceof ImportSessionError) || storageFailure(error))
            throw error;
          addExcluded(prepared.summary, error.code);
        }
      });
    for (const sequence of prepared.sequences)
      for (const item of prepared.decoded.get(sequence)!.items) {
        if (this.stop.signal.aborted || this.stopping.has(id))
          return this.project(await this.stored(id));
        await this.admitItem(s, prepared, sequence, item);
      }
    const current = await this.stored(id);
    if (
      this.stop.signal.aborted ||
      current.state !== "running" ||
      this.stopping.has(id)
    )
      return this.project(current);
    const aggregate = await this.read<Pick<ImportSummary, "records" | "files">>(
      { op: "aggregate", batch_id: id },
    );
    await this.write({
      op: "metadata-done",
      batch_id: id,
      summary: { ...prepared.summary, ...aggregate },
      now: new Date(this.now()).toISOString(),
    });
    this.failures.delete(id);
    await this.finishIfComplete(id);
    return this.project(await this.stored(id));
  }
  private async admitItem(
    s: StoredImportSession,
    prepared: Pick<
      Awaited<ReturnType<ImportSessionService["prepare"]>>,
      "fileItems" | "groups" | "summary"
    >,
    sequence: number,
    item: ImportAdapterResult["items"][number],
  ) {
    await this.admitRecord(s, prepared, sequence, item);
    await this.admitRetainedFile(s.batch_id, prepared, sequence, item);
  }
  private async admitRecord(
    s: StoredImportSession,
    prepared: Pick<
      Awaited<ReturnType<ImportSessionService["prepare"]>>,
      "fileItems" | "groups" | "summary"
    >,
    sequence: number,
    item: ImportAdapterResult["items"][number],
    resolving?: StoredIntakeItem,
  ) {
    const id = s.batch_id;
    await this.writes.run(async () => {
      const current = await this.stored(id);
      if (
        this.stopping.has(id) ||
        current.state !== (resolving ? "finished" : "running")
      )
        return;
      const old = await this.read<ImportRecordResult | null>({
        op: "result",
        batch_id: id,
        sequence: sequence,
        record_index: item.record_index,
      });
      if (old && (!resolving || old.disposition !== "pending-decision")) return;
      const record = item.record;
      let result: ImportRecordResult = {
        sequence: sequence,
        record_index: item.record_index,
        external_id:
          record?.external_id ??
          item.external_id ??
          `rejected:${sequence}:${item.record_index}`,
        disposition:
          item.reason === "unpaired-file"
            ? "excluded"
            : item.reason === "excluded"
              ? "excluded"
              : "rejected",
        literature_id: null,
        meta_literature_id: null,
        reason: item.reason ?? "malformed-record",
      };
      let mapping: ExternalObjectMapping | null = null;
      const files: ImportFileStatus[] = [];
      const retained = record
        ? sequence === IMPORT_LIMITS.parts
          ? prepared.fileItems.items.find(
              (i) => i.item_id === record.external_id,
            )
          : prepared.fileItems.paired.get(record.external_id)
        : undefined;
      const retainedCandidate = retained?.candidate_transfer_id
        ? await this.fileItems.transfers.recover(retained.candidate_transfer_id)
        : null;
      if (record) {
        let existing = await this.mapping(
          s.library_key,
          "record",
          record.external_id,
        );
        const hashOwner =
          retainedCandidate &&
          (s.source.identity === "adhoc" || sequence === IMPORT_LIMITS.parts)
            ? await this.fileItems.read<{
                literature_id: string;
                asset_id: string;
                role: string;
                withdrawn: number;
                ambiguous?: number;
              } | null>({ kind: "hash", sha256: retainedCandidate.sha256 })
            : null;
        if (hashOwner)
          existing = {
            library_key: s.library_key,
            object_kind: "record",
            external_id: record.external_id,
            internal_id: hashOwner.literature_id,
            content_sha256: null,
            observation_id: null,
            state: "settled",
          };
        const content = hash(record),
          observation = this.observation(
            s,
            record,
            sequence === IMPORT_LIMITS.parts
              ? retainedCandidate?.sha256
              : undefined,
          );
        const assessment = hashOwner?.ambiguous
          ? {
              disposition: "conflict" as const,
              literature_id: null,
              reason: "file-identity-conflict",
              unchanged: false,
            }
          : s.source.identity === "adhoc" &&
              !hashOwner &&
              record.metadata.identifiers.length > 0
            ? {
                disposition: "created" as const,
                literature_id: null,
                reason: null,
                unchanged: false,
              }
            : await this.assessRecord(
                s,
                record,
                existing,
                sequence === IMPORT_LIMITS.parts
                  ? retainedCandidate?.sha256
                  : undefined,
              );
        let undecided = false;
        if (
          (s.source.identity === "adhoc" || sequence === IMPORT_LIMITS.parts) &&
          (!record.metadata.identifiers.length ||
            !!retained?.possible_duplicates.length) &&
          assessment.disposition !== "conflict"
        ) {
          const itemId =
            sequence === IMPORT_LIMITS.parts
              ? record.external_id
              : intakeId(["intake-item", id, sequence, item.record_index]);
          let stored =
            resolving ??
            (await this.fileItems.read<StoredIntakeItem>({
              kind: "one",
              batch_id: id,
              item_id: itemId,
            }));
          if (!resolving) {
            const candidates = hashOwner
              ? []
              : await this.possibleDuplicates.find(observation, false, {
                  assessment,
                });
            stored = await this.fileItems.write<StoredIntakeItem>({
              kind: "duplicates",
              batch_id: id,
              item_id: itemId,
              candidates,
              work: {
                ...(stored.work ?? {
                  relative_path: null,
                  paired_to: null,
                  clues: null,
                  result: null,
                  reason: null,
                  source_url: null,
                }),
                record,
                ...(retained && retained.item_id !== itemId
                  ? { retained_item_id: retained.item_id }
                  : {}),
              },
              now: new Date(this.now()).toISOString(),
            });
          }
          if (stored.possible_duplicates.length) {
            const choice = stored.decision;
            if (
              choice?.kind === "merge" &&
              stored.possible_duplicates.some(
                (c) => c.literature_id === choice.literature_id,
              )
            ) {
              existing = {
                library_key: s.library_key,
                object_kind: "record",
                external_id: record.external_id,
                internal_id: choice.literature_id,
                content_sha256: null,
                observation_id: null,
                state: "settled",
              };
            } else if (choice?.kind !== "new") undecided = true;
          }
        }
        if (undecided)
          result = {
            ...result,
            disposition: "pending-decision",
            reason: "possible-duplicate",
          };
        else if (assessment.disposition === "conflict")
          result = {
            ...result,
            disposition:
              assessment.reason === "missing-title-or-doi"
                ? "rejected"
                : "conflict",
            reason: hashOwner ? "file-identity-conflict" : assessment.reason,
          };
        else {
          const replay = await this.database.getObservation(
            observation.observation_id,
          );
          const createsOnResolution =
            resolving?.work?.creates_on_resolution ??
            (assessment.disposition === "created" && !existing);
          if (resolving && resolving.work?.creates_on_resolution === undefined)
            await this.fileItems.write({
              kind: "resolution-intent",
              batch_id: id,
              item_id: resolving.item_id,
              creates: createsOnResolution,
              now: new Date(this.now()).toISOString(),
            });
          const decision = await this.observeRecord(
            s,
            record,
            observation,
            existing,
            assessment.unchanged,
            resolving,
          );
          if (decision.disposition !== "accepted")
            result = {
              ...result,
              disposition:
                decision.disposition === "rejected" ? "rejected" : "conflict",
              reason: hashOwner ? "file-identity-conflict" : decision.reason,
            };
          else {
            // Replay after a process died between the identity commit and this checkpoint.
            const member = await this.read<{
              disposition: "created" | "enriched" | "matched" | "restored";
            } | null>({
              op: "intake-member",
              batch_id: s.batch_id!,
              literature_id: decision.literature_id,
            });
            result = {
              ...result,
              disposition: hashOwner?.withdrawn
                ? "restored"
                : hashOwner
                  ? "matched"
                  : replay && !assessment.unchanged
                    ? (member?.disposition ??
                      (resolving && createsOnResolution
                        ? "created"
                        : decision.outcome))
                    : decision.outcome,
              literature_id: decision.literature_id,
              meta_literature_id: decision.meta_literature_id,
              reason:
                hashOwner?.role !== undefined &&
                hashOwner.role !== "primary-pdf"
                  ? "matched-by-supplementary"
                  : (retained?.work?.clues?.reason ?? null),
            };
            if (hashOwner) {
              if (hashOwner.withdrawn)
                await this.fileItems.write({
                  kind: "restore",
                  literature_id: decision.literature_id,
                });
              await this.database.writeIntake({
                operation: "member",
                member: {
                  batch_id: parseIntakeBatchId(id),
                  literature_id: decision.literature_id,
                  disposition: hashOwner.withdrawn ? "restored" : "matched",
                  authoritative: true,
                },
              });
            }
            const recognized = retained?.work?.result;
            if (recognized?.observation)
              await this.identity.observe(recognized.observation, {
                target_literature_id: decision.literature_id,
              });
            if (
              recognized &&
              decision.outcome === "created" &&
              recognized.recognition.state !== "recognized"
            )
              await this.fileItems.write({
                kind: "needs",
                literature_id: decision.literature_id,
                needed: true,
                batch_id: id,
                now: new Date(this.now()).toISOString(),
              });
            mapping =
              s.source.identity === "adhoc" || sequence === IMPORT_LIMITS.parts
                ? null
                : {
                    library_key: s.library_key,
                    object_kind: "record",
                    external_id: record.external_id,
                    internal_id: decision.literature_id,
                    content_sha256: content,
                    observation_id: observation.observation_id,
                    state: "settled",
                  };
            try {
              await this.addFolders(
                s,
                record,
                prepared.groups,
                decision.literature_id,
              );
            } catch (error) {
              if (
                (!(error instanceof ImportSessionError) &&
                  !(error instanceof FolderError)) ||
                storageFailure(error)
              )
                throw error;
              addExcluded(
                prepared.summary,
                error instanceof FolderError
                  ? "intake-folder-target-missing"
                  : error.code,
              );
            }
            const primary = s.metadata_only ? null : selected(record);
            if (primary) {
              const facts = await this.database.currentFacts(
                decision.literature_id,
              );
              files.push({
                file_id: intakeId([id, primary.external_id]),
                external_id: primary.external_id,
                record_external_id: record.external_id,
                literature_id: decision.literature_id,
                file_name: primary.file_name,
                size_bytes: primary.size_bytes,
                expected_sha256: primary.sha256,
                action: facts?.primary_asset ? "hash" : "upload",
                status: "pending",
                sha256: null,
                reason: null,
              });
            }
          }
        }
      }
      await this.write({
        op: resolving ? "resolve-result" : "result",
        batch_id: id,
        item: result,
        item_id:
          (sequence === IMPORT_LIMITS.parts
            ? (record?.external_id ?? item.external_id)
            : null) ??
          intakeId(["intake-item", id, sequence, item.record_index]),
        title: record?.metadata.title ?? null,
        mapping,
        files,
        now: new Date(this.now()).toISOString(),
      });
      this.failures.delete(id);
    });
  }
  private async admitRetainedFile(
    id: string,
    prepared: Pick<
      Awaited<ReturnType<ImportSessionService["prepare"]>>,
      "fileItems"
    >,
    sequence: number,
    item: ImportAdapterResult["items"][number],
  ) {
    const record = item.record;
    const retained = record
      ? sequence === IMPORT_LIMITS.parts
        ? prepared.fileItems.items.find((i) => i.item_id === record.external_id)
        : prepared.fileItems.paired.get(record.external_id)
      : undefined;
    if (retained?.candidate_transfer_id && record && selected(record)) {
      const candidate = await this.fileItems.transfers.recover(
        retained.candidate_transfer_id,
      );
      const result = await this.read<ImportRecordResult | null>({
        op: "result",
        batch_id: id,
        sequence,
        record_index: item.record_index,
      });
      if (candidate && result?.literature_id) {
        const file = await this.read<ImportFileStatus>({
          op: "file",
          batch_id: id,
          file_id: intakeId([id, selected(record)!.external_id]),
        });
        if (file.status === "pending") {
          if (
            (file.size_bytes !== null &&
              file.size_bytes !== candidate.size_bytes) ||
            (file.expected_sha256 !== null &&
              file.expected_sha256 !== candidate.sha256)
          )
            await this.settleFile(id, file, candidate.sha256, null, false);
          else {
            const owner = await this.fileItems.read<{
              literature_id: string;
              asset_id: string;
              role: string;
            } | null>({ kind: "hash", sha256: candidate.sha256 });
            if (owner?.literature_id === result.literature_id)
              await this.settleFile(
                id,
                file,
                candidate.sha256,
                { asset_id: owner.asset_id, sha256: candidate.sha256 },
                false,
              );
            else if (file.action === "hash")
              await this.reportHash(id, file.file_id, candidate.sha256);
            else
              await this.fileItems.transfers.withCandidate(candidate, (input) =>
                this.upload(id, file.file_id, input.chunks()),
              );
          }
        }
      }
    }
  }
  private async ensureFolder(
    s: StoredImportSession,
    key: string,
    name: string,
    parent: string | null,
  ): Promise<string> {
    const mapped = await this.mapping(s.library_key, "group", key);
    const context = await this.read<{
      folder: { folder_id: string } | null;
      names: string[];
    }>({
      op: "folder",
      folder_id: mapped?.internal_id ?? null,
      parent_id: parent,
    });
    const folderId =
      mapped?.internal_id ?? intakeId(["import-folder", s.library_key, key]);
    const mapping = (state: "pending" | "settled") =>
      this.write({
        op: "mapping",
        mapping: {
          library_key: s.library_key,
          object_kind: "group",
          external_id: key,
          internal_id: folderId,
          content_sha256: null,
          observation_id: null,
          state,
        },
      });
    if (mapped && context.folder) {
      if (mapped.state === "pending") await mapping("settled");
      return mapped.internal_id;
    }
    if (mapped?.state === "settled")
      throw new ImportSessionError("intake-folder-target-missing");
    if (!mapped) await mapping("pending");
    const truncate = (value: string, max: number) => {
      let result = "";
      for (const character of value) {
        if (result.length + character.length > max) break;
        result += character;
      }
      return result;
    };
    const base = truncate(name, 128);
    let candidate = base,
      index = 2;
    while (context.names.includes(candidate)) {
      const suffix = ` (${index++})`;
      candidate = truncate(base, 128 - suffix.length) + suffix;
    }
    const command = parseFolderOperation({
      operation: "create",
      request: { parent_id: parent, name: candidate, position: null },
    });
    await this.database.folders({
      ...command,
      folder_id: folderId,
      intake_batch_id: s.batch_id,
      actor: activityContext().actor,
      now: new Date(this.now()).toISOString(),
    });
    await mapping("settled");
    return folderId;
  }
  private async sourceGroup(
    s: StoredImportSession,
    groups: Map<string, ImportGroup>,
    id: string,
    cache: Map<string, string>,
  ): Promise<string> {
    const old = cache.get(id);
    if (old) return old;
    const group = groups.get(id)!;
    const parent =
      group.parent_external_id === null
        ? await this.ensureFolder(s, "root", s.source.name, null)
        : await this.sourceGroup(s, groups, group.parent_external_id, cache);
    const folder = await this.ensureFolder(
      s,
      `source:${id}`,
      group.name,
      parent,
    );
    cache.set(id, folder);
    return folder;
  }
  private async addFolders(
    s: StoredImportSession,
    record: ImportRecord,
    groups: Map<string, ImportGroup>,
    literatureId: string,
  ) {
    if (
      !record.groups.length &&
      (!s.import_user_tags || !record.user_tags.length)
    )
      return;
    if (s.source.identity === "adhoc") return;
    const root = await this.ensureFolder(s, "root", s.source.name, null),
      cache = new Map<string, string>();
    for (const id of record.groups)
      await this.folders.manage(
        {
          operation: "add",
          request: {
            folder_id: await this.sourceGroup(s, groups, id, cache),
            literature_ids: [literatureId],
          },
        },
        undefined,
        s.batch_id,
      );
    if (s.import_user_tags && record.user_tags.length) {
      const tags = await this.ensureFolder(s, "user-tags", "标签", root);
      for (const name of new Set(record.user_tags))
        await this.folders.manage(
          {
            operation: "add",
            request: {
              folder_id: await this.ensureFolder(
                s,
                `tag:${hash(name)}`,
                name,
                tags,
              ),
              literature_ids: [literatureId],
            },
          },
          undefined,
          s.batch_id,
        );
    }
  }
  missingFiles(
    id: string,
    cursor: string | null = null,
    limit: number = IMPORT_LIMITS.page_items,
    pending = true,
  ) {
    return this.tracked(() =>
      this.read<{ items: ImportFileStatus[]; next_cursor: string | null }>({
        op: "files",
        batch_id: id,
        cursor,
        limit,
        pending,
      }),
    );
  }
  private async cleanParts(id: string) {
    await this.writes.run(async () => {
      const parts = await this.read<ImportPart[]>({
        op: "parts",
        batch_id: id,
      });
      if (!parts.length) return;
      const ticket = await this.recovery.prepare(
        parts.map((p) => ({ reference: p.reference, artifact: p.artifact })),
      );
      await this.write({ op: "retire-parts", batch_id: id });
      await this.recovery.complete(ticket);
    });
    const s = await this.stored(id);
    await this.fileItems.cleanup(id, undefined, s.state === "finished");
    await this.writes.run(() =>
      this.fileItems.write({
        kind: "discard-settled-work",
        batch_id: id,
        now: new Date(this.now()).toISOString(),
      }),
    );
  }
  private async finishIfComplete(id: string) {
    const s = await this.stored(id);
    if (
      s.state === "running" &&
      s.confirmation === "batch" &&
      s.metadata_complete &&
      s.pending_files === 0
    )
      await this.finishOwned(id, "finished");
  }
  private async finishOwned(id: string, state: "finished" | "cancelled") {
    await this.writes.run(async () => {
      const s = await this.stored(id);
      await this.write({
        op: "finish",
        batch_id: id,
        state,
        summary: await this.summary(s),
        now: new Date(this.now()).toISOString(),
      });
    });
    this.failures.delete(id);
    await this.cleanParts(id);
    return this.project(await this.stored(id));
  }
  private async terminate(id: string, state: "finished" | "cancelled") {
    this.stopping.add(id);
    this.preparedConfirmations.delete(id);
    await this.fileItems.cancel(await this.stored(id));
    const retry = this.retries.get(id);
    if (retry) {
      clearTimeout(retry);
      this.retries.delete(id);
    }
    for (const stop of this.uploadStops.get(id) ?? []) stop.abort();
    try {
      const confirmation = this.confirmations.get(id);
      await Promise.allSettled([
        ...(this.uploads.get(id) ?? []),
        ...(confirmation ? [confirmation] : []),
      ]);
      return await this.finishOwned(id, state);
    } finally {
      this.stopping.delete(id);
    }
  }
  finish(id: string) {
    return this.tracked(async () => {
      const s = await this.stored(id);
      if (s.state !== "running" && s.state !== "finished")
        throw new ImportSessionError("intake-batch-state");
      if (!s.metadata_complete)
        throw new ImportSessionError("intake-metadata-pending");
      return this.terminate(id, "finished");
    });
  }
  cancel(id: string) {
    return this.tracked(() => this.terminate(id, "cancelled"));
  }
  private async settleFile(
    id: string,
    file: ImportFileStatus,
    sha256: string,
    asset: { asset_id: string; sha256: string } | null,
    uploaded: boolean,
  ) {
    const result = await this.writes.run(async () => {
      // Another upload/hash request may have settled this file while we waited.
      const current = await this.read<ImportFileStatus>({
        op: "file",
        batch_id: id,
        file_id: file.file_id,
      });
      if (current.status !== "pending") {
        return settleFileState(current, sha256, asset, uploaded);
      }
      const resolving = await this.resolutionFile(id, file.file_id);
      if ((await this.stored(id)).state !== "running" && !resolving)
        throw new ImportSessionError("intake-batch-state");
      const settled = settleFileState(current, sha256, asset, uploaded);
      if (resolving)
        await this.write({
          op: "resolved-file",
          batch_id: id,
          item_id: resolving,
          file_id: current.file_id,
          status: settled.status as "conflict" | "uploaded" | "existing",
          sha256,
          reason: settled.reason,
          now: new Date(this.now()).toISOString(),
        });
      else
        await this.write({
          op: "file-result",
          batch_id: id,
          file_id: current.file_id,
          status: settled.status as "conflict" | "uploaded" | "existing",
          sha256,
          internal_id: settled.status === "conflict" ? null : asset!.asset_id,
          reason: settled.reason,
          now: new Date(this.now()).toISOString(),
        });
      return this.read<ImportFileStatus>({
        op: "file",
        batch_id: id,
        file_id: current.file_id,
      });
    });
    await this.finishIfComplete(id);
    if (await this.resolutionFile(id, file.file_id)) await this.cleanParts(id);
    return result;
  }
  private resolutionFile(id: string, fileId: string) {
    return this.fileItems.read<string | null>({
      kind: "resolution-file",
      batch_id: id,
      file_id: fileId,
      now: new Date(this.now()).toISOString(),
    });
  }
  settleRetainedHash(id: string, fileId: string, sha256: string) {
    return this.tracked(async () => {
      const file = await this.read<ImportFileStatus>({
        op: "file",
        batch_id: id,
        file_id: fileId,
      });
      const owner = await this.fileItems.read<{
        literature_id: string;
        asset_id: string;
      } | null>({ kind: "hash", sha256 });
      if (!owner || owner.literature_id !== file.literature_id)
        throw new ImportSessionError("intake-file-conflict");
      return this.settleFile(
        id,
        file,
        sha256,
        { asset_id: owner.asset_id, sha256 },
        false,
      );
    });
  }
  reportHash(id: string, fileId: string, sha256: string) {
    return this.tracked(async () => {
      const file = await this.read<ImportFileStatus>({
        op: "file",
        batch_id: id,
        file_id: fileId,
      });
      return this.fileChannel.reportHash(
        file,
        sha256,
        (file, sha, asset, uploaded) =>
          this.settleFile(id, file, sha, asset, uploaded),
      );
    });
  }
  upload(
    id: string,
    fileId: string,
    chunks: AsyncIterable<Uint8Array>,
    signal?: AbortSignal,
    cancelSource?: () => void,
    onAccepted?: (
      receipt: import("@sciretriever/contracts").CandidatePublicationReceipt,
    ) => void,
  ) {
    const control = new AbortController();
    const active = AbortSignal.any([
      control.signal,
      this.stop.signal,
      ...(signal ? [signal] : []),
    ]);
    const abortSource = () => cancelSource?.();
    active.addEventListener("abort", abortSource, { once: true });
    const stops = this.uploadStops.get(id) ?? new Set<AbortController>();
    stops.add(control);
    this.uploadStops.set(id, stops);
    const operation = this.tracked(async () => {
      if (this.stopping.has(id))
        throw new ImportSessionError("intake-batch-state");
      let file: ImportFileStatus;
      try {
        file = await this.read<ImportFileStatus>({
          op: "file",
          batch_id: id,
          file_id: fileId,
        });
      } catch (error) {
        if (
          !(error instanceof ImportSessionError) ||
          error.code !== "intake-file-missing" ||
          !this.pagePdfHandler
        )
          throw error;
        let item: StoredIntakeItem;
        try {
          item = await this.fileItems.read<StoredIntakeItem>({
            kind: "one",
            batch_id: id,
            item_id: fileId,
          });
        } catch (itemError) {
          if (
            itemError instanceof ImportSessionError &&
            itemError.code === "intake-item-missing"
          )
            throw error;
          throw itemError;
        }
        if (item.origin !== "page" || !item.work?.page?.is_pdf) throw error;
        if (item.disposition !== null)
          throw new ImportSessionError("intake-file-conflict");
        return this.pagePdfHandler(await this.stored(id), item, chunks, active);
      }
      return this.fileChannel.upload(
        id,
        file,
        chunks,
        active,
        async () => {
          if (
            this.stopping.has(id) ||
            ((await this.stored(id)).state !== "running" &&
              !(await this.resolutionFile(id, fileId)))
          )
            throw new ImportSessionError("intake-batch-state");
        },
        (file, sha, asset, uploaded) =>
          this.settleFile(id, file, sha, asset, uploaded),
        (await this.stored(id)).format === "web-page"
          ? "web-capture"
          : (await this.stored(id)).format === "pdf"
            ? "manual-pdf"
            : "import",
        onAccepted,
      );
    });
    const uploads = this.uploads.get(id) ?? new Set<Promise<unknown>>();
    uploads.add(operation);
    this.uploads.set(id, uploads);
    const done = () => {
      active.removeEventListener("abort", abortSource);
      stops.delete(control);
      if (!stops.size) this.uploadStops.delete(id);
      uploads.delete(operation);
      if (!uploads.size) this.uploads.delete(id);
    };
    void operation.then(done, done);
    return operation;
  }
  supplementPdf(
    literatureId: string,
    chunks: AsyncIterable<Uint8Array>,
    origin: "web" | "cli" | "mcp",
    signal?: AbortSignal,
    cancelSource?: () => void,
    onAccepted?: (
      receipt: import("@sciretriever/contracts").CandidatePublicationReceipt,
    ) => void,
    descriptor: {
      file_name?: string;
      size_bytes?: number;
      sha256?: string;
    } = {},
  ) {
    return this.tracked(async () => {
      const facts = await this.database.currentFacts(literatureId);
      if (!facts) throw new ImportSessionError("intake-literature-missing");
      const at = new Date(this.now()),
        day = `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`;
      const fileId = randomUUID(),
        itemId = randomUUID();
      const base = this.createBatchProjection(origin, at.toISOString(), day);
      const file: ImportFileStatus = {
        file_id: fileId,
        external_id: fileId,
        record_external_id: itemId,
        literature_id: literatureId,
        file_name: descriptor.file_name ?? "document.pdf",
        size_bytes: descriptor.size_bytes ?? null,
        expected_sha256: descriptor.sha256 ?? null,
        action: "upload",
        status: "pending",
        sha256: null,
        reason: null,
      };
      const id = await this.writes.run(() =>
        this.write<string>({
          op: "supplement",
          batch: base,
          day,
          item_id: itemId,
          file,
          title: facts.literature.metadata.title,
        }),
      );
      return {
        batch_id: id,
        file: await this.upload(
          id,
          fileId,
          chunks,
          signal,
          cancelSource,
          onAccepted,
        ),
      };
    });
  }
  private createBatchProjection(
    origin: "web" | "cli" | "mcp",
    at: string,
    day: string,
  ): IntakeBatch {
    return {
      batch_id: parseIntakeBatchId(randomUUID()),
      kind: "import",
      label: `补充文件 ${day}`,
      default_label: `补充文件 ${day}`,
      renamed: false,
      origin,
      created_at: at,
      finished_at: null,
      state: "running",
      result: null,
      confirmation: "per-item",
      confirmed_at: at,
      initiated_by: `local:${origin}`,
      source: {
        system: "file",
        library_id: "",
        identity: "adhoc",
        name: "补充文件",
      },
      progress: null,
      request: { format: "pdf", file_name: null },
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
    };
  }
  /** Startup/periodic recovery; progress is checkpointed per record, never resets valid facts. */
  sweep(): Promise<void> {
    if (this.maintenance) return this.maintenance;
    const pending = this.tracked(async () => {
      const sessions = await this.read<StoredImportSession[]>({ op: "active" });
      const date = new Date(this.now()),
        day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
      for (const s of sessions) {
        if (s.confirmation === "per-item") {
          const opened = new Date(s.created_at),
            openedDay = `${opened.getFullYear()}-${String(opened.getMonth() + 1).padStart(2, "0")}-${String(opened.getDate()).padStart(2, "0")}`;
          if (openedDay < day) await this.terminate(s.batch_id, "finished");
          continue;
        }
        if (this.stop.signal.aborted) return;
        if (s.owner_pid !== null && s.owner_pid !== process.pid) {
          try {
            process.kill(s.owner_pid, 0);
            continue;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
          }
        }
        const deadline =
          Date.parse(
            s.state === "running"
              ? (s.last_file_at ?? s.confirmed_at ?? s.created_at)
              : s.created_at,
          ) + IMPORT_LIMITS.expiry_ms;
        if (this.now() >= deadline)
          await this.terminate(
            s.batch_id,
            s.state === "running" ? "finished" : "cancelled",
          );
        else if (s.state === "running" && !s.metadata_complete) {
          void this.runInBackground(s.batch_id);
        }
      }
      for (const id of await this.read<string[]>({ op: "cleanup" })) {
        if (this.stop.signal.aborted) return;
        await this.cleanParts(id);
      }
      const expired = await this.writes.run(() =>
        this.fileItems.write<string[]>({
          kind: "expire-decisions",
          now: new Date(this.now()).toISOString(),
        }),
      );
      for (const id of new Set(expired)) await this.cleanParts(id);
    });
    this.maintenance = pending;
    void pending.then(
      () => {
        this.maintenance = undefined;
      },
      () => {
        this.maintenance = undefined;
      },
    );
    return pending;
  }
  importBibliography(
    bytes: Uint8Array,
    format: BibliographyInputFormat,
    fileName: string | null,
    origin: "web" | "cli" | "mcp",
  ): Promise<BibliographyImportResult> {
    return this.tracked(async () => {
      const rejected = (reason: string): BibliographyImportResult => ({
        format,
        items: [
          {
            record_index: 0,
            disposition: "rejected",
            literature_id: null,
            meta_literature_id: null,
            reason,
          },
        ],
      });
      if (bytes.byteLength > IMPORT_LIMITS.request_bytes)
        return rejected("input-too-large");
      let text: string;
      try {
        text = bibliographyText(bytes);
      } catch {
        return rejected("malformed-document");
      }
      if (
        canonicalJsonBytes({ import_data: text }).byteLength >
        IMPORT_LIMITS.request_bytes
      )
        return rejected("input-too-large");
      const s = await this.create(
        {
          format,
          source: null,
          scope: "single bibliography file",
          file_name: fileName,
          import_user_tags: false,
          metadata_only: true,
        },
        { kind: "local", origin },
      );
      try {
        await this.putData(s.batch_id, 0, text);
        const done = await this.confirm(s.batch_id),
          items: ImportRecordResult[] = [];
        let cursor: string | null = null;
        do {
          const page = await this.report(s.batch_id, cursor);
          items.push(...page.items);
          cursor = page.next_cursor;
        } while (cursor !== null);
        return {
          format,
          intake_batch_id: parseIntakeBatchId(done.batch_id),
          items: items.map(({ sequence, external_id, ...item }) => {
            void sequence;
            void external_id;
            return {
              ...item,
              disposition: ["created", "enriched", "matched"].includes(
                item.disposition,
              )
                ? (item.disposition as "created" | "enriched" | "matched")
                : ("rejected" as const),
            };
          }),
        };
      } catch (error) {
        await this.finishOwned(s.batch_id, "cancelled");
        throw error;
      }
    });
  }
  override async close() {
    if (this.timer) clearInterval(this.timer);
    for (const retry of this.retries.values()) clearTimeout(retry);
    this.retries.clear();
    await this.fileItems.close();
    await super.close();
    this.failures.clear();
    this.preparedConfirmations.clear();
  }
}
