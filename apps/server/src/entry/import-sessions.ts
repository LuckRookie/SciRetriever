import { createHash, randomUUID } from "node:crypto";
import {
  canonicalJsonBytes,
  importHash,
  parseMetadataObservation,
  parseIntakeBatchId,
  parseImportCreate,
  importInteger,
  IMPORT_LIMITS,
  type ImportAdapter,
  type ImportAdapterResult,
  type ImportRecord,
  type ImportGroup,
  type ImportSession,
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
import { importAdapters } from "../literature/import-adapters.js";
import { SOURCE_TYPE_MAPPING_VERSION } from "../literature/metadata-types.js";
import {
  decodeBibliography,
  type BibliographyInputFormat,
  type BibliographyImportResult,
} from "../literature/bibliography-import.js";
import { artifactReference } from "../storage/artifact-layout.js";
import { createLogger } from "../logging/index.js";
import { CandidatePublicationError } from "../acquisition/candidate-publication.js";
import { PdfAcceptanceError } from "../acquisition/pdf-acceptance.js";
import { LiteraturePublicationError } from "../literature/primary-pdf.js";
import { BrowserTransferCollector } from "../browser/transfer.js";
import {
  BrowserDownloadResources,
  BrowserDownloadResourceError,
  type BrowserDownloadResourceOptions,
} from "../browser/resources.js";
import { CandidatePublisher } from "../acquisition/candidate-publication.js";
import { CandidateAcceptanceService } from "../acquisition/candidate-acceptance.js";
import { CandidateAbandonmentService } from "../acquisition/candidate-abandonment.js";

export class ImportSessionError extends Error {
  constructor(
    readonly code: string,
    options?: ErrorOptions,
  ) {
    super("Import session request rejected", options);
  }
}
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
    records: { created: 0, enriched: 0, matched: 0, conflicts: 0, rejected: 0 },
    files: {
      upload: 0,
      hash: 0,
      uploaded: 0,
      existing: 0,
      conflicts: 0,
      missing: 0,
    },
    annotations: { supported: 0, unsupported: 0, imported: 0, deferred: 0 },
    excluded: [],
  };
}
function publicSession(value: StoredImportSession): ImportSession {
  const { origin, summary, ...s } = value;
  void origin;
  void summary;
  return s;
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

/** Abort a waiting source without retaining a whole upload or waiting on an uncooperative iterator. */
async function* uploadChunks(
  source: AsyncIterable<Uint8Array>,
  signal: AbortSignal,
) {
  const iterator = source[Symbol.asyncIterator]();
  try {
    for (;;) {
      if (signal.aborted)
        throw new ImportSessionError("import-upload-cancelled");
      const next = await new Promise<IteratorResult<Uint8Array>>(
        (resolve, reject) => {
          const abort = () =>
            reject(new ImportSessionError("import-upload-cancelled"));
          signal.addEventListener("abort", abort, { once: true });
          Promise.resolve(iterator.next()).then(
            (value) => {
              signal.removeEventListener("abort", abort);
              resolve(value);
            },
            (error) => {
              signal.removeEventListener("abort", abort);
              reject(error);
            },
          );
          if (signal.aborted) abort();
        },
      );
      if (next.done) return;
      yield next.value;
    }
  } finally {
    void Promise.resolve()
      .then(() => iterator.return?.())
      .catch(() => undefined);
  }
}
/** Durable import workflow. Literature and Acquisition remain the owners of their facts. */
export class ImportSessionService {
  private readonly adapters: ReadonlyMap<string, ImportAdapter>;
  private readonly now: () => number;
  private readonly stop = new AbortController();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly confirmations = new Map<string, Promise<ImportSession>>();
  private readonly stopping = new Set<string>();
  private readonly uploads = new Map<string, Set<Promise<unknown>>>();
  private readonly uploadStops = new Map<string, Set<AbortController>>();
  private readonly resources: BrowserDownloadResources;
  private readonly logger = createLogger("import-sessions");
  private timer: ReturnType<typeof setInterval> | undefined;
  private maintenance: Promise<void> | undefined;
  constructor(
    private readonly database: SqliteWorker,
    private readonly identity: LiteratureIdentityService,
    private readonly folders: FolderService,
    private readonly files: FileStore,
    private readonly writes: CatalogWriteAdmission,
    private readonly recovery: ArtifactRecovery,
    options: ImportSessionOptions = {},
  ) {
    this.adapters = importAdapters(options.adapters);
    this.now = options.now ?? Date.now;
    this.resources = new BrowserDownloadResources({
      temporary_bytes: Number.MAX_SAFE_INTEGER,
      disk_reserve_bytes: IMPORT_LIMITS.disk_reserve_bytes,
      ...(options.availableBytes
        ? { available_bytes: options.availableBytes }
        : {}),
    });
    if (options.maintain !== false) {
      this.timer = setInterval(() => {
        void this.sweep().catch(() =>
          this.logger.warn("Import maintenance failed"),
        );
      }, 60_000);
      this.timer.unref();
    }
  }
  private tracked<T>(work: () => Promise<T>): Promise<T> {
    if (this.stop.signal.aborted)
      return Promise.reject(new ImportSessionError("import-closed"));
    const pending = work();
    this.pending.add(pending);
    void pending.then(
      () => this.pending.delete(pending),
      () => this.pending.delete(pending),
    );
    return pending;
  }
  private async read<T>(action: ImportRead): Promise<T> {
    const r = await this.database.run<{ ok: boolean; value: T; code?: string }>(
      { kind: "import_read", action },
    );
    if (!r.ok) throw new ImportSessionError(r.code ?? "import-unavailable");
    return r.value;
  }
  private async write<T = unknown>(action: ImportWrite): Promise<T> {
    const r = await this.database.run<{ ok: boolean; value: T; code?: string }>(
      { kind: "import_write", action },
    );
    if (!r.ok) throw new ImportSessionError(r.code ?? "import-unavailable");
    return r.value;
  }
  private stored(id: string) {
    return this.read<StoredImportSession>({ op: "session", session_id: id });
  }
  formats(): readonly string[] {
    return [...this.adapters.keys()];
  }
  status(id: string) {
    return this.tracked(async () => publicSession(await this.stored(id)));
  }
  list(cursor: string | null = null, limit = 50) {
    return this.tracked(async () => {
      const r = await this.read<{
        items: StoredImportSession[];
        next_cursor: string | null;
      }>({ op: "sessions", cursor, limit });
      return { ...r, items: r.items.map(publicSession) };
    });
  }
  create(value: unknown, actor: ImportActor) {
    return this.tracked(() =>
      this.createOwned(parseImportCreate(value), actor),
    );
  }
  private async createOwned(
    r: ReturnType<typeof parseImportCreate>,
    actor: ImportActor,
    adhocScope?: string,
  ) {
    if (!adhocScope && r.library.system === "bibliography-file")
      throw new ImportSessionError("import-input-invalid");
    if (!this.adapters.has(r.format))
      throw new ImportSessionError("import-format-unsupported");
    if (r.library.identity === "local" && actor.kind !== "device")
      throw new ImportSessionError("import-local-identity-required");
    const identity_scope =
      adhocScope ??
      (r.library.identity === "global"
        ? "global"
        : actor.kind === "device"
          ? `device:${actor.connection_id}`
          : "local");
    const now = new Date(this.now()).toISOString(),
      session_id = randomUUID();
    const s: ImportSession = {
      ...r,
      library: {
        ...r.library,
        identity: adhocScope ? "adhoc" : r.library.identity,
      },
      session_id,
      library_key: hash([
        "sciretriever.import-source.v1",
        r.library.system,
        identity_scope,
        r.library.library_id,
      ]),
      state: "collecting",
      created_at: now,
      updated_at: now,
      confirmed_at: null,
      finished_at: null,
      last_file_at: null,
      initiated_by:
        actor.kind === "device"
          ? `device:${actor.connection_id}`
          : `local:${actor.origin}`,
      intake_batch_id: null,
      metadata_complete: false,
      record_count: 0,
      processed_records: 0,
      pending_files: 0,
    };
    await this.write({
      op: "create",
      session: s,
      identity_scope,
      origin: actor.kind === "device" ? "web" : actor.origin,
    });
    return publicSession(await this.stored(session_id));
  }
  private decode(
    format: string,
    data: unknown,
    sequence: number,
  ): ImportAdapterResult {
    const adapter = this.adapters.get(format);
    if (!adapter) throw new ImportSessionError("import-format-unsupported");
    const result = adapter.decode(data, sequence);
    if (result.items.length > IMPORT_LIMITS.records)
      throw new ImportSessionError("import-session-limit");
    return result;
  }
  putData(id: string, sequence: number, data: unknown) {
    return this.tracked(async () => {
      importInteger(sequence, IMPORT_LIMITS.parts - 1);
      const s = await this.stored(id);
      if (
        ["bibtex", "biblatex", "ris", "csl-json"].includes(s.format) &&
        typeof data !== "string" &&
        s.library.identity !== "adhoc"
      )
        throw new ImportSessionError("import-input-invalid");
      const decoded = this.decode(s.format, data, sequence);
      const bytes = canonicalJsonBytes({ import_data: data });
      if (bytes.byteLength > IMPORT_LIMITS.request_bytes)
        throw new ImportSessionError("import-request-too-large");
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
        const keys: { kind: string; id: string }[] = decoded.groups.map(
          (g) => ({ kind: "group", id: g.external_id }),
        );
        for (const item of decoded.items)
          if (item.record) {
            keys.push({ kind: "record", id: item.record.external_id });
            for (const f of item.record.files)
              keys.push({ kind: "file", id: f.external_id });
          }
        await this.writes.run(async () => {
          const old = (
            await this.read<ImportPart[]>({ op: "parts", session_id: id })
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
              session_id: id,
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
        return publicSession(await this.stored(id));
      } finally {
        await stage.discard();
      }
    });
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
        session_id: s.session_id,
      }),
      groups = new Map<string, ImportGroup>(),
      references = new Set<string>(),
      summary = blank();
    for (const part of parts) {
      const data = await this.decodePart(s.format, part);
      for (const group of data.groups) groups.set(group.external_id, group);
      for (const e of data.excluded) addExcluded(summary, e.kind, e.count);
      for (const item of data.items)
        if (item.record) {
          const record = item.record,
            primary = selected(record);
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
      if (chain.has(id)) throw new ImportSessionError("import-group-cycle");
      const group = groups.get(id);
      if (!group) throw new ImportSessionError("import-group-missing");
      if (chain.size >= 128) throw new ImportSessionError("import-group-depth");
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
      legacy = s.library.system === "bibliography-file";
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
          batch_id: parseIntakeBatchId(s.intake_batch_id!),
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
        intake_batch_id: parseIntakeBatchId(s.intake_batch_id!),
        ...(mapping ? { target_literature_id: mapping.internal_id } : {}),
      });
    } catch (error) {
      if (s.library.identity !== "adhoc") throw error;
      return { disposition: "rejected", reason: "identity-failed" };
    }
  }
  preview(id: string) {
    return this.tracked(async () => {
      const s = await this.stored(id);
      if (!["collecting", "awaiting-confirmation"].includes(s.state))
        throw new ImportSessionError("import-session-state");
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
      return { session: publicSession(s), estimated: true as const, summary };
    });
  }
  confirm(id: string): Promise<ImportSession> {
    if (this.stopping.has(id))
      return Promise.reject(new ImportSessionError("import-session-state"));
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
  private async confirmOwned(id: string): Promise<ImportSession> {
    let s = await this.stored(id);
    if (
      s.state === "completed" ||
      (s.state === "importing" && s.metadata_complete)
    )
      return publicSession(s);
    const prepared = await this.prepare(s);
    await this.writes.run(async () => {
      const current = await this.read<ImportPart[]>({
        op: "parts",
        session_id: id,
      });
      if (hash(current) !== hash(prepared.parts))
        throw new ImportSessionError("import-data-changed");
      const now = new Date(this.now()).toISOString(),
        batchId = parseIntakeBatchId(randomUUID());
      const label = s.library.name.slice(0, 120);
      const batch: IntakeBatch = {
        batch_id: batchId,
        kind: "import",
        label,
        default_label: label,
        renamed: false,
        origin: s.origin,
        created_at: now,
        finished_at: null,
        status: "running",
        request: {
          format: s.format,
          file_name: s.file_name,
        },
        counts: { hits: 0, created: 0, enriched: 0, matched: 0, rejected: 0 },
        pdf: { has_pdf: 0, unavailable: 0, pending: 0 },
        discovery_run_id: null,
        source_failures: 0,
      };
      await this.write({
        op: "begin",
        session_id: id,
        batch,
        summary: prepared.summary,
        now,
      });
      s = await this.stored(id);
    });
    const groupCache = new Map<string, string>();
    for (const group of prepared.groups.keys())
      await this.writes.run(async () => {
        if (
          this.stopping.has(id) ||
          (await this.stored(id)).state !== "importing"
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
          return publicSession(await this.stored(id));
        await this.writes.run(async () => {
          const current = await this.stored(id);
          if (this.stopping.has(id) || current.state !== "importing") return;
          const old = await this.read<ImportRecordResult | null>({
            op: "result",
            session_id: id,
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
              s.library.identity === "adhoc"
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
                  disposition: "conflict",
                  reason: decision.reason,
                };
              else {
                // Replay after a process died between the identity commit and this checkpoint.
                const member = await this.read<{
                  disposition: "created" | "enriched" | "matched";
                } | null>({
                  op: "intake-member",
                  batch_id: s.intake_batch_id!,
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
                  s.library.identity === "adhoc"
                    ? null
                    : {
                        library_key: s.library_key,
                        object_kind: "record",
                        external_id: record.external_id,
                        internal_id: decision.literature_id,
                        content_sha256: content,
                        observation_id: observation.observation_id,
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
                      ? "import-folder-target-missing"
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
            session_id: id,
            item: result,
            mapping,
            files,
            now: new Date(this.now()).toISOString(),
          });
        });
      }
    const current = await this.stored(id);
    if (current.state !== "importing" || this.stopping.has(id))
      return publicSession(current);
    const aggregate = await this.read<Pick<ImportSummary, "records" | "files">>(
      { op: "aggregate", session_id: id },
    );
    await this.write({
      op: "metadata-done",
      session_id: id,
      summary: { ...prepared.summary, ...aggregate },
      now: new Date(this.now()).toISOString(),
    });
    await this.finishIfComplete(id);
    return publicSession(await this.stored(id));
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
    if (mapped) {
      if (!context.folder)
        throw new ImportSessionError("import-folder-target-missing");
      return mapped.internal_id;
    }
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
    const folder = (await this.folders.manage({
      operation: "create",
      request: { parent_id: parent, name: candidate, position: null },
    })) as { folder_id: string };
    await this.write({
      op: "mapping",
      mapping: {
        library_key: s.library_key,
        object_kind: "group",
        external_id: key,
        internal_id: folder.folder_id,
        content_sha256: null,
        observation_id: null,
      },
    });
    return folder.folder_id;
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
        ? await this.ensureFolder(s, "root", s.library.name, null)
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
    const root = await this.ensureFolder(s, "root", s.library.name, null),
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
        session_id: id,
        cursor,
        limit,
        pending,
      }),
    );
  }
  private async summary(s: StoredImportSession) {
    const counts = await this.read<Pick<ImportSummary, "records" | "files">>({
      op: "aggregate",
      session_id: s.session_id,
    });
    return { ...(s.summary ?? blank()), ...counts };
  }
  report(
    id: string,
    cursor: string | null = null,
    limit: number = IMPORT_LIMITS.page_items,
  ) {
    return this.tracked(async () => {
      const s = await this.stored(id),
        page = await this.read<{
          items: ImportRecordResult[];
          next_cursor: string | null;
        }>({ op: "results", session_id: id, cursor, limit });
      return {
        session: publicSession(s),
        estimated: false as const,
        summary: await this.summary(s),
        ...page,
      };
    });
  }
  private async cleanParts(id: string) {
    await this.writes.run(async () => {
      const parts = await this.read<ImportPart[]>({
        op: "parts",
        session_id: id,
      });
      if (!parts.length) return;
      const ticket = await this.recovery.prepare(
        parts.map((p) => ({ reference: p.reference, artifact: p.artifact })),
      );
      await this.write({ op: "retire-parts", session_id: id });
      await this.recovery.complete(ticket);
    });
  }
  private async finishIfComplete(id: string) {
    const s = await this.stored(id);
    if (s.state === "importing" && s.metadata_complete && s.pending_files === 0)
      await this.finishOwned(id, "completed");
  }
  private async finishOwned(id: string, state: "completed" | "cancelled") {
    await this.writes.run(async () => {
      const s = await this.stored(id);
      await this.write({
        op: "finish",
        session_id: id,
        state,
        summary: await this.summary(s),
        now: new Date(this.now()).toISOString(),
      });
    });
    await this.cleanParts(id);
    return publicSession(await this.stored(id));
  }
  private async terminate(id: string, state: "completed" | "cancelled") {
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
      if (s.state !== "importing" && s.state !== "completed")
        throw new ImportSessionError("import-session-state");
      if (!s.metadata_complete)
        throw new ImportSessionError("import-metadata-pending");
      return this.terminate(id, "completed");
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
        session_id: id,
        file_id: file.file_id,
      });
      if (current.status !== "pending") {
        if (current.sha256 !== sha256)
          throw new ImportSessionError("import-file-conflict");
        return current;
      }
      if ((await this.stored(id)).state !== "importing")
        throw new ImportSessionError("import-session-state");
      const mismatch =
        (current.expected_sha256 !== null &&
          current.expected_sha256 !== sha256) ||
        asset?.sha256 !== sha256;
      await this.write({
        op: "file-result",
        session_id: id,
        file_id: current.file_id,
        status: mismatch ? "conflict" : uploaded ? "uploaded" : "existing",
        sha256,
        internal_id: mismatch ? null : asset!.asset_id,
        reason: mismatch ? "import-file-conflict" : null,
        now: new Date(this.now()).toISOString(),
      });
      return this.read<ImportFileStatus>({
        op: "file",
        session_id: id,
        file_id: current.file_id,
      });
    });
    await this.finishIfComplete(id);
    return result;
  }
  reportHash(id: string, fileId: string, sha256: string) {
    return this.tracked(async () => {
      importHash(sha256);
      const file = await this.read<ImportFileStatus>({
          op: "file",
          session_id: id,
          file_id: fileId,
        }),
        facts = await this.database.currentFacts(file.literature_id);
      if (!facts?.primary_asset)
        throw new ImportSessionError("import-file-upload-required");
      return this.settleFile(id, file, sha256, facts.primary_asset, false);
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
        throw new ImportSessionError("import-session-state");
      const transfers = new BrowserTransferCollector(
        this.files,
        this.database,
        this.resources,
      );
      const acceptance = new CandidateAcceptanceService(
        this.database,
        transfers,
        new CandidatePublisher(transfers, this.database),
      );
      const abandonment = new CandidateAbandonmentService(
        this.database,
        transfers,
        this.recovery,
        this.writes,
      );

      const file = await this.read<ImportFileStatus>({
          op: "file",
          session_id: id,
          file_id: fileId,
        }),
        s = await this.stored(id);
      if (file.status !== "pending") {
        const digest = createHash("sha256");
        for await (const chunk of uploadChunks(chunks, active)) {
          if (signal?.aborted || this.stop.signal.aborted)
            throw new ImportSessionError("import-upload-cancelled");
          digest.update(chunk);
        }
        const sha = digest.digest("hex");
        if (sha !== file.sha256)
          throw new ImportSessionError("import-file-conflict");
        return file;
      }
      if (s.state !== "importing")
        throw new ImportSessionError("import-session-state");
      if (file.action === "hash")
        throw new ImportSessionError("import-file-hash-required");
      const transferId = `import-${randomUUID()}`;
      const baseline = await this.database.currentFacts(file.literature_id);
      if (!baseline) throw new ImportSessionError("import-literature-missing");
      if (baseline.primary_asset)
        throw new ImportSessionError("import-file-hash-required");
      const streamHash = createHash("sha256");
      let completed: string | null = null,
        published = false;
      try {
        await transfers.begin(
          transferId,
          Number.MAX_SAFE_INTEGER,
          {
            session_id: id,
            article_id: file.literature_id,
            page_id: "import",
            document_generation: 0,
            source_url: "https://sciretriever.local/import",
            captured_at: new Date(this.now()).toISOString(),
          },
          "import",
          file.external_id,
          active,
        );
        for await (const chunk of uploadChunks(chunks, active)) {
          if (active.aborted)
            throw new ImportSessionError("import-upload-cancelled");
          if (chunk.byteLength) {
            streamHash.update(chunk);
            await transfers.append(transferId, chunk);
          }
        }
        const candidate = await transfers.complete(transferId);
        completed = candidate.sha256;
        if (streamHash.digest("hex") !== candidate.sha256)
          throw new ImportSessionError("import-file-hash-mismatch");
        if (
          file.expected_sha256 !== null &&
          file.expected_sha256 !== candidate.sha256
        )
          throw new ImportSessionError("import-file-hash-mismatch");
        if (
          file.size_bytes !== null &&
          file.size_bytes !== candidate.size_bytes
        )
          throw new ImportSessionError("import-file-size-mismatch");
        const current = await this.stored(id);
        if (current.state !== "importing" || active.aborted)
          throw new ImportSessionError("import-upload-cancelled");
        const facts = await this.database.currentFacts(file.literature_id);
        if (!facts) throw new ImportSessionError("import-literature-missing");
        if (facts.primary_asset)
          return await this.settleFile(
            id,
            file,
            candidate.sha256,
            facts.primary_asset,
            false,
          );
        const receipt = await acceptance.accept(
          {
            receipt_id: `import-${randomUUID()}`,
            literature_id: file.literature_id,
            transfer_id: transferId,
            metadata_snapshot: baseline.metadata_snapshot,
          },
          active,
        );
        void receipt;
        published = true;
        const accepted = await this.database.currentFacts(file.literature_id);
        return await this.settleFile(
          id,
          file,
          candidate.sha256,
          accepted!.primary_asset,
          true,
        );
      } catch (error) {
        if (error instanceof CandidatePublicationError && error.bytes_published)
          published = true;
        if (active.aborted && !published)
          throw new ImportSessionError("import-upload-cancelled", {
            cause: error,
          });
        if (error instanceof PdfAcceptanceError)
          throw new ImportSessionError("import-pdf-invalid", { cause: error });
        if (error instanceof LiteraturePublicationError)
          throw new ImportSessionError(
            error.code === "primary-asset-conflict"
              ? "import-file-conflict"
              : "import-source-stale",
            { cause: error },
          );

        let current: unknown = error;
        for (let i = 0; i < 8 && current && typeof current === "object"; i++) {
          if ("code" in current && current.code === "ENOSPC")
            throw new ImportSessionError("import-disk-space", { cause: error });
          if (current instanceof BrowserDownloadResourceError)
            throw new ImportSessionError(
              current.code === "browser-download-disk-reserve"
                ? "import-disk-space"
                : "import-disk-unavailable",
              { cause: error },
            );
          current = "cause" in current ? current.cause : null;
        }
        throw error;
      } finally {
        if (completed === null) await transfers.discard(transferId);
        else if (!published)
          await abandonment.abandon({
            article_id: file.literature_id,
            transfer_id: transferId,
            sha256: completed,
          });
      }
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
      for (const s of sessions) {
        if (this.stop.signal.aborted) return;
        const deadline =
          Date.parse(
            s.state === "importing"
              ? (s.last_file_at ?? s.confirmed_at ?? s.created_at)
              : s.created_at,
          ) + IMPORT_LIMITS.expiry_ms;
        if (this.now() >= deadline)
          await this.terminate(
            s.session_id,
            s.state === "importing" ? "completed" : "cancelled",
          );
        else if (s.state === "importing" && !s.metadata_complete)
          await this.confirm(s.session_id);
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
      const decoded = decodeBibliography(bytes, format),
        adhoc = randomUUID();
      const s = await this.createOwned(
        {
          format,
          library: {
            system: "bibliography-file",
            library_id: adhoc,
            identity: "global",
            name: fileName ?? format,
          },
          scope: "single bibliography file",
          file_name: fileName,
          import_user_tags: false,
        },
        { kind: "local", origin },
        `adhoc:${adhoc}`,
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
          await this.putData(s.session_id, sequence, { legacy_decoded: items });
        const done = await this.confirm(s.session_id),
          items: ImportRecordResult[] = [];
        let cursor: string | null = null;
        do {
          const page = await this.report(s.session_id, cursor);
          items.push(...page.items);
          cursor = page.next_cursor;
        } while (cursor !== null);
        return {
          format,
          intake_batch_id: parseIntakeBatchId(done.intake_batch_id!),
          items: items.map(({ sequence, external_id, ...item }) => {
            void sequence;
            void external_id;
            return {
              ...item,
              disposition:
                item.disposition === "conflict"
                  ? ("rejected" as const)
                  : item.disposition,
            };
          }),
        };
      } catch (error) {
        await this.finishOwned(s.session_id, "cancelled");
        throw error;
      }
    });
  }
  async close() {
    this.stop.abort();
    if (this.timer) clearInterval(this.timer);
    await Promise.allSettled([...this.pending]);
  }
}
