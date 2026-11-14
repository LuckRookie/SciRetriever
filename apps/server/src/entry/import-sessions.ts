import { createHash, randomUUID } from "node:crypto";
import {
  canonicalJsonBytes,
  parseMetadataObservation,
  parseIntakeBatchId,
  parseIntakeCreate,
  parseFolderOperation,
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
import type { SqliteWorker } from "../storage/sqlite/worker.js";
import type {
  ImportRead,
  ImportWrite,
  ImportPart,
  StoredImportSession,
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
import { importAdapters } from "../literature/import-adapters.js";
import { SOURCE_TYPE_MAPPING_VERSION } from "../literature/metadata-types.js";
import {
  decodeBibliography,
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

export type ImportActor =
  | { readonly kind: "device"; readonly connection_id: string }
  | { readonly kind: "local"; readonly origin: "web" | "cli" | "mcp" };
export interface ImportSessionOptions {
  readonly adapters?: readonly ImportAdapter[];
  readonly now?: () => number;
  readonly availableBytes?: BrowserDownloadResourceOptions["available_bytes"];
  readonly maintain?: boolean;
}
const hash = (v: unknown) =>
  createHash("sha256").update(canonicalJsonBytes(v)).digest("hex");
function stableId(v: unknown) {
  const h = hash(v);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}
function blank(): ImportSummary {
  return {
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
    return { ...(s.summary ?? blank()), ...counts };
  }
  report(
    id: string,
    cursor: string | null = null,
    limit: number = IMPORT_LIMITS.page_items,
  ) {
    return this.tracked(async () => {
      const batch = await this.read<IntakeBatch>({ op: "batch", batch_id: id });
      if (batch.kind !== "import" || batch.source === null) {
        const summary = blank();
        Object.assign(summary.records, {
          created: batch.counts.created,
          enriched: batch.counts.enriched,
          matched: batch.counts.matched,
          restored: batch.counts.restored,
          rejected: batch.counts.rejected,
        });
        return {
          batch,
          estimated: false as const,
          summary,
          items: [],
          next_cursor: null,
        };
      }
      const s = await this.stored(id),
        page = await this.read<{
          items: ImportRecordResult[];
          next_cursor: string | null;
        }>({ op: "results", batch_id: id, cursor, limit });
      return {
        batch: await this.project(s),
        estimated: false as const,
        summary: await this.summary(s),
        ...page,
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
  private readonly adapters: ReadonlyMap<string, ImportAdapter>;
  private readonly now: () => number;
  private readonly confirmations = new Map<string, Promise<IntakeBatch>>();
  private readonly stopping = new Set<string>();
  private readonly uploads = new Map<string, Set<Promise<unknown>>>();
  private readonly uploadStops = new Map<string, Set<AbortController>>();
  readonly fileChannel: ImportFileChannel;
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
    if (options.maintain !== false) {
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
    return [...this.adapters.keys()];
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
    if (!this.adapters.has(r.format))
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
      request: { format: r.format, file_name: r.file_name },
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
  private async putDataOwned(
    id: string,
    sequence: number,
    data: unknown,
    decodedBibliography = false,
  ) {
    importInteger(sequence, IMPORT_LIMITS.parts - 1);
    const s = await this.stored(id);
    if (
      ["bibtex", "biblatex", "ris", "csl-json"].includes(s.format) &&
      typeof data !== "string" &&
      !decodedBibliography
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
      summary = blank();
    for (const part of parts) {
      const data = await this.decodePart(s.format, part);
      if (s.source.identity === "adhoc") {
        if (data.groups.length)
          addExcluded(summary, "groups", data.groups.length);
      } else
        for (const group of data.groups) groups.set(group.external_id, group);
      for (const e of data.excluded) addExcluded(summary, e.kind, e.count);
      for (const item of data.items)
        if (item.record) {
          const record = item.record,
            primary = selected(record);
          if (s.source.identity !== "adhoc")
            for (const id of record.groups) references.add(id);
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
    const visit = (id: string, chain = new Set<string>()) => {
      if (chain.has(id)) throw new ImportSessionError("intake-group-cycle");
      const group = groups.get(id);
      if (!group) throw new ImportSessionError("intake-group-missing");
      if (chain.size >= 128) throw new ImportSessionError("intake-group-depth");
      if (group.parent_external_id !== null)
        visit(group.parent_external_id, new Set([...chain, id]));
    };
    for (const id of new Set([...groups.keys(), ...references])) visit(id);
    return { parts, groups, summary };
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
  ): MetadataObservation {
    const content = hash(record),
      legacy = s.source.identity === "adhoc";
    return parseMetadataObservation({
      observation_id: stableId([
        s.library_key,
        record.external_id,
        content,
        "observation",
      ]),
      provenance: {
        provenance_id: stableId([
          s.library_key,
          record.external_id,
          content,
          "provenance",
        ]),
        source_kind: "user",
        source_name: legacy ? "bibliographic-import" : "import",
        source_record_id: legacy
          ? null
          : JSON.stringify([s.library_key, record.external_id]),
        observed_at: s.confirmed_at ?? s.created_at,
        input_sha256: legacy ? null : content,
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
  ) {
    if (mapping?.content_sha256 === hash(record)) {
      const facts = await this.database.currentFacts(mapping.internal_id);
      return facts
        ? {
            disposition: "matched" as const,
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
        this.observation(s, record),
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
  ): Promise<LiteratureIdentityDecision> {
    if (unchanged) {
      const facts = await this.database.currentFacts(mapping!.internal_id);
      if (!facts)
        return { disposition: "rejected", reason: "external-target-missing" };
      await this.database.writeIntake({
        operation: "member",
        member: {
          batch_id: parseIntakeBatchId(s.batch_id!),
          literature_id: mapping!.internal_id,
          disposition: "matched",
        },
      });
      return {
        disposition: "accepted",
        literature_id: mapping!.internal_id,
        meta_literature_id: facts.literature.meta_literature_id,
        outcome: "matched",
        created: false,
      };
    }
    try {
      return await this.identity.observe(observation, {
        intake_batch_id: parseIntakeBatchId(s.batch_id!),
        ...(mapping ? { target_literature_id: mapping.internal_id } : {}),
      });
    } catch (error) {
      if (s.source.identity !== "adhoc") throw error;
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
      for (const part of prepared.parts)
        for (const item of (await this.decodePart(s.format, part)).items) {
          if (!item.record) {
            (summary.records as { rejected: number }).rejected++;
            continue;
          }
          const record = item.record,
            mapping = await this.mapping(
              s.library_key,
              "record",
              record.external_id,
            ),
            decision = await this.assessRecord(s, record, mapping);
          if (decision.disposition === "conflict") {
            (summary.records as { conflicts: number }).conflicts++;
            continue;
          }
          if (decision.disposition === "created")
            (summary.records as { created: number }).created++;
          else (summary.records as { matched: number }).matched++;
          if (selected(record)) {
            const facts = decision.literature_id
              ? await this.database.currentFacts(decision.literature_id)
              : null;
            if (facts?.primary_asset)
              (summary.files as { hash: number }).hash++;
            else (summary.files as { upload: number }).upload++;
            (summary.files as { missing: number }).missing++;
          }
        }
      return {
        batch: await this.project(s),
        estimated: true as const,
        summary,
      };
    });
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
    const prepared = await this.prepare(s);
    await this.writes.run(async () => {
      const current = await this.read<ImportPart[]>({
        op: "parts",
        batch_id: id,
      });
      if (hash(current) !== hash(prepared.parts))
        throw new ImportSessionError("intake-data-changed");
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
          this.stopping.has(id) ||
          (await this.stored(id)).state !== "running"
        )
          return;
        try {
          await this.sourceGroup(s, prepared.groups, group, groupCache);
        } catch (error) {
          if (!(error instanceof ImportSessionError)) throw error;
          addExcluded(prepared.summary, error.code);
        }
      });
    for (const part of prepared.parts)
      for (const item of (await this.decodePart(s.format, part)).items) {
        if (this.stop.signal.aborted || this.stopping.has(id))
          return this.project(await this.stored(id));
        await this.writes.run(async () => {
          const current = await this.stored(id);
          if (this.stopping.has(id) || current.state !== "running") return;
          const old = await this.read<ImportRecordResult | null>({
            op: "result",
            batch_id: id,
            sequence: part.sequence,
            record_index: item.record_index,
          });
          if (old) return;
          const record = item.record;
          let result: ImportRecordResult = {
            sequence: part.sequence,
            record_index: item.record_index,
            external_id:
              record?.external_id ??
              item.external_id ??
              `rejected:${part.sequence}:${item.record_index}`,
            disposition: "rejected",
            literature_id: null,
            meta_literature_id: null,
            reason: item.reason ?? "malformed-record",
          };
          let mapping: ExternalObjectMapping | null = null;
          const files: ImportFileStatus[] = [];
          if (record) {
            const existing = await this.mapping(
                s.library_key,
                "record",
                record.external_id,
              ),
              content = hash(record),
              observation = this.observation(s, record);
            const assessment =
              s.source.identity === "adhoc"
                ? {
                    disposition: "created" as const,
                    literature_id: null,
                    reason: null,
                    unchanged: false,
                  }
                : await this.assessRecord(s, record, existing);
            if (assessment.disposition === "conflict")
              result = {
                ...result,
                disposition: "conflict",
                reason: assessment.reason,
              };
            else {
              const replay = await this.database.getObservation(
                observation.observation_id,
              );
              const decision = await this.observeRecord(
                s,
                record,
                observation,
                existing,
                assessment.unchanged,
              );
              if (decision.disposition !== "accepted")
                result = {
                  ...result,
                  disposition:
                    decision.disposition === "rejected"
                      ? "rejected"
                      : "conflict",
                  reason: decision.reason,
                };
              else {
                // Replay after a process died between the identity commit and this checkpoint.
                const member = await this.read<{
                  disposition: "created" | "enriched" | "matched";
                } | null>({
                  op: "intake-member",
                  batch_id: s.batch_id!,
                  literature_id: decision.literature_id,
                });
                result = {
                  ...result,
                  disposition:
                    replay && !assessment.unchanged
                      ? (member?.disposition ?? decision.outcome)
                      : decision.outcome,
                  literature_id: decision.literature_id,
                  meta_literature_id: decision.meta_literature_id,
                  reason: null,
                };
                mapping =
                  s.source.identity === "adhoc"
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
                    !(error instanceof ImportSessionError) &&
                    !(error instanceof FolderError)
                  )
                    throw error;
                  addExcluded(
                    prepared.summary,
                    error instanceof FolderError
                      ? "intake-folder-target-missing"
                      : error.code,
                  );
                }
                const primary = selected(record);
                if (primary) {
                  const facts = await this.database.currentFacts(
                    decision.literature_id,
                  );
                  files.push({
                    file_id: stableId([id, primary.external_id]),
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
            op: "result",
            batch_id: id,
            item: result,
            item_id: stableId([
              "intake-item",
              id,
              part.sequence,
              item.record_index,
            ]),
            title: record?.metadata.title ?? null,
            mapping,
            files,
            now: new Date(this.now()).toISOString(),
          });
        });
      }
    const current = await this.stored(id);
    if (current.state !== "running" || this.stopping.has(id))
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
    await this.finishIfComplete(id);
    return this.project(await this.stored(id));
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
      mapped?.internal_id ?? stableId(["import-folder", s.library_key, key]);
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
      await this.folders.manage({
        operation: "add",
        request: {
          folder_id: await this.sourceGroup(s, groups, id, cache),
          literature_ids: [literatureId],
        },
      });
    if (s.import_user_tags && record.user_tags.length) {
      const tags = await this.ensureFolder(s, "user-tags", "标签", root);
      for (const name of new Set(record.user_tags))
        await this.folders.manage({
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
        });
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
    await this.cleanParts(id);
    return this.project(await this.stored(id));
  }
  private async terminate(id: string, state: "finished" | "cancelled") {
    this.stopping.add(id);
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
      if ((await this.stored(id)).state !== "running")
        throw new ImportSessionError("intake-batch-state");
      const settled = settleFileState(current, sha256, asset, uploaded);
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
    return result;
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
      const file = await this.read<ImportFileStatus>({
        op: "file",
        batch_id: id,
        file_id: fileId,
      });
      return this.fileChannel.upload(
        id,
        file,
        chunks,
        active,
        async () => {
          if (
            this.stopping.has(id) ||
            (await this.stored(id)).state !== "running"
          )
            throw new ImportSessionError("intake-batch-state");
        },
        (file, sha, asset, uploaded) =>
          this.settleFile(id, file, sha, asset, uploaded),
        (await this.stored(id)).format === "web-page"
          ? "web-capture"
          : "import",
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
        else if (s.state === "running" && !s.metadata_complete)
          await this.confirm(s.batch_id);
      }
      for (const id of await this.read<string[]>({ op: "cleanup" })) {
        if (this.stop.signal.aborted) return;
        await this.cleanParts(id);
      }
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
      const decoded = decodeBibliography(bytes, format);
      const s = await this.createOwned(
        {
          format,
          source: null,
          scope: "single bibliography file",
          file_name: fileName,
          import_user_tags: false,
        },
        { kind: "local", origin },
      );
      try {
        const batches: {
          record_index: number;
          record: ImportRecord | null;
          reason: string | null;
        }[][] = [[]];
        const overhead = canonicalJsonBytes({
          import_data: { legacy_decoded: [] },
        }).byteLength;
        let batchBytes = overhead;
        for (const item of decoded.items) {
          const record: ImportRecord | null =
            item.observation === null
              ? null
              : {
                  external_id: String(item.record_index),
                  metadata: item.observation.metadata,
                  source_type: item.observation.source_type,
                  groups: [],
                  user_tags: [],
                  files: [],
                  annotations: [],
                };
          const entry = {
            record_index: item.record_index,
            record,
            reason: item.reason,
          };
          let batch = batches[batches.length - 1]!;
          const entryBytes = canonicalJsonBytes(entry).byteLength + 1;
          if (
            batchBytes + entryBytes > IMPORT_LIMITS.request_bytes &&
            batch.length
          ) {
            batch = [];
            batches.push(batch);
            batchBytes = overhead;
          }
          batch.push(entry);
          batchBytes += entryBytes;
        }
        for (const [sequence, items] of batches.entries())
          await this.putDataOwned(
            s.batch_id,
            sequence,
            { legacy_decoded: items },
            true,
          );
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
    await super.close();
  }
}
