import { artifactReference } from "./artifact-layout.js";
import {
  ContractValidationError,
  extractionCanonicalJsonBytes,
  parseInputManifest,
  parseAssetId,
  parseSynthesisInputManifest,
  parseSynthesisArtifact,
  sha256,
  SYNTHESIS_MAX_ARTIFACT_BYTES,
  synthesisContentBytes,
  synthesisStatementSha256,
  type DocumentMaterialRef,
  type DocumentRef,
  type DocumentReadingRef,
  type SynthesisArtifact,
  type SynthesisContent,
  type SynthesisEvidence,
  type SynthesisInputItem,
} from "@sciretriever/contracts";
import type { KnowledgeArtifact } from "@sciretriever/contracts";
import type { DocumentReadService } from "../document/read.js";
import { buildDocumentStructure } from "../document/builder.js";
import type { FileStore } from "./files/store.js";
import { VerifiedReaderError } from "./files/reader.js";
import { SqliteKnowledgeStorage } from "./knowledge.js";
import type { SqliteWorker } from "./sqlite/worker.js";

type Snapshot = {
  readonly row: Record<string, unknown>;
  readonly materials: readonly Record<string, unknown>[];
  readonly documents: readonly Record<string, unknown>[];
  readonly artifacts: readonly Record<string, unknown>[];
};
export type SynthesisSource = {
  readonly artifact: KnowledgeArtifact | SynthesisArtifact;
  readonly state: "verified" | "source-only";
};
export interface SynthesisReadResult {
  readonly artifact: SynthesisArtifact;
  /** Excluded rows remain unbound; `missing` is historical non-inclusion, not a fresh availability probe. */
  readonly current_source_states: readonly {
    readonly input_id: string;
    readonly state: "verified" | "source-only" | "missing";
  }[];
  readonly independent_literature_ids: readonly string[];
}
export class SynthesisReadError extends Error {
  constructor(
    readonly code:
      | "synthesis-integrity"
      | "synthesis-limit"
      | "synthesis-kind-unsupported"
      | "synthesis-invalid"
      | "synthesis-cancelled"
      | "synthesis-closed",
    options?: ErrorOptions,
  ) {
    super("synthesis read failed", options);
  }
}
function fail(code: SynthesisReadError["code"] = "synthesis-integrity"): never {
  throw new SynthesisReadError(code);
}
function checkCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) fail("synthesis-cancelled");
}
function readingRef(document: DocumentRef): DocumentReadingRef {
  return {
    document_id: document.document_id,
    document_version_id: document.document_version_id,
    representation_sha256: document.representation_sha256,
    source_material_ref: document.source_material_ref,
    locator_scheme: document.locator_scheme,
  };
}
function missing(error: unknown): boolean {
  let cursor: unknown = error;
  for (let index = 0; index < 8 && cursor instanceof Error; index++) {
    if (cursor instanceof VerifiedReaderError)
      return cursor.reason === "missing";
    cursor = cursor.cause;
  }
  return false;
}
function json(value: unknown, limit: number, nodes = 8192): string {
  return new TextDecoder().decode(
    extractionCanonicalJsonBytes(value, limit, {
      maxDepth: 32,
      maxNodes: nodes,
    }),
  );
}
interface ReadContext {
  readonly stack: Set<string>;
  readonly cache: Map<string, SynthesisSource>;
  readonly originCache: Map<string, Set<string>>;
  readonly documents: Map<
    string,
    {
      readonly state: "verified" | "source-only";
      readonly literature_id: string;
      readonly asset_id: string;
      readonly asset_sha256: string;
      readonly representation_sha256: string;
      readonly reading: DocumentReadingRef;
      readonly locator_scheme: string;
      readonly total_segments: number;
      readonly total_utf8_bytes: number;
      readonly segments: ReadonlyMap<string, string>;
    }
  >;
  readonly assets: Set<string>;
  readonly materials: Map<string, DocumentMaterialRef>;
  readonly verifiedMaterials: Set<string>;
  artifacts: number;
  edges: number;
  verifiedBytes: number;
  maxVerifiedBytes: number;
}
function context(maxVerifiedBytes = Number.MAX_SAFE_INTEGER): ReadContext {
  if (!Number.isSafeInteger(maxVerifiedBytes) || maxVerifiedBytes < 1)
    fail("synthesis-invalid");
  return {
    stack: new Set(),
    cache: new Map(),
    originCache: new Map(),
    documents: new Map(),
    assets: new Set(),
    materials: new Map(),
    verifiedMaterials: new Set(),
    artifacts: 0,
    edges: 0,
    verifiedBytes: 0,
    maxVerifiedBytes,
  };
}
function account(ctx: ReadContext, bytes: number): void {
  if (
    !Number.isSafeInteger(bytes) ||
    bytes < 0 ||
    !Number.isSafeInteger(ctx.verifiedBytes + bytes)
  )
    fail("synthesis-limit");
  ctx.verifiedBytes += bytes;
  if (ctx.verifiedBytes > ctx.maxVerifiedBytes) fail("synthesis-limit");
}
function accountAsset(ctx: ReadContext, hash: string, bytes: number): void {
  if (ctx.assets.has(hash)) return;
  account(ctx, bytes);
  ctx.assets.add(hash);
}
export interface SynthesisReadSession {
  /** Count bytes verified by another reader against this session's one shared limit. */
  reserveExternalVerifiedBytes(bytes: number): void;
  sourceById(id: string): Promise<SynthesisSource | null>;
  documentById(id: string): Promise<{
    readonly state: "verified" | "source-only";
    readonly literature_id: string;
    readonly asset_id: string;
    readonly asset_sha256: string;
    readonly representation_sha256: string;
    readonly reading: DocumentReadingRef;
  } | null>;
  materialById(
    literatureId: string,
    assetId: string,
  ): Promise<DocumentMaterialRef | null>;
  verifyMaterial(material: DocumentMaterialRef): Promise<void>;
  independentLiteratureIds(
    content: SynthesisContent,
    items: readonly SynthesisInputItem[],
  ): Promise<readonly string[]>;
  independentLiteratureIdsForEvidence(
    evidence: readonly SynthesisEvidence[],
    items: readonly SynthesisInputItem[],
  ): Promise<readonly string[]>;
}

/** Fixed knowledge closure reader/writer. No synthesis model or public endpoint is attached here. */
export class SqliteSynthesisStorage {
  private readonly old: SqliteKnowledgeStorage;
  private stopped = false;
  private closing: Promise<void> | undefined;
  private readonly active = new Set<Promise<unknown>>();
  constructor(
    private readonly database: SqliteWorker,
    private readonly files: FileStore,
    private readonly documents: DocumentReadService,
  ) {
    this.old = new SqliteKnowledgeStorage(database, files, documents);
  }
  close(): Promise<void> {
    if (!this.closing) {
      this.stopped = true;
      this.closing = Promise.allSettled([...this.active]).then(() =>
        this.old.close(),
      );
    }
    return this.closing;
  }
  private async run<T>(
    work: () => Promise<T>,
    signal?: AbortSignal,
    reuseVerified = true,
  ): Promise<T> {
    if (this.stopped) fail("synthesis-closed");
    if (signal?.aborted) fail("synthesis-cancelled");
    const pending = reuseVerified
      ? this.documents.withReadScope(work)
      : Promise.resolve().then(work);
    this.active.add(pending);
    try {
      return await pending;
    } catch (error) {
      if (
        signal?.aborted &&
        !(
          error instanceof SynthesisReadError &&
          error.code === "synthesis-cancelled"
        )
      )
        throw new SynthesisReadError("synthesis-cancelled", { cause: error });
      if (error instanceof SynthesisReadError) throw error;
      if (error instanceof ContractValidationError)
        throw new SynthesisReadError("synthesis-invalid", { cause: error });
      throw new SynthesisReadError("synthesis-integrity", { cause: error });
    } finally {
      this.active.delete(pending);
    }
  }
  async sourceById(
    id: string,
    signal?: AbortSignal,
  ): Promise<SynthesisSource | null> {
    return this.run(
      () => this.source(String(parseAssetId(id)), context(), signal),
      signal,
    );
  }
  /** One ordered preparation snapshot shares caches and the declared-byte limit. */
  async sourceBatchByIds(
    ids: readonly string[],
    maxVerificationBytes = Number.MAX_SAFE_INTEGER,
    signal?: AbortSignal,
  ): Promise<ReadonlyMap<string, SynthesisSource | null>> {
    if (this.stopped) fail("synthesis-closed");
    checkCancelled(signal);
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > 128)
      fail("synthesis-invalid");
    let fixed: string[];
    try {
      fixed = ids.map((id) => String(parseAssetId(id)));
    } catch (error) {
      throw new SynthesisReadError("synthesis-invalid", { cause: error });
    }
    return this.run(async () => {
      const ctx = context(maxVerificationBytes);
      const result = new Map<string, SynthesisSource | null>();
      for (const id of fixed) {
        checkCancelled(signal);
        if (!result.has(id)) result.set(id, await this.source(id, ctx, signal));
      }
      checkCancelled(signal);
      return result;
    }, signal);
  }
  async withReadSession<T>(
    consume: (session: SynthesisReadSession) => Promise<T>,
    maxVerificationBytes = Number.MAX_SAFE_INTEGER,
    signal?: AbortSignal,
  ): Promise<T> {
    const outcome = await this.run(
      async (): Promise<
        { ok: true; value: T } | { ok: false; error: unknown }
      > => {
        const ctx = context(maxVerificationBytes);
        let open = true;
        const check = () => {
          if (!open) fail("synthesis-closed");
          if (signal?.aborted) fail("synthesis-cancelled");
        };
        const session: SynthesisReadSession = Object.freeze({
          reserveExternalVerifiedBytes: (bytes: number) => {
            check();
            account(ctx, bytes);
          },
          sourceById: async (id: string) => {
            check();
            return this.source(String(parseAssetId(id)), ctx, signal);
          },
          documentById: async (id: string) => {
            check();
            const key = String(parseAssetId(id));
            const cached = ctx.documents.get(key);
            if (cached) return cached;
            const snapshot = await this.database.documentVersion(key);
            check();
            if (!snapshot) return null;
            return this.document(key, ctx, signal, snapshot);
          },
          materialById: async (literatureId: string, assetId: string) => {
            check();
            return this.materialById(literatureId, assetId, ctx, signal);
          },
          verifyMaterial: async (material: DocumentMaterialRef) => {
            check();
            await this.verifyMaterial(material, ctx, signal);
          },
          independentLiteratureIds: async (
            content: SynthesisContent,
            items: readonly SynthesisInputItem[],
          ) => {
            check();
            const origins = await this.origins(content, items, ctx, signal);
            check();
            return Object.freeze([...origins].sort());
          },
          independentLiteratureIdsForEvidence: async (
            evidence: readonly SynthesisEvidence[],
            items: readonly SynthesisInputItem[],
          ) => {
            check();
            const origins = await this.statementOrigins(
              { statement_id: "candidate", evidence },
              items,
              ctx,
              signal,
            );
            check();
            return Object.freeze([...origins].sort());
          },
        });
        try {
          const value = await consume(session);
          check();
          return { ok: true, value };
        } catch (error) {
          return { ok: false, error };
        } finally {
          open = false;
        }
      },
      signal,
    );
    if (!outcome.ok) throw outcome.error;
    return outcome.value;
  }
  async byId(
    id: string,
    signal?: AbortSignal,
  ): Promise<SynthesisReadResult | null> {
    return this.run(() => this.readById(id, signal), signal);
  }
  async byComparison(
    hash: string,
    signal?: AbortSignal,
  ): Promise<SynthesisReadResult | null> {
    return this.run(async () => {
      if (!/^[a-f0-9]{64}$/.test(hash)) fail("synthesis-invalid");
      const snapshot = await this.database.knowledge<Snapshot | null>(
        "comparison",
        hash,
        signal,
      );
      checkCancelled(signal);
      if (!snapshot) return null;
      if (snapshot.row.scope_kind !== "manifest")
        fail("synthesis-kind-unsupported");
      return this.readById(String(snapshot.row.artifact_id), signal);
    }, signal);
  }
  async list(
    manifestSha256: string | null,
    limit = 20,
    signal?: AbortSignal,
  ): Promise<readonly SynthesisReadResult[]> {
    return this.run(async () => {
      if (
        (manifestSha256 !== null && !/^[a-f0-9]{64}$/.test(manifestSha256)) ||
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > 20
      )
        fail("synthesis-invalid");
      const rows = await this.database.knowledge<
        readonly { artifact_id: string }[]
      >("list-synthesis", { manifest_sha256: manifestSha256, limit }, signal);
      const result: SynthesisReadResult[] = [];
      for (const row of rows) {
        checkCancelled(signal);
        const read = await this.readById(row.artifact_id, signal);
        if (
          !read ||
          (manifestSha256 !== null &&
            read.artifact.input.manifest_sha256 !== manifestSha256)
        )
          fail();
        result.push(read);
      }
      return Object.freeze(result);
    }, signal);
  }
  private async readById(
    id: string,
    signal?: AbortSignal,
  ): Promise<SynthesisReadResult | null> {
    const key = String(parseAssetId(id));
    const snapshot = await this.database.knowledge<Snapshot | null>(
      "id",
      key,
      signal,
    );
    checkCancelled(signal);
    if (!snapshot) return null;
    if (snapshot.row.scope_kind !== "manifest")
      fail("synthesis-kind-unsupported");
    const ctx = context();
    const source = await this.source(key, ctx, signal);
    if (!source || source.artifact.schema_version !== 2) fail();
    const artifact = source.artifact;
    const currentSourceStates = artifact.input.items.map((item) => ({
      input_id: item.input_id,
      state:
        item.kind === "knowledge"
          ? item.state === "missing"
            ? ("missing" as const)
            : (ctx.cache.get(item.source_artifact_id)?.state ??
              ("missing" as const))
          : (ctx.documents.get(item.document?.document_version_id ?? "")
              ?.state ?? ("missing" as const)),
    }));
    const origins = await this.origins(
      artifact.content,
      artifact.input.items,
      ctx,
      signal,
      artifact.artifact_id,
    );
    if (origins.size !== artifact.coverage.unique_literature_count) fail();
    checkCancelled(signal);
    return {
      artifact,
      current_source_states: Object.freeze(currentSourceStates),
      independent_literature_ids: Object.freeze([...origins].sort()),
    };
  }
  private async source(
    id: string,
    ctx: ReadContext,
    signal?: AbortSignal,
  ): Promise<SynthesisSource | null> {
    checkCancelled(signal);
    if (ctx.stack.has(id)) fail();
    const cached = ctx.cache.get(id);
    if (cached) return cached;
    if (++ctx.artifacts > 256 || ctx.stack.size >= 32) fail("synthesis-limit");
    const snapshot = await this.database.knowledge<Snapshot | null>(
      "id",
      id,
      signal,
    );
    checkCancelled(signal);
    if (!snapshot) return null;
    ctx.stack.add(id);
    try {
      if (snapshot.row.scope_kind === "literature") {
        const size = Number(snapshot.row.content_size);
        if (!Number.isSafeInteger(size) || size < 1 || size > 512 * 1024)
          fail();
        account(ctx, size);
        account(
          ctx,
          Buffer.byteLength(String(snapshot.row.manifest_json), "utf8"),
        );
        const manifest = await parseInputManifest(
          JSON.parse(String(snapshot.row.manifest_json)) as unknown,
        );
        const documentId = manifest.items[0]?.document?.document_version_id;
        if (!documentId || manifest.items.length !== 1) fail();
        const document = await this.document(documentId, ctx, signal);
        const artifact = await this.old.sourceCoreById(id, signal);
        checkCancelled(signal);
        if (!artifact) fail();
        const item = artifact.input.items[0];
        if (
          !item?.material ||
          !item.document ||
          document.literature_id !== item.literature_id ||
          document.asset_id !== item.material.asset_id ||
          document.asset_sha256 !== item.material.asset_sha256 ||
          document.representation_sha256 !== item.document.representation_sha256
        )
          fail();
        if (
          document.total_segments !== artifact.coverage.total_segments ||
          document.total_utf8_bytes !== artifact.coverage.total_utf8_bytes
        )
          fail();
        for (const statement of artifact.content.statements)
          for (const evidence of statement.evidence)
            if (
              evidence.target_kind !== "document" ||
              evidence.document_version_id !== documentId ||
              evidence.representation_sha256 !==
                document.representation_sha256 ||
              evidence.locator_scheme !== document.locator_scheme ||
              document.segments.get(evidence.locator.segment_id) !==
                evidence.content_sha256
            )
              fail();
        const source = { artifact, state: document.state };
        checkCancelled(signal);
        ctx.cache.set(id, source);
        return source;
      }
      if (snapshot.row.scope_kind !== "manifest") fail();
      const artifact = await this.core(snapshot, ctx, signal);
      let state: SynthesisSource["state"] = "verified";
      for (const item of artifact.input.items) {
        if (item.kind === "knowledge" && item.state !== "missing") {
          if (++ctx.edges > 4096) fail("synthesis-limit");
          const upstream = await this.source(
            item.source_artifact_id,
            ctx,
            signal,
          );
          if (
            !upstream ||
            upstream.artifact.content_ref.sha256 !==
              item.source_content_sha256 ||
            upstream.artifact.input.manifest_sha256 !==
              item.source_manifest_sha256 ||
            (upstream.artifact.schema_version === 1
              ? 1
              : upstream.artifact.compression_depth) !== item.compression_depth
          )
            fail();
          if (upstream.state === "source-only") state = "source-only";
        } else if (item.kind === "document" && item.document) {
          const verified = await this.document(
            item.document.document_version_id,
            ctx,
            signal,
          );
          if (
            !item.material ||
            verified.literature_id !== item.literature_id ||
            verified.asset_id !== item.material.asset_id ||
            verified.asset_sha256 !== item.material.asset_sha256 ||
            verified.representation_sha256 !==
              item.document.representation_sha256
          )
            fail();
          if (verified.state === "source-only") state = "source-only";
        }
      }
      const origins = await this.origins(
        artifact.content,
        artifact.input.items,
        ctx,
        signal,
        artifact.artifact_id,
      );
      if (origins.size !== artifact.coverage.unique_literature_count) fail();
      const result = { artifact, state };
      checkCancelled(signal);
      ctx.cache.set(id, result);
      return result;
    } finally {
      ctx.stack.delete(id);
    }
  }
  private async document(
    id: string,
    ctx: ReadContext,
    signal?: AbortSignal,
    pinned?: NonNullable<Awaited<ReturnType<SqliteWorker["documentVersion"]>>>,
  ) {
    checkCancelled(signal);
    const cached = ctx.documents.get(id);
    if (cached) return cached;
    if (ctx.documents.size >= 1024) fail("synthesis-limit");
    const snapshot = pinned ?? (await this.database.documentVersion(id));
    checkCancelled(signal);
    if (!snapshot) fail();
    const version = snapshot.version;
    accountAsset(
      ctx,
      version.source_material_ref.asset_sha256,
      version.source_material_ref.byte_size,
    );
    const declared =
      version.markdown.byte_size +
      version.structure.byte_size +
      version.resources.reduce(
        (total, item) => total + item.artifact.byte_size,
        0,
      );
    account(ctx, declared);
    let result: {
      state: "verified" | "source-only";
      literature_id: string;
      asset_id: string;
      asset_sha256: string;
      representation_sha256: string;
      reading: DocumentReadingRef;
      locator_scheme: string;
      total_segments: number;
      total_utf8_bytes: number;
      segments: ReadonlyMap<string, string>;
    };
    try {
      result = await this.documents.withVerifiedVersion(
        id,
        async (actual, bytes, structure) => {
          if (actual.representation_sha256 !== version.representation_sha256)
            fail();
          const segments = new Map<string, string>();
          for (const segment of structure.segments)
            segments.set(
              segment.segment_id,
              await sha256(
                bytes.subarray(segment.start_utf8, segment.end_utf8),
              ),
            );
          return {
            state: "verified" as const,
            literature_id: actual.source_material_ref.literature_id,
            asset_id: actual.source_material_ref.asset_id,
            asset_sha256: actual.source_material_ref.asset_sha256,
            representation_sha256: actual.representation_sha256,
            reading: readingRef(actual),
            locator_scheme: actual.locator_scheme,
            total_segments: structure.segments.length,
            total_utf8_bytes: bytes.length,
            segments,
          };
        },
        signal,
      );
    } catch (error) {
      if (!missing(error)) throw error;
      const verify = (
        path: string,
        ref: Parameters<FileStore["withVerified"]>[1],
      ) =>
        this.files.withVerified(
          path,
          ref,
          async (parts) => {
            const chunks: Uint8Array[] = [];
            for await (const part of parts) chunks.push(part);
            return Buffer.concat(chunks.map((part) => Buffer.from(part)));
          },
          { maxBytes: ref.byte_size, ...(signal ? { signal } : {}) },
        );
      try {
        await verify(
          snapshot.source_artifact_path,
          version.source_material_ref.artifact,
        );
      } catch (sourceError) {
        if (!missing(sourceError)) throw sourceError;
        const markdown = await verify(
          snapshot.markdown_artifact_path,
          version.markdown,
        );
        await verify(snapshot.structure_artifact_path, version.structure);
        const built = await buildDocumentStructure(markdown, signal);
        if (built.sha256 !== version.structure.sha256) fail();
        const segments = new Map<string, string>();
        for (const segment of built.structure.segments)
          segments.set(
            segment.segment_id,
            await sha256(
              markdown.subarray(segment.start_utf8, segment.end_utf8),
            ),
          );
        for (const resource of version.resources) {
          const path = snapshot.resource_artifact_paths[resource.reference];
          if (!path) fail();
          await verify(path, resource.artifact);
        }
        result = {
          state: "source-only",
          literature_id: version.source_material_ref.literature_id,
          asset_id: version.source_material_ref.asset_id,
          asset_sha256: version.source_material_ref.asset_sha256,
          representation_sha256: version.representation_sha256,
          reading: readingRef(version),
          locator_scheme: version.locator_scheme,
          total_segments: built.structure.segments.length,
          total_utf8_bytes: markdown.length,
          segments,
        };
        checkCancelled(signal);
        ctx.documents.set(id, result);
        return result;
      }
      throw error;
    }
    checkCancelled(signal);
    ctx.documents.set(id, result);
    return result;
  }
  private async materialById(
    literatureId: string,
    assetId: string,
    ctx: ReadContext,
    signal?: AbortSignal,
  ): Promise<DocumentMaterialRef | null> {
    checkCancelled(signal);
    const key = `${literatureId}:${assetId}`;
    const cached = ctx.materials.get(key);
    if (cached) return cached;
    const located = await this.database.documentMaterial(literatureId, assetId);
    checkCancelled(signal);
    if (!located) return null;
    const material = located.material;
    if (
      material.literature_id !== literatureId ||
      material.asset_id !== assetId
    )
      fail();
    accountAsset(ctx, material.asset_sha256, material.byte_size);
    ctx.materials.set(key, material);
    return material;
  }
  private async verifyMaterial(
    material: DocumentMaterialRef,
    ctx: ReadContext,
    signal?: AbortSignal,
  ): Promise<void> {
    checkCancelled(signal);
    const key = `${material.literature_id}:${material.asset_id}`;
    const fixed = ctx.materials.get(key);
    if (!fixed || JSON.stringify(fixed) !== JSON.stringify(material)) fail();
    if (ctx.verifiedMaterials.has(key)) return;
    const result = await this.documents.materialEvidence(
      { literature_id: material.literature_id, asset_id: material.asset_id },
      signal,
    );
    checkCancelled(signal);
    if (
      result.evidence.target_kind !== "material" ||
      JSON.stringify(result.evidence.material) !== JSON.stringify(material)
    )
      fail();
    ctx.verifiedMaterials.add(key);
  }
  private async core(
    snapshot: Snapshot,
    ctx: ReadContext,
    signal?: AbortSignal,
  ): Promise<SynthesisArtifact> {
    checkCancelled(signal);
    const row = snapshot.row;
    const ref = {
      sha256: row.content_sha256,
      byte_size: row.content_size,
      media_type: row.content_media_type,
    };
    if (
      !Number.isSafeInteger(ref.byte_size) ||
      Number(ref.byte_size) > 512 * 1024
    )
      fail();
    account(ctx, Number(ref.byte_size));
    account(
      ctx,
      Buffer.byteLength(String(row.manifest_json), "utf8") +
        Buffer.byteLength(String(row.coverage_json), "utf8"),
    );
    const bytes = await this.files.withVerified(
      String(row.content_reference),
      ref as Parameters<FileStore["withVerified"]>[1],
      async (parts) => {
        const chunks: Uint8Array[] = [];
        for await (const part of parts) chunks.push(part);
        return Buffer.concat(chunks.map((part) => Buffer.from(part)));
      },
      { maxBytes: 512 * 1024, ...(signal ? { signal } : {}) },
    );
    const content = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    ) as unknown;
    const manifest = JSON.parse(String(row.manifest_json)) as unknown;
    const coverage = JSON.parse(String(row.coverage_json)) as unknown;
    if (
      !content ||
      typeof content !== "object" ||
      !manifest ||
      typeof manifest !== "object" ||
      !coverage ||
      typeof coverage !== "object" ||
      (content as { schema_version?: unknown }).schema_version !== 2 ||
      (manifest as { schema_version?: unknown }).schema_version !== 2 ||
      (coverage as { schema_version?: unknown }).schema_version !== 2 ||
      row.scope_kind !== "manifest" ||
      row.purpose !== "synthesis"
    )
      fail();
    const parsedManifest = await parseSynthesisInputManifest(manifest);
    const artifact = await parseSynthesisArtifact({
      schema_version: 2,
      artifact_id: row.artifact_id,
      comparison_sha256: row.comparison_sha256,
      purpose: row.purpose,
      question: row.question_text,
      input: manifest,
      method: JSON.parse(String(row.method_json)) as unknown,
      content_ref: ref,
      content,
      coverage,
      provenance: JSON.parse(String(row.provenance_json)) as unknown,
      compression_depth:
        1 +
        Math.max(
          0,
          ...parsedManifest.items.map((item) =>
            item.kind === "knowledge" ? (item.compression_depth ?? 0) : 0,
          ),
        ),
    });
    if (
      row.scope_key !== artifact.input.manifest_sha256 ||
      row.manifest_sha256 !== artifact.input.manifest_sha256 ||
      row.method_id !== artifact.method.id ||
      row.method_version !== artifact.method.version ||
      row.parameters_sha256 !== artifact.method.parameters_sha256 ||
      row.question_sha256 !==
        (await sha256(new TextEncoder().encode(artifact.question)))
    )
      fail();
    const expectedMaterials = artifact.input.items.flatMap((item) =>
      item.kind === "document" && item.material
        ? [
            {
              input_id: item.input_id,
              literature_id: item.literature_id,
              asset_id: item.material.asset_id,
              asset_sha256: item.material.asset_sha256,
            },
          ]
        : [],
    );
    const expectedDocuments = artifact.input.items.flatMap((item) =>
      item.kind === "document" && item.document
        ? [
            {
              input_id: item.input_id,
              document_version_id: item.document.document_version_id,
              representation_sha256: item.document.representation_sha256,
            },
          ]
        : [],
    );
    const expectedArtifacts = artifact.input.items.flatMap((item) =>
      item.kind === "knowledge" && item.state !== "missing"
        ? [
            {
              input_id: item.input_id,
              source_artifact_id: item.source_artifact_id,
              source_content_sha256: item.source_content_sha256,
              compression_depth: item.compression_depth,
            },
          ]
        : [],
    );
    const canonicalRows = (rows: readonly Record<string, unknown>[]) =>
      JSON.stringify(
        [...rows].sort((a, b) =>
          String(a.input_id).localeCompare(String(b.input_id)),
        ),
      );
    if (
      canonicalRows(snapshot.materials) !== canonicalRows(expectedMaterials) ||
      canonicalRows(snapshot.documents) !== canonicalRows(expectedDocuments) ||
      canonicalRows(snapshot.artifacts) !== canonicalRows(expectedArtifacts)
    )
      fail();
    return artifact;
  }
  private async origins(
    content: SynthesisContent,
    items: readonly SynthesisInputItem[],
    ctx: ReadContext,
    signal?: AbortSignal,
    artifactId?: string,
  ): Promise<Set<string>> {
    checkCancelled(signal);
    const origins = new Set<string>();
    for (const statement of content.statements) {
      checkCancelled(signal);
      const actual = await this.statementOrigins(
        statement,
        items,
        ctx,
        signal,
        artifactId,
      );
      for (const id of actual) origins.add(id);
    }
    return origins;
  }
  private async statementOrigins(
    statement: Pick<
      SynthesisContent["statements"][number],
      "statement_id" | "evidence"
    >,
    items: readonly SynthesisInputItem[],
    ctx: ReadContext,
    signal?: AbortSignal,
    artifactId?: string,
  ): Promise<Set<string>> {
    checkCancelled(signal);
    const cacheKey = artifactId
      ? `${artifactId}:${statement.statement_id}`
      : undefined;
    const cached = cacheKey ? ctx.originCache.get(cacheKey) : undefined;
    if (cached) return cached;
    const byId = new Map(items.map((item) => [item.input_id, item]));
    const origins = new Set<string>();
    for (const support of statement.evidence) {
      checkCancelled(signal);
      if (++ctx.edges > 4096) fail("synthesis-limit");
      const item = byId.get(support.input_id);
      if (!item) fail();
      if (support.target_kind === "document") {
        if (item.kind !== "document" || !item.document) fail();
        const doc = await this.document(
          item.document.document_version_id,
          ctx,
          signal,
        );
        const expected = doc.segments.get(support.evidence.locator.segment_id);
        if (
          expected !== support.evidence.content_sha256 ||
          support.evidence.locator_scheme !== doc.locator_scheme ||
          support.evidence.representation_sha256 !== doc.representation_sha256
        )
          fail();
        origins.add(doc.literature_id);
      } else {
        if (item.kind !== "knowledge") fail();
        const upstream = ctx.cache.get(item.source_artifact_id);
        if (!upstream) fail();
        const sourceStatement = upstream.artifact.content.statements.find(
          (entry) => entry.statement_id === support.statement_id,
        );
        if (
          !sourceStatement ||
          (await synthesisStatementSha256(sourceStatement)) !==
            support.statement_sha256
        )
          fail();
        if (upstream.artifact.schema_version === 1)
          origins.add(upstream.artifact.input.items[0]!.literature_id);
        else {
          const child = await this.statementOrigins(
            sourceStatement as SynthesisContent["statements"][number],
            upstream.artifact.input.items,
            ctx,
            signal,
            upstream.artifact.artifact_id,
          );
          for (const key of child) origins.add(key);
        }
      }
    }
    if (cacheKey) ctx.originCache.set(cacheKey, origins);
    return origins;
  }
  async publish(
    value: SynthesisArtifact,
    signal?: AbortSignal,
  ): Promise<{
    readonly artifact: SynthesisArtifact;
    readonly published: boolean;
  }> {
    if (this.stopped) fail("synthesis-closed");
    checkCancelled(signal);
    let fixed: unknown;
    try {
      fixed = JSON.parse(
        new TextDecoder().decode(
          extractionCanonicalJsonBytes(value, SYNTHESIS_MAX_ARTIFACT_BYTES, {
            maxDepth: 33,
            maxNodes: 20480,
          }),
        ),
      ) as unknown;
    } catch (error) {
      throw new SynthesisReadError("synthesis-invalid", { cause: error });
    }
    const parsed = parseSynthesisArtifact(fixed);
    return this.run(
      async () => this.publishInner(await parsed, signal),
      signal,
      false,
    );
  }
  private async publishInner(
    artifact: SynthesisArtifact,
    signal?: AbortSignal,
  ): Promise<{
    readonly artifact: SynthesisArtifact;
    readonly published: boolean;
  }> {
    if (
      ![7, 8, 9, 10].includes(
        Number((await this.database.schema()).schema_version),
      )
    )
      fail();
    const ctx = context();
    for (const item of artifact.input.items) {
      if (item.kind === "knowledge" && item.state !== "missing") {
        const source = await this.source(item.source_artifact_id, ctx, signal);
        if (
          !source ||
          source.artifact.content_ref.sha256 !== item.source_content_sha256 ||
          source.artifact.input.manifest_sha256 !==
            item.source_manifest_sha256 ||
          source.state !==
            (item.state === "source-only" ? "source-only" : "verified")
        )
          fail();
      } else if (item.kind === "document" && item.document) {
        const doc = await this.document(
          item.document.document_version_id,
          ctx,
          signal,
        );
        if (
          doc.state !== "verified" ||
          doc.literature_id !== item.literature_id ||
          !item.material ||
          doc.asset_id !== item.material.asset_id ||
          doc.asset_sha256 !== item.material.asset_sha256 ||
          doc.representation_sha256 !== item.document.representation_sha256
        )
          fail();
      } else if (item.kind === "document" && item.material) {
        const material = await this.documents.materialEvidence(
          {
            literature_id: item.literature_id,
            asset_id: item.material.asset_id,
          },
          signal,
        );
        if (
          material.evidence.target_kind !== "material" ||
          JSON.stringify(material.evidence.material) !==
            JSON.stringify(item.material) ||
          (await this.database.documentDefault(
            item.literature_id,
            item.material.asset_id,
            item.material.asset_sha256,
          ))
        )
          fail();
      }
    }
    const origins = await this.origins(
      artifact.content,
      artifact.input.items,
      ctx,
      signal,
      artifact.artifact_id,
    );
    if (origins.size !== artifact.coverage.unique_literature_count) fail();
    if (signal?.aborted) fail("synthesis-cancelled");
    const bytes = synthesisContentBytes(artifact.content);
    const located = await this.database.locateArtifact(artifact.content_ref);
    const reference =
      located?.reference ??
      artifactReference("knowledge-synthesis", artifact.content_ref);
    const stage = await this.files.stage({ maxBytes: bytes.length });
    try {
      await stage.write(bytes);
      const published = await this.files.withWrite(
        () => this.files.publish(stage, reference),
        signal,
      );
      if (
        published.sha256 !== artifact.content_ref.sha256 ||
        published.size !== bytes.length ||
        published.reference !== reference
      )
        fail();
    } finally {
      await stage.discard();
    }
    if (signal?.aborted) fail("synthesis-cancelled");
    const materials = artifact.input.items.flatMap((item) =>
      item.kind === "document" && item.material
        ? [
            {
              input_id: item.input_id,
              literature_id: item.literature_id,
              asset_id: item.material.asset_id,
              asset_sha256: item.material.asset_sha256,
              asset_byte_size: item.material.byte_size,
            },
          ]
        : [],
    );
    const documents = artifact.input.items.flatMap((item) =>
      item.kind === "document" && item.document && item.material
        ? [
            {
              input_id: item.input_id,
              literature_id: item.literature_id,
              asset_id: item.material.asset_id,
              asset_sha256: item.material.asset_sha256,
              asset_byte_size: item.material.byte_size,
              document_version_id: item.document.document_version_id,
              representation_sha256: item.document.representation_sha256,
            },
          ]
        : [],
    );
    const artifacts = artifact.input.items.flatMap((item) =>
      item.kind === "knowledge" && item.state !== "missing"
        ? [
            {
              input_id: item.input_id,
              source_artifact_id: item.source_artifact_id,
              source_content_sha256: item.source_content_sha256!,
              source_manifest_sha256: item.source_manifest_sha256!,
              compression_depth: item.compression_depth!,
            },
          ]
        : [],
    );
    const missing_knowledge = artifact.input.items.flatMap((item) =>
      item.kind === "knowledge" && item.state === "missing"
        ? [item.source_artifact_id]
        : [],
    );
    const missing_pdf_literatures = artifact.input.items.flatMap((item) =>
      item.kind === "document" && item.material === null
        ? [item.literature_id]
        : [],
    );
    const missing_documents = artifact.input.items.flatMap((item) =>
      item.kind === "document" && item.material && !item.document
        ? [
            {
              literature_id: item.literature_id,
              asset_id: item.material.asset_id,
              asset_sha256: item.material.asset_sha256,
            },
          ]
        : [],
    );
    const result = await this.database.knowledge<{
      artifact_id: string;
      published: boolean;
    }>(
      "publish-synthesis",
      {
        artifact_id: artifact.artifact_id,
        comparison_sha256: artifact.comparison_sha256,
        scope_kind: "manifest",
        scope_key: artifact.input.manifest_sha256,
        purpose: "synthesis",
        question_sha256: await sha256(
          new TextEncoder().encode(artifact.question),
        ),
        question_text: artifact.question,
        manifest_sha256: artifact.input.manifest_sha256,
        manifest_json: json(artifact.input, 262234, 8193),
        method_id: artifact.method.id,
        method_version: artifact.method.version,
        parameters_sha256: artifact.method.parameters_sha256,
        method_json: json(artifact.method, 16384),
        content_sha256: artifact.content_ref.sha256,
        content_size: artifact.content_ref.byte_size,
        content_media_type: artifact.content_ref.media_type,
        content_reference: reference,
        coverage_json: json(artifact.coverage, 65536),
        provenance_json: json(artifact.provenance, 16384),
        created_at: artifact.provenance.generated_at,
        input: {
          materials,
          documents,
          artifacts,
          missing_knowledge,
          missing_pdf_literatures,
          missing_documents,
        },
      },
      signal,
    );
    if (result.published) return { artifact, published: true };
    const stored = await this.readById(result.artifact_id);
    if (!stored) fail();
    return { artifact: stored.artifact, published: result.published };
  }
}
