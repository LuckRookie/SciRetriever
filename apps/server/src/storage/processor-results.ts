import {
  canonicalJsonBytes,
  parseAssetId,
  parseArtifactRef,
  parseProcessorResult,
  parseProcessorCollection,
  processorResultBytes,
  processorPointer,
  processorJson,
  processorExact,
  processorText,
  sha256,
  type EvidenceRef,
  type DocumentReadingRef,
  type ProcessorCitation,
  type ProcessorInput,
  type ProcessorCollection,
  type ProcessorRecord,
  processorObject,
  type ProcessorResult,
} from "@sciretriever/contracts";
import {
  processorError,
  resultCitations,
  type ProcessorStore,
  type StoredProcessorResult,
  type ProcessorSourceRecord,
} from "../analysis/processor.js";
import type { DocumentReadService } from "../document/read.js";
import type { SqliteSynthesisStorage } from "./synthesis.js";
import type { FileStore } from "./files/store.js";
import type { SqliteWorker } from "./sqlite/worker.js";
import { artifactReference } from "./artifact-layout.js";
import type {
  ProcessorPublication,
  ProcessorProjection,
  ProcessorRecordQuery,
} from "./sqlite/processor-engine.js";

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
  private closed = false;
  private readonly active = new Set<Promise<unknown>>();
  constructor(
    private readonly database: SqliteWorker,
    private readonly files: FileStore,
    private readonly documents: DocumentReadService,
    private readonly knowledge: SqliteSynthesisStorage,
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
  private async bytes(row: Row, signal?: AbortSignal): Promise<unknown> {
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
    return this.work(() =>
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
        knowledge: Row[];
      }>("pins", id, signal);
      for (const citation of resultCitations(result.content))
        await this.resolve(citation, cache, stack, signal);
      const expectedDocuments = new Map<
        string,
        Extract<ProcessorInput, { kind: "document" }>
      >();
      const expectedResults = new Map<string, string>();
      const expectedKnowledge = new Map<string, string>();
      const materials = result.invocation.inputs.filter(
        (i) => i.kind === "material",
      );
      if (
        pins.materials.length !==
        new Set(materials.map((i) => i.material.asset_id)).size
      )
        processorError("processor-dependency-integrity");
      for (const pin of pins.materials) {
        const m = materials.find(
          (i) => i.material.asset_id === pin.asset_id,
        )?.material;
        if (
          !m ||
          m.asset_sha256 !== pin.asset_sha256 ||
          m.literature_id !== pin.literature_id
        )
          processorError("processor-dependency-integrity");
        await this.documents.resolveEvidence(
          {
            schema_version: 1,
            target_kind: "material",
            locator_scheme: "material-file-v1",
            material: m,
            locator: { kind: "file" },
            content_sha256: m.asset_sha256,
          },
          signal,
        );
      }
      for (const input of result.invocation.inputs) {
        if (input.kind === "document") {
          expectedDocuments.set(input.document.document_version_id, input);
          const current =
            cache.documents.get(input.document.document_version_id) ??
            (
              await this.documents.describe(
                { document_version_id: input.document.document_version_id },
                signal,
              )
            ).document;
          cache.documents.set(current.document_version_id, current);
          if (!identical(current, input.document))
            processorError("processor-input-changed");
        } else if (input.kind === "result") {
          expectedResults.set(input.result_id, input.content_sha256);
          const source = await this.read(input.result_id, cache, stack, signal);
          if (!source || source.ref.content_sha256 !== input.content_sha256)
            processorError("processor-input-changed");
          if (input.record_ids) {
            const records = await this.contentRecords(
              source.result.content,
              signal,
            );
            if (
              input.record_ids.some(
                (id) => !records.some((r) => r.record_id === id),
              )
            )
              processorError("processor-record-missing");
          }
        } else if (input.kind === "knowledge")
          expectedKnowledge.set(input.artifact_id, input.content_sha256);
      }
      if (result.content.kind === "knowledge")
        expectedKnowledge.set(
          result.content.artifact_id,
          result.content.content_sha256,
        );
      if (
        pins.documents.length !== expectedDocuments.size ||
        pins.results.length !== expectedResults.size ||
        pins.knowledge.length !== expectedKnowledge.size
      )
        processorError("processor-dependency-integrity");
      for (const pin of pins.documents) {
        const d = expectedDocuments.get(
          String(pin.document_version_id),
        )?.document;
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
      for (const pin of pins.knowledge) {
        const hash = expectedKnowledge.get(String(pin.artifact_id));
        if (hash !== pin.content_sha256)
          processorError("processor-dependency-integrity");
        const source = await this.knowledge.sourceById(
          String(pin.artifact_id),
          signal,
        );
        if (!source || source.artifact.content_ref.sha256 !== hash)
          processorError("processor-input-changed");
      }
      for (const citation of resultCitations(result.content))
        await this.resolve(citation, cache, stack, signal);
      const stored = {
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
    return this.work(async () => {
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
        result_id: result.result_id,
        comparison_sha256: result.comparison_sha256,
        processor_id: result.invocation.processor.id,
        processor_version: result.invocation.processor.version,
        complete: result.coverage.every((c) => c.status === "complete"),
        producer: result.producer,
        ...ref,
        created_at: result.created_at,
        inputs: result.invocation.inputs,
        knowledge: result.content.kind === "knowledge" ? result.content : null,
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
  private async contentRecords(
    content: ProcessorResult["content"],
    signal?: AbortSignal,
  ): Promise<readonly ProcessorRecord[]> {
    if (content.kind === "records") return content.records;
    if (content.kind === "text")
      return [
        {
          record_id: "text",
          payload: { text: content.text },
          evidence: content.evidence.length
            ? [{ pointer: "", sources: content.evidence }]
            : [],
          missing: {},
        },
      ];
    const source = await this.knowledge.sourceById(content.artifact_id, signal);
    if (
      !source ||
      source.artifact.content_ref.sha256 !== content.content_sha256
    )
      processorError("processor-input-changed");
    return source.artifact.content.statements.map((s) => ({
      record_id: s.statement_id,
      payload: processorJson({
        text: s.text,
        category: s.category,
        epistemic: s.epistemic,
        conditions: s.conditions,
        quantity: s.quantity,
      }),
      evidence: [
        {
          pointer: "",
          sources: [
            {
              kind: "knowledge",
              artifact_id: content.artifact_id,
              content_sha256: content.content_sha256,
              statement_id: s.statement_id,
            },
          ],
        },
      ],
      missing: {},
    }));
  }
  records(
    input: Extract<ProcessorInput, { kind: "result" | "knowledge" }>,
    signal?: AbortSignal,
  ): Promise<readonly ProcessorSourceRecord[]> {
    return this.work(async () => {
      const cache = verification();
      let content: ProcessorResult["content"];
      let ref: { result_id: string; content_sha256: string } | null = null;
      if (input.kind === "result") {
        const stored = await this.read(
          input.result_id,
          cache,
          new Set(),
          signal,
        );
        if (!stored || stored.ref.content_sha256 !== input.content_sha256)
          processorError("processor-input-changed");
        content = stored.result.content;
        ref = stored.ref;
      } else
        content = {
          kind: "knowledge",
          artifact_id: input.artifact_id,
          content_sha256: input.content_sha256,
        };
      const all = await this.contentRecords(content, signal);
      const selected = input.kind === "result" ? input.record_ids : null;
      if (selected?.some((id) => !all.some((r) => r.record_id === id)))
        processorError("processor-record-missing");
      const records = selected
        ? selected.map((id) => all.find((r) => r.record_id === id)!)
        : all;
      const result: ProcessorSourceRecord[] = [];
      for (const record of records) {
        const citation: ProcessorCitation = ref
          ? { kind: "result", ...ref, record_id: record.record_id, pointer: "" }
          : {
              kind: "knowledge",
              artifact_id: (
                content as Extract<typeof content, { kind: "knowledge" }>
              ).artifact_id,
              content_sha256: input.content_sha256,
              statement_id: record.record_id,
            };
        const resolved = await this.resolve(citation, cache, new Set(), signal);
        result.push({
          record_id: record.record_id,
          payload: record.payload,
          citation,
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
    return this.work(() =>
      this.resolve(citation, verification(), new Set(), signal),
    );
  }
  /** Share verified dependencies only within this one bounded operation. */
  verifyCitations(
    citations: readonly ProcessorCitation[],
    signal?: AbortSignal,
  ): Promise<readonly ResolvedProcessorEvidence[]> {
    return this.work(async () => {
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
    let knowledgeKey: string | undefined;
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
    } else {
      const key = `knowledge:${citation.artifact_id}:${citation.statement_id}`;
      if (stack.has(key) || stack.size >= 32)
        processorError("processor-dependency-cycle");
      knowledgeKey = key;
      stack.add(key);
      const source = await this.knowledge.sourceById(
        citation.artifact_id,
        signal,
      );
      if (
        !source ||
        source.artifact.content_ref.sha256 !== citation.content_sha256
      )
        processorError("processor-input-changed");
      const statement = source.artifact.content.statements.find(
        (s) => s.statement_id === citation.statement_id,
      );
      if (!statement) processorError("processor-record-missing");
      value = statement.text;
      sources = statement.evidence.map((e) =>
        "schema_version" in e
          ? { kind: "document" as const, evidence: e }
          : e.target_kind === "document"
            ? { kind: "document" as const, evidence: e.evidence }
            : {
                kind: "knowledge" as const,
                artifact_id: e.source_artifact_id,
                content_sha256: e.source_content_sha256,
                statement_id: e.statement_id,
              },
      );
    }
    const evidence: EvidenceRef[] = [];
    const literature = new Set<string>();
    for (const source of sources) {
      const r = await this.resolve(source, cache, stack, signal);
      evidence.push(...r.evidence);
      r.literature_ids.forEach((id) => literature.add(id));
    }
    if (knowledgeKey) stack.delete(knowledgeKey);
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
      for (const id of ids) {
        const stored = await this.byId(id, signal);
        if (!stored) processorError("processor-result-missing");
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
          text: `${stored.result.invocation.processor.id} ${JSON.stringify(stored.result.invocation.spec)} ${stored.result.content.kind === "text" ? stored.result.content.text : ""}`,
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
    return this.work(async () => {
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
  list(limit = 50, after = "", signal?: AbortSignal) {
    return this.work(async () => {
      this.page(limit, 0);
      const rows = await this.database.processor<Row[]>(
        "list",
        { limit, after },
        signal,
      );
      return {
        items: rows.map((r) => ({
          result_id: r.result_id,
          content_sha256: r.content_sha256,
          processor_id: r.processor_id,
          processor_version: r.processor_version,
          complete: Boolean(r.complete),
          created_at: r.created_at,
        })),
        next_after:
          rows.length === limit ? String(rows.at(-1)!.result_id) : null,
      };
    });
  }
  collections(runId: string | null = null, limit = 50, offset = 0) {
    this.page(limit, offset);
    return this.work(() =>
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
  search(query: string, limit = 20, offset = 0) {
    this.page(limit, offset);
    return this.work(async () => {
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
    return this.work(async () => {
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
    return this.work(async () => {
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
        sourceRecords.set(id, records);
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
