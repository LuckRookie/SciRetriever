import { processorUsage } from "../analysis/processor-usage.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { VerifiedReaderError } from "./files/reader.js";
import {
  canonicalJsonBytes,
  processorOutcomeCounts,
  parseArtifactRef,
  parseAssetId,
  parseLiteratureId,
  parseProcessorCollection,
  parseProcessorResult,
  processorExact,
  processorJson,
  processorObject,
  processorPointer,
  processorResultBytes,
  processorText,
  sha256,
  type DocumentReadingRef,
  type EvidenceRef,
  type ProcessorCitation,
  type ProcessorCollection,
  type ProcessorRecord,
  type ProcessorRecordSource,
  type ProcessorResult,
} from "@sciretriever/contracts";
import {
  ProcessorError,
  processorError,
  resultCitations,
  type ProcessorSourceRecord,
  type ProcessorStore,
  type StoredProcessorResult,
} from "../analysis/processor.js";
import {
  DocumentReadError,
  type DocumentReadService,
} from "../document/read.js";
import { artifactReference } from "./artifact-layout.js";
import type { FileStore } from "./files/store.js";
import type {
  ProcessorProjection,
  ProcessorPublication,
  ProcessorRecordQuery,
} from "./sqlite/processor-engine.js";
import type { SqliteWorker } from "./sqlite/worker.js";

type Row = Record<string, unknown>;
export interface ResolvedProcessorEvidence {
  readonly value: unknown;
  readonly evidence: readonly EvidenceRef[];
  readonly literature_ids: readonly string[];
}
interface Verification {
  results: Map<string, StoredProcessorResult>;
  documents: Map<string, DocumentReadingRef>;
  citations: Map<string, ResolvedProcessorEvidence>;
}
function verification(): Verification {
  return { results: new Map(), documents: new Map(), citations: new Map() };
}
export class ProcessorQueryError extends Error {
  constructor(
    readonly code: string,
    readonly fields: readonly string[] = [],
  ) {
    super("processor query refused");
  }
}
function identical(a: unknown, b: unknown): boolean {
  return Buffer.from(canonicalJsonBytes(a)).equals(
    Buffer.from(canonicalJsonBytes(b)),
  );
}
export class SqliteProcessorStorage implements ProcessorStore {
  private readonly contextScope = new AsyncLocalStorage<{
    verification: Verification;
    reserve: (bytes: number) => void;
  }>();
  private closed = false;
  private readonly active = new Set<Promise<unknown>>();
  constructor(
    private readonly database: SqliteWorker,
    private readonly files: FileStore,
    private readonly documents: DocumentReadService,
  ) {}
  async close() {
    this.closed = true;
    await Promise.allSettled([...this.active]);
  }
  private async work<T>(fn: () => Promise<T>): Promise<T> {
    if (this.closed) processorError("processor-store-closed");
    const p = Promise.resolve().then(fn);
    this.active.add(p);
    try {
      return await p;
    } finally {
      this.active.delete(p);
    }
  }
  private readWork<T>(work: () => Promise<T>): Promise<T> {
    return this.work(() => this.documents.withReadScope(work));
  }
  private async bytes(row: Row, signal?: AbortSignal): Promise<unknown> {
    this.contextScope.getStore()?.reserve(Number(row.content_size));
    return this.files.withVerified(
      String(row.content_reference),
      parseArtifactRef({
        sha256: String(row.content_sha256),
        byte_size: Number(row.content_size),
        media_type: String(row.content_media_type),
      }),
      async (chunks) => {
        const parts: Uint8Array[] = [];
        for await (const part of chunks) parts.push(part);
        return JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(
            Buffer.concat(parts),
          ),
        );
      },
      { maxBytes: 8 * 1024 * 1024, ...(signal ? { signal } : {}) },
    );
  }
  byId(
    id: string,
    signal?: AbortSignal,
  ): Promise<StoredProcessorResult | null> {
    return this.readWork(() =>
      this.read(String(parseAssetId(id)), verification(), new Set(), signal),
    );
  }
  private async read(
    id: string,
    cache: Verification,
    stack: Set<string>,
    signal?: AbortSignal,
  ): Promise<StoredProcessorResult | null> {
    if (signal?.aborted) processorError("processor-cancelled");
    if (stack.has(id) || stack.size >= 32)
      processorError("processor-dependency-cycle");
    const cached = cache.results.get(id);
    if (cached) return cached;
    const row = await this.database.processor<Row | null>("get", id, signal);
    if (!row) return null;
    stack.add(id);
    try {
      const result = await parseProcessorResult(await this.bytes(row, signal));
      if (
        result.result_id !== id ||
        row.comparison_sha256 !== result.comparison_sha256 ||
        row.processor_id !== result.invocation.processor.id ||
        row.processor_version !== result.invocation.processor.version ||
        row.producer !== result.producer ||
        Boolean(row.complete) !==
          result.coverage.every((c) => c.status === "complete")
      )
        processorError("processor-result-integrity");
      const pins = await this.database.processor<{
        materials: Row[];
        documents: Row[];
        results: Row[];
      }>("pins", id, signal);
      for (const citation of resultCitations(result.content))
        await this.resolve(citation, cache, stack, signal);
      const expectedDocuments = new Map<string, DocumentReadingRef>();
      const expectedMaterials = new Map<
        string,
        import("@sciretriever/contracts").DocumentMaterialRef
      >();
      const expectedResults = new Map<string, string>();
      for (const input of result.invocation.inputs) {
        if (input.kind === "archive-document") {
          for (const part of input.parts)
            if (part.available) {
              const document = (
                await this.documents.describe(
                  { document_version_id: part.document_version_id },
                  signal,
                )
              ).document;
              if (
                document.source_material_ref.literature_id !==
                  input.literature_id ||
                document.source_material_ref.asset_id !== part.asset_id ||
                document.source_material_ref.asset_sha256 !==
                  part.asset_sha256 ||
                (await sha256(
                  canonicalJsonBytes({
                    document_version_id: part.document_version_id,
                    structure_annotation_id: part.structure_annotation_id,
                  }),
                )) !== part.content_version
              )
                processorError("processor-input-changed");
              expectedDocuments.set(document.document_version_id, document);
            }
        } else if (input.kind === "snapshot") {
          for (const source of input.mapped_results) {
            expectedResults.set(source.result_id, source.content_sha256);
            const stored = await this.read(
              source.result_id,
              cache,
              stack,
              signal,
            );
            if (!stored || stored.ref.content_sha256 !== source.content_sha256)
              processorError("processor-input-changed");
          }
        } else if (input.kind === "external") {
          if (input.document) {
            const current = (
              await this.documents.describe(
                { document_version_id: input.document.document_version_id },
                signal,
              )
            ).document;
            if (!identical(current, input.document))
              processorError("processor-input-changed");
            expectedDocuments.set(current.document_version_id, current);
          } else if (input.material)
            expectedMaterials.set(input.material.asset_id, input.material);
        }
      }
      if (
        pins.documents.length !== expectedDocuments.size ||
        pins.results.length !== expectedResults.size ||
        pins.materials.length !== expectedMaterials.size
      )
        processorError("processor-dependency-integrity");
      for (const pin of pins.materials) {
        const material = expectedMaterials.get(String(pin.asset_id));
        if (
          !material ||
          material.asset_sha256 !== pin.asset_sha256 ||
          material.literature_id !== pin.literature_id
        )
          processorError("processor-dependency-integrity");
        await this.documents.resolveEvidence(
          {
            schema_version: 1,
            target_kind: "material",
            locator_scheme: "material-file-v1",
            material,
            locator: { kind: "file" },
            content_sha256: material.asset_sha256,
          },
          signal,
        );
      }
      for (const pin of pins.documents) {
        const d = expectedDocuments.get(String(pin.document_version_id));
        const m = d?.source_material_ref;
        if (
          !d ||
          !m ||
          pin.representation_sha256 !== d.representation_sha256 ||
          pin.literature_id !== m.literature_id ||
          pin.asset_id !== m.asset_id ||
          pin.asset_sha256 !== m.asset_sha256
        )
          processorError("processor-dependency-integrity");
      }
      for (const pin of pins.results)
        if (
          expectedResults.get(String(pin.source_result_id)) !==
          pin.source_sha256
        )
          processorError("processor-dependency-integrity");
      for (const citation of resultCitations(result.content))
        await this.resolve(citation, cache, stack, signal);
      const mapped = result.invocation.inputs
        .flatMap((i) => (i.kind === "snapshot" ? i.mapped_results : []))
        .map((m) => cache.results.get(m.result_id)?.result)
        .filter((r): r is ProcessorResult => !!r);
      const freshness = await this.database.processor<
        NonNullable<StoredProcessorResult["freshness"]>
      >("freshness", id, signal);
      const oldMethod = freshness.reasons.some(
        (reason) =>
          reason !== null &&
          typeof reason === "object" &&
          "kind" in reason &&
          reason.kind === "method-changed",
      );
      const outcomes = oldMethod
        ? null
        : processorOutcomeCounts(result, mapped);
      const stored = {
        outcomes,
        freshness,
        result,
        ref: { result_id: id, content_sha256: String(row.content_sha256) },
      };
      cache.results.set(id, stored);
      return stored;
    } finally {
      stack.delete(id);
    }
  }
  byComparison(
    hash: string,
    signal?: AbortSignal,
  ): Promise<StoredProcessorResult | null> {
    return this.readWork(async () => {
      const row = await this.database.processor<Row | null>(
        "comparison",
        hash,
        signal,
      );
      return row
        ? this.read(String(row.result_id), verification(), new Set(), signal)
        : null;
    });
  }
  private async writeObject(
    kind: "processor-result" | "processor-collection",
    bytes: Uint8Array,
  ) {
    const ref = {
      sha256: await sha256(bytes),
      byte_size: bytes.length,
      media_type: "application/json",
    };
    const reference = artifactReference(kind, ref);
    const stage = await this.files.stage({ maxBytes: bytes.length });
    try {
      await stage.write(bytes);
      const file = await this.files.publish(stage, reference);
      if (file.sha256 !== ref.sha256 || file.size !== ref.byte_size)
        processorError("processor-publication-integrity");
      return { ...ref, reference };
    } finally {
      await stage.discard();
    }
  }
  publish(
    value: ProcessorResult,
    signal?: AbortSignal,
  ): Promise<StoredProcessorResult> {
    return this.work(async () => {
      const result = await parseProcessorResult(value);
      await this.verifyCitations(resultCitations(result.content), signal);
      const ref = await this.writeObject(
        "processor-result",
        processorResultBytes(result),
      );
      const publication: ProcessorPublication = {
        usage: processorUsage(result),
        outcomes: processorOutcomeCounts(
          result,
          await Promise.all(
            result.invocation.inputs
              .flatMap((i) => (i.kind === "snapshot" ? i.mapped_results : []))
              .map(async (m) => {
                const source = await this.byId(m.result_id, signal);
                if (!source || source.ref.content_sha256 !== m.content_sha256)
                  processorError("processor-input-changed");
                return source.result;
              }),
          ),
        ),
        result_id: result.result_id,
        comparison_sha256: result.comparison_sha256,
        processor_id: result.invocation.processor.id,
        processor_version: result.invocation.processor.version,
        complete: result.coverage.every((c) => c.status === "complete"),
        producer: result.producer,
        ...ref,
        created_at: result.created_at,
        inputs: result.invocation.inputs,
        reads: result.invocation.execution.reads,
        uses_description: result.invocation.execution.uses_description,
      };
      const row = await this.database.processor<Row>(
        "publish",
        publication,
        signal,
      );
      // Publication is already committed; late cancellation cannot erase it.
      const stored = await this.byId(String(row.result_id));
      if (!stored) processorError("processor-publication-integrity");
      return stored;
    });
  }
  recordRun(job_id: string, request: unknown) {
    return this.database.review("processor-request-put", {
      job_id,
      request: JSON.parse(
        Buffer.from(canonicalJsonBytes(request)).toString("utf8"),
      ),
    });
  }
  private async contentRecords(
    content: ProcessorResult["content"],
    signal?: AbortSignal,
  ): Promise<readonly ProcessorRecord[]> {
    if (signal?.aborted) processorError("processor-cancelled");
    if (content.kind === "records") return content.records;
    if (content.kind === "report")
      return content.claims.map((c) => ({
        record_id: c.record_id,
        payload: { text: c.text },
        evidence: [{ pointer: "", sources: c.sources }],
        missing: {},
      }));
    return [];
  }
  records(
    input: ProcessorRecordSource,
    signal?: AbortSignal,
  ): Promise<readonly ProcessorSourceRecord[]> {
    return this.readWork(async () => {
      const cache = verification(),
        stored = await this.read(input.result_id, cache, new Set(), signal);
      if (!stored || stored.ref.content_sha256 !== input.content_sha256)
        processorError("processor-input-changed");
      const all = await this.contentRecords(stored.result.content, signal);
      if (input.record_ids?.some((id) => !all.some((r) => r.record_id === id)))
        processorError("processor-record-missing");
      const selected = input.record_ids
        ? input.record_ids.map((id) => all.find((r) => r.record_id === id)!)
        : all;
      const result: ProcessorSourceRecord[] = [];
      for (const record of selected) {
        const citation: ProcessorCitation = {
          kind: "result",
          ...stored.ref,
          record_id: record.record_id,
          pointer: "",
        };
        const resolved = await this.resolve(citation, cache, new Set(), signal);
        result.push({
          record_id: record.record_id,
          payload: record.payload,
          citation,
          value_checks: stored.result.value_checks.filter(
            (c) => c.record_id === record.record_id,
          ),
          literature_ids: resolved.literature_ids,
        });
      }
      return result;
    });
  }
  verifyCitation(
    citation: ProcessorCitation,
    signal?: AbortSignal,
  ): Promise<ResolvedProcessorEvidence> {
    return this.readWork(() =>
      this.resolve(citation, verification(), new Set(), signal),
    );
  }
  /** Share verified dependencies only within this one bounded operation. */
  verifyCitations(
    citations: readonly ProcessorCitation[],
    signal?: AbortSignal,
  ): Promise<readonly ResolvedProcessorEvidence[]> {
    return this.readWork(async () => {
      const cache = verification();
      const results: ResolvedProcessorEvidence[] = [];
      for (const citation of citations) {
        if (signal?.aborted) throw signal.reason;
        results.push(await this.resolve(citation, cache, new Set(), signal));
      }
      return results;
    });
  }
  private async resolve(
    citation: ProcessorCitation,
    cache: Verification,
    stack: Set<string>,
    signal?: AbortSignal,
  ): Promise<ResolvedProcessorEvidence> {
    const key = JSON.stringify(citation),
      cached = cache.citations.get(key);
    if (cached) return cached;
    if (citation.kind === "snapshot") {
      const snapshot = await this.database.snapshot<
        import("@sciretriever/contracts").SnapshotHeader & {
          member: import("@sciretriever/contracts").SnapshotMember | null;
        }
      >(
        "member",
        {
          snapshot_id: citation.snapshot_id,
          literature_id: citation.literature_id,
        },
        signal,
      );
      if (snapshot.content_sha256 !== citation.content_sha256)
        processorError("processor-input-changed");
      const payload = snapshot.member
        ? processorJson({
            literature_id: snapshot.member.literature_id,
            metadata: snapshot.member.metadata,
            tags: snapshot.member.tags,
          })
        : { count: snapshot.member_count };
      const resolved = {
        value: processorPointer(payload, citation.pointer),
        evidence: [],
        literature_ids: snapshot.member ? [snapshot.member.literature_id] : [],
      };
      cache.citations.set(key, resolved);
      return resolved;
    }
    if (citation.kind === "document") {
      if (citation.evidence.content_sha256 === null)
        processorError("processor-invalid-evidence");
      const value = await this.documents.resolveEvidence(
        citation.evidence,
        signal,
      );
      if ("document" in value)
        cache.documents.set(value.document.document_version_id, value.document);
      const literature =
        citation.evidence.target_kind === "material"
          ? citation.evidence.material.literature_id
          : "document" in value
            ? value.document.source_material_ref.literature_id
            : processorError("processor-invalid-evidence");
      const resolved = {
        value,
        evidence: [citation.evidence],
        literature_ids: [literature],
      };
      cache.citations.set(key, resolved);
      return resolved;
    }
    let value: unknown;
    let sources: readonly ProcessorCitation[];
    if (citation.kind === "result") {
      const stored = await this.read(citation.result_id, cache, stack, signal);
      if (!stored || stored.ref.content_sha256 !== citation.content_sha256)
        processorError("processor-input-changed");
      const record = (
        await this.contentRecords(stored.result.content, signal)
      ).find((r) => r.record_id === citation.record_id);
      if (!record) processorError("processor-record-missing");
      value = processorPointer(record.payload, citation.pointer);
      sources = record.evidence
        .filter(
          (e) =>
            citation.pointer === "" ||
            e.pointer === "" ||
            citation.pointer === e.pointer ||
            citation.pointer.startsWith(`${e.pointer}/`),
        )
        .flatMap((e) => e.sources);
    } else processorError("processor-invalid-evidence");
    const evidence: EvidenceRef[] = [];
    const literature = new Set<string>();
    for (const source of sources) {
      const r = await this.resolve(source, cache, stack, signal);
      evidence.push(...r.evidence);
      r.literature_ids.forEach((id) => literature.add(id));
    }
    const resolved = {
      value,
      evidence,
      literature_ids: [...literature].sort(),
    };
    cache.citations.set(key, resolved);
    return resolved;
  }
  async rebuild(resultIds?: readonly string[], signal?: AbortSignal) {
    return this.work(async () => {
      await this.database.processor("repair-projections", null, signal);
      const ids = resultIds ? [...resultIds] : [];
      if (!resultIds) {
        let after = "";
        for (;;) {
          const rows = await this.database.processor<Row[]>(
            "list",
            { after, limit: 100 },
            signal,
          );
          ids.push(...rows.map((r) => String(r.result_id)));
          if (rows.length < 100) break;
          after = String(rows.at(-1)!.result_id);
        }
      }
      const scheduled = new Set(ids);
      for (const id of ids) {
        const stored = await this.byId(id, signal);
        if (!stored) processorError("processor-result-missing");
        // Snapshot map steps publish their own durable results inside the
        // processor service. Include those dependencies in the same projection
        // repair, otherwise one missing map projection invalidates all search.
        for (const input of stored.result.invocation.inputs) {
          if (input.kind !== "snapshot") continue;
          for (const dependency of input.mapped_results) {
            if (scheduled.has(dependency.result_id)) continue;
            scheduled.add(dependency.result_id);
            ids.push(dependency.result_id);
          }
        }
        const records = await this.contentRecords(
          stored.result.content,
          signal,
        );
        const p: ProcessorProjection = {
          ...stored.ref,
          records: records.map((r) => ({
            record_id: r.record_id,
            payload: r.payload,
          })),
          text: `${stored.result.invocation.processor.id} ${JSON.stringify(stored.result.invocation.spec)} ${stored.result.content.kind === "report" ? stored.result.content.text : ""}`,
        };
        await this.database.processor("project", p, signal);
      }
      if (!resultIds) {
        for (let offset = 0; ; offset += 200) {
          const rows = await this.collections(null, 200, offset);
          for (const row of rows) {
            const collection = await this.collection(
              String(row.collection_id),
              signal,
            );
            if (collection) await this.indexCollection(collection);
          }
          if (rows.length < 200) break;
        }
      }
      return { indexed: ids.length };
    });
  }
  publishCollection(value: ProcessorCollection): Promise<string> {
    return this.work(async () => {
      const collection = parseProcessorCollection(value);
      for (const member of collection.members)
        if (member.result) {
          const r = await this.database.processor<Row | null>(
            "get",
            member.result.result_id,
          );
          if (!r || r.content_sha256 !== member.result.content_sha256)
            processorError("processor-input-changed");
        }
      const ref = await this.writeObject(
        "processor-collection",
        canonicalJsonBytes(collection),
      );
      const saved = await this.database.processor<string>("collection-put", {
        ...ref,
        collection_id: collection.collection_id,
        run_id: collection.run_id,
        name: collection.name,
        processor_id: collection.processor.id,
        spec_json: JSON.stringify(collection.spec),
        created_at: new Date().toISOString(),
        members: collection.members,
      });
      await this.indexCollection(collection);
      return saved;
    });
  }
  private async indexCollection(c: ProcessorCollection) {
    await this.database.processor("collection-project", {
      collection_id: c.collection_id,
      text: `${c.name} ${c.processor.id} ${JSON.stringify(c.spec)} 文献结果 Literature results ${c.members.length} inputs`,
    });
  }
  private async indexStatus(collections = false) {
    const state = await this.database.processor<{
      stale: number;
      collections: number;
    }>("index-status", null);
    if (collections ? state.collections : state.stale)
      throw new ProcessorQueryError("processor-index-stale");
  }
  collection(
    id: string,
    signal?: AbortSignal,
  ): Promise<ProcessorCollection | null> {
    return this.readWork(async () => {
      const row = await this.database.processor<Row | null>(
        "collection-get",
        String(parseAssetId(id)),
        signal,
      );
      if (!row) return null;
      const c = parseProcessorCollection(await this.bytes(row, signal));
      if (
        c.collection_id !== id ||
        c.run_id !== row.run_id ||
        c.name !== row.name
      )
        processorError("processor-collection-integrity");
      const members = await this.database.processor<Row[]>(
        "collection-members",
        id,
        signal,
      );
      if (members.length !== c.members.length)
        processorError("processor-collection-integrity");
      for (const m of c.members) {
        const row = members.find((r) => r.target_id === m.target_id);
        if (
          !row ||
          row.result_id !== (m.result?.result_id ?? null) ||
          row.content_sha256 !== (m.result?.content_sha256 ?? null) ||
          row.gap !== m.gap
        )
          processorError("processor-collection-integrity");
        if (m.result) {
          const source = await this.database.processor<Row | null>(
            "get",
            m.result.result_id,
            signal,
          );
          if (!source || source.content_sha256 !== m.result.content_sha256)
            processorError("processor-input-changed");
        }
      }
      return c;
    });
  }
  list(
    limit = 50,
    after = "",
    signal?: AbortSignal,
    literatureId: string | null = null,
    stale: boolean | null = null,
  ) {
    return this.readWork(async () => {
      this.page(limit, 0);
      if (literatureId !== null) parseLiteratureId(literatureId);
      const rows = await this.database.processor<Row[]>(
        "list",
        { limit, after, literature_id: literatureId, stale },
        signal,
      );
      return {
        items: rows.map((r) => ({
          result_id: r.result_id,
          content_sha256: r.content_sha256,
          processor_id: r.processor_id,
          processor_version: r.processor_version,
          complete: Boolean(r.complete),
          freshness: r.freshness,
          created_at: r.created_at,
        })),
        next_after:
          rows.length === limit ? String(rows.at(-1)!.result_id) : null,
      };
    });
  }
  collections(runId: string | null = null, limit = 50, offset = 0) {
    this.page(limit, offset);
    return this.readWork(() =>
      this.database.processor<Row[]>("collections", {
        run_id: runId,
        limit,
        offset,
      }),
    );
  }
  private page(limit: number, offset: number) {
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 200 ||
      !Number.isSafeInteger(offset) ||
      offset < 0
    )
      throw new ProcessorQueryError("processor-query-invalid");
  }
  private fts(query: string) {
    processorText(query, 1024);
    return query
      .trim()
      .split(/\s+/u)
      .map((t) => `"${t.replace(/"/g, '""')}"`)
      .join(" OR ");
  }
  contextReadScope<T>(work: () => Promise<T>): Promise<T> {
    let bytes = 0;
    const reserve = (size: number) => {
      if (
        !Number.isSafeInteger(size) ||
        size < 0 ||
        bytes + size > 64 * 1024 * 1024
      )
        throw new DocumentReadError("document-budget");
      bytes += size;
    };
    return this.work(() =>
      this.contextScope.run({ verification: verification(), reserve }, () =>
        this.documents.withReadScope(work, reserve),
      ),
    );
  }
  contextPage(
    query: string,
    scope: readonly string[],
    watermark: number | null,
    after: { result_id: string; record_id: string } | null,
    signal?: AbortSignal,
  ) {
    return this.readWork(async () => {
      await this.indexStatus();
      const page = await this.database.processor<{
        watermark: number;
        row: { result_id: string; record_id: string } | null;
      }>(
        "context-search",
        { query: this.fts(query), scope, watermark, after },
        signal,
      );
      if (!page.row) return { ...page, item: null, gap: null };
      try {
        const cache =
          this.contextScope.getStore()?.verification ?? verification();
        const stored = await this.read(
          page.row.result_id,
          cache,
          new Set(),
          signal,
        );
        if (!stored) processorError("processor-index-corrupt");
        await this.checkProjection(stored);
        let text: string,
          evidence: readonly EvidenceRef[] = [];
        if (page.row.record_id) {
          const resolved = await this.resolve(
            {
              kind: "result",
              ...stored.ref,
              record_id: page.row.record_id,
              pointer: "",
            },
            cache,
            new Set(),
            signal,
          );
          text =
            typeof resolved.value === "object" &&
            resolved.value !== null &&
            "text" in resolved.value &&
            typeof resolved.value.text === "string"
              ? resolved.value.text
              : JSON.stringify(resolved.value);
          evidence = resolved.evidence;
        } else
          text =
            stored.result.content.kind === "report"
              ? stored.result.content.text
              : JSON.stringify(stored.result.content);
        return {
          ...page,
          gap: null,
          item: {
            kind: "generated-result" as const,
            reference: {
              kind: "result" as const,
              ...stored.ref,
              record_id: page.row.record_id || null,
            },
            processor_id: stored.result.invocation.processor.id,
            source_literature_ids: stored.result.literature_ids,
            text,
            evidence: evidence.slice(0, 32),
            rank: 0,
            score: 0,
            gap: evidence.length > 32 ? ("evidence-limit" as const) : null,
          },
        };
      } catch (error) {
        if (
          signal?.aborted ||
          (error instanceof DocumentReadError &&
            ["document-budget", "document-cancelled"].includes(error.code))
        )
          throw error;
        if (
          error instanceof VerifiedReaderError ||
          (error instanceof ProcessorError &&
            /integrity|input-changed|record-missing|invalid-evidence/.test(
              error.code,
            )) ||
          (error instanceof DocumentReadError &&
            [
              "document-missing",
              "document-integrity",
              "material-missing",
            ].includes(error.code))
        )
          return { ...page, item: null, gap: "result-source-unavailable" };
        throw error;
      }
    });
  }
  search(query: string, limit = 20, offset = 0) {
    this.page(limit, offset);
    return this.readWork(async () => {
      await this.indexStatus();
      const rows = await this.database.processor<Row[]>("search", {
        query: this.fts(query),
        limit,
        offset,
      });
      const items = [];
      const cache = verification();
      for (const row of rows) {
        const stored = await this.read(String(row.result_id), cache, new Set());
        if (!stored) processorError("processor-index-corrupt");
        await this.checkProjection(stored);
        if (row.record_id) {
          const records = await this.contentRecords(stored.result.content);
          const record = records.find((r) => r.record_id === row.record_id);
          if (
            !record ||
            !identical(record.payload, JSON.parse(String(row.body)))
          )
            processorError("processor-index-corrupt");
        }
        items.push({
          ...stored.ref,
          record_id: row.record_id,
          excerpt: String(row.body).slice(0, 2000),
        });
      }
      return { items };
    });
  }
  searchCollections(query: string, limit = 20, offset = 0) {
    this.page(limit, offset);
    return this.readWork(async () => {
      await this.indexStatus(true);
      return this.database.processor<Row[]>("collection-search", {
        query: this.fts(query),
        limit,
        offset,
      });
    });
  }
  private async checkProjection(stored: StoredProcessorResult) {
    const p = await this.database.processor<Row | null>(
      "projection",
      stored.ref.result_id,
    );
    if (
      !p ||
      p.content_sha256 !== stored.ref.content_sha256 ||
      p.record_count !== p.actual_count ||
      Number(p.fts_count) !== Number(p.record_count) + 1
    )
      throw new ProcessorQueryError("processor-index-stale");
  }
  query(value: unknown) {
    return this.readWork(async () => {
      const q = processorExact(value, [
        "collection_id",
        "result_ids",
        "filters",
        "sort",
        "limit",
        "offset",
      ]);
      if (typeof q.limit !== "number" || typeof q.offset !== "number")
        throw new ProcessorQueryError("processor-query-invalid");
      const limit = q.limit,
        offset = q.offset;
      this.page(limit, offset);
      if (
        !Array.isArray(q.result_ids) ||
        !Array.isArray(q.filters) ||
        q.filters.length > 20
      )
        throw new ProcessorQueryError("processor-query-invalid");
      let ids = q.result_ids.map((id) => String(parseAssetId(id)));
      if (q.collection_id !== null) {
        if (ids.length)
          throw new ProcessorQueryError("processor-query-invalid");
        const c = await this.collection(String(parseAssetId(q.collection_id)));
        if (!c) throw new ProcessorQueryError("processor-collection-missing");
        ids = c.members.flatMap((m) => (m.result ? [m.result.result_id] : []));
      }
      ids = [...new Set(ids)];
      if (ids.length > 10000)
        throw new ProcessorQueryError("processor-query-invalid");
      const sourceRecords = new Map<string, readonly ProcessorRecord[]>();
      const fields = new Set<string>();
      const fieldTypes = new Map<string, Set<string>>();
      const addSchema = (raw: unknown, keys: string[] = []) => {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
        const schema = processorObject(raw);
        if (keys.length) {
          const name =
            keys.length === 1
              ? keys[0]!
              : "/" +
                keys
                  .map((k) => k.replace(/~/g, "~0").replace(/\//g, "~1"))
                  .join("/");
          fields.add(name);
          const types = fieldTypes.get(name) ?? new Set<string>();
          fieldTypes.set(name, types);
          const ts = Array.isArray(schema.type)
            ? schema.type
            : typeof schema.type === "string"
              ? [schema.type]
              : [];
          for (const type of ts) types.add(String(type));
          if (Array.isArray(schema.enum))
            schema.enum.forEach((v) =>
              types.add(v === null ? "null" : typeof v),
            );
        }
        if (
          schema.properties &&
          typeof schema.properties === "object" &&
          !Array.isArray(schema.properties)
        )
          for (const [key, v] of Object.entries(schema.properties))
            addSchema(v, [...keys, key]);
        if (Array.isArray(schema.anyOf))
          schema.anyOf.forEach((v) => addSchema(v, keys));
      };
      for (const id of ids) {
        const stored = await this.byId(id);
        if (!stored) processorError("processor-result-missing");
        await this.checkProjection(stored);
        const records = await this.contentRecords(stored.result.content);
        sourceRecords.set(
          id,
          records.map((r) => ({
            ...r,
            value_checks: stored.result.value_checks
              .filter((c) => c.record_id === r.record_id)
              .map((c) =>
                stored.result.content.kind === "report"
                  ? { ...c, pointer: "/text" }
                  : c,
              ),
          })),
        );
        records.forEach((r) =>
          Object.keys(r.payload).forEach((k) => fields.add(k)),
        );
        if (stored.result.content.kind === "records")
          addSchema(stored.result.content.schema);
      }
      const path = (field: unknown) => {
        const name = processorText(field, 256);
        if (!fields.has(name))
          throw new ProcessorQueryError(
            "processor-field-unknown",
            [...fields].sort(),
          );
        const keys = name.startsWith("/")
          ? name
              .slice(1)
              .split("/")
              .map((k) => k.replace(/~1/g, "/").replace(/~0/g, "~"))
          : [name];
        return "$" + keys.map((k) => `.${JSON.stringify(k)}`).join("");
      };
      const filters: ProcessorRecordQuery["filters"] = q.filters.map((raw) => {
        const f = processorExact(raw, ["field", "operator", "value"]);
        if (
          !["eq", "ne", "gt", "ge", "lt", "le"].includes(String(f.operator)) ||
          !(
            f.value === null ||
            ["string", "number", "boolean"].includes(typeof f.value)
          )
        )
          throw new ProcessorQueryError("processor-query-invalid");
        const fieldPath = path(f.field),
          types = fieldTypes.get(String(f.field));
        if (
          types?.size &&
          // Null equality tests presence, including absent paths and children
          // of nullable objects; it is not a typed scalar comparison.
          !(f.value === null && (f.operator === "eq" || f.operator === "ne")) &&
          !types.has(f.value === null ? "null" : typeof f.value) &&
          !(
            typeof f.value === "number" &&
            Number.isInteger(f.value) &&
            types.has("integer")
          )
        )
          throw new ProcessorQueryError(
            "processor-field-type",
            [...fields].sort(),
          );
        return {
          path: fieldPath,
          operator:
            f.operator as ProcessorRecordQuery["filters"][number]["operator"],
          value: f.value as string | number | boolean | null,
        };
      });
      const sort =
        q.sort === null ? null : processorExact(q.sort, ["field", "direction"]);
      if (sort && !["asc", "desc"].includes(String(sort.direction)))
        throw new ProcessorQueryError("processor-query-invalid");
      const rows = await this.database.processor<Row[]>("query", {
        result_ids: ids,
        filters,
        sort: sort
          ? { path: path(sort.field), direction: sort.direction }
          : null,
        limit,
        offset,
      });
      const items = rows.map((row) => {
        const record = sourceRecords
          .get(String(row.result_id))
          ?.find((r) => r.record_id === row.record_id);
        if (
          !record ||
          !identical(record.payload, JSON.parse(String(row.payload_json)))
        )
          processorError("processor-index-corrupt");
        return { result_id: row.result_id, ...record };
      });
      return {
        items,
        fields: [...fields].sort(),
        next_offset: items.length === limit ? offset + limit : null,
      };
    });
  }
}
