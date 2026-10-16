import { artifactReference } from "./artifact-layout.js";
import {
  ContractValidationError,
  extractionCanonicalJsonBytes,
  knowledgeContentBytes,
  parseAssetId,
  parseLiteratureId,
  parseKnowledgeArtifact,
  sha256,
  type KnowledgeArtifact,
} from "@sciretriever/contracts";
import type { KnowledgeStoragePort } from "../analysis/knowledge-port.js";
import type { DocumentReadService } from "../document/read.js";
import type { FileStore } from "./files/store.js";
import type { SqliteWorker } from "./sqlite/worker.js";

interface Snapshot {
  readonly row: Record<string, unknown>;
  readonly materials: readonly Record<string, unknown>[];
  readonly documents: readonly Record<string, unknown>[];
  readonly artifacts: readonly Record<string, unknown>[];
}
function fail(): never {
  throw new KnowledgeReadError("knowledge-integrity");
}
export class KnowledgeReadError extends Error {
  constructor(
    readonly code:
      | "knowledge-integrity"
      | "knowledge-cancelled"
      | "knowledge-closed"
      | "knowledge-invalid"
      | "knowledge-kind-unsupported",
    options?: ErrorOptions,
  ) {
    super("knowledge read failed", options);
  }
}
function json(value: unknown, maxBytes: number): string {
  return new TextDecoder().decode(
    extractionCanonicalJsonBytes(value, maxBytes),
  );
}

/** Storage verifies fixed bytes and references; Analysis alone decides what content to accept. */
export class SqliteKnowledgeStorage implements KnowledgeStoragePort {
  private stopped = false;
  private closing: Promise<void> | undefined;
  private readonly active = new Set<Promise<unknown>>();
  constructor(
    private readonly database: SqliteWorker,
    private readonly files: FileStore,
    private readonly documentRead: DocumentReadService,
  ) {}
  close(): Promise<void> {
    if (!this.closing) {
      this.stopped = true;
      this.closing = Promise.allSettled([...this.active]).then(() => undefined);
    }
    return this.closing;
  }
  private async read<T>(
    work: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    if (this.stopped) throw new KnowledgeReadError("knowledge-closed");
    if (signal?.aborted) throw new KnowledgeReadError("knowledge-cancelled");
    const operation = Promise.resolve().then(work);
    this.active.add(operation);
    try {
      return await operation;
    } catch (error) {
      if (error instanceof KnowledgeReadError) throw error;
      if (error instanceof ContractValidationError)
        throw new KnowledgeReadError("knowledge-invalid", { cause: error });
      throw new KnowledgeReadError(
        signal?.aborted ? "knowledge-cancelled" : "knowledge-integrity",
        { cause: error },
      );
    } finally {
      this.active.delete(operation);
    }
  }

  async byId(
    id: string,
    signal?: AbortSignal,
  ): Promise<KnowledgeArtifact | null> {
    return this.read(
      () => this.rawById(String(parseAssetId(id)), signal),
      signal,
    );
  }
  private async rawById(
    id: string,
    signal?: AbortSignal,
  ): Promise<KnowledgeArtifact | null> {
    const snapshot = await this.database.knowledge<Snapshot | null>(
      "id",
      id,
      signal,
    );
    if (snapshot?.row.scope_kind === "manifest")
      throw new KnowledgeReadError("knowledge-kind-unsupported");
    return snapshot ? this.verify(snapshot, signal) : null;
  }
  async byComparison(
    hash: string,
    signal?: AbortSignal,
  ): Promise<KnowledgeArtifact | null> {
    return this.read(async () => {
      if (!/^[a-f0-9]{64}$/.test(hash))
        throw new KnowledgeReadError("knowledge-invalid");
      const snapshot = await this.database.knowledge<Snapshot | null>(
        "comparison",
        hash,
        signal,
      );
      if (snapshot?.row.scope_kind === "manifest")
        throw new KnowledgeReadError("knowledge-kind-unsupported");
      return snapshot ? this.verify(snapshot, signal) : null;
    }, signal);
  }
  /** Restricted internal projection: validates stored knowledge bytes and
   * catalog relations only. It never establishes original evidence validity;
   * only the bounded synthesis reader may classify source-only. */
  async sourceCoreById(
    id: string,
    signal?: AbortSignal,
  ): Promise<KnowledgeArtifact | null> {
    return this.read(async () => {
      const snapshot = await this.database.knowledge<Snapshot | null>(
        "id",
        String(parseAssetId(id)),
        signal,
      );
      if (!snapshot) return null;
      if (snapshot.row.scope_kind !== "literature")
        throw new KnowledgeReadError("knowledge-kind-unsupported");
      return this.verifyCore(snapshot, signal);
    }, signal);
  }
  async list(
    literatureId: string,
    limit = 20,
    signal?: AbortSignal,
  ): Promise<readonly KnowledgeArtifact[]> {
    return this.read(async () => {
      const key = String(parseLiteratureId(literatureId));
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20)
        throw new KnowledgeReadError("knowledge-invalid");
      const rows = await this.database.knowledge<
        readonly { artifact_id: string }[]
      >("list", { literature_id: key, limit }, signal);
      const artifacts: KnowledgeArtifact[] = [];
      for (const row of rows) {
        if (signal?.aborted)
          throw new KnowledgeReadError("knowledge-cancelled");
        const artifact = await this.rawById(row.artifact_id, signal);
        if (!artifact) fail();
        artifacts.push(artifact);
      }
      return artifacts;
    }, signal);
  }
  async default(
    literatureId: string,
    purpose: string,
    questionHash: string,
    signal?: AbortSignal,
  ): Promise<{ artifact_id: string; revision: number } | null> {
    return this.read(async () => {
      const key = String(parseLiteratureId(literatureId));
      if (
        !["overview", "detailed", "question"].includes(purpose) ||
        !/^[a-f0-9]{64}$/.test(questionHash)
      )
        throw new KnowledgeReadError("knowledge-invalid");
      const pointer = await this.database.knowledge<{
        artifact_id: string;
        revision: number;
      } | null>(
        "default",
        {
          scope_key: key,
          purpose,
          question_sha256: questionHash,
        },
        signal,
      );
      if (!pointer) return null;
      const artifact = await this.rawById(pointer.artifact_id, signal);
      if (
        !artifact ||
        artifact.input.items[0]?.literature_id !== key ||
        artifact.purpose !== purpose ||
        (await sha256(new TextEncoder().encode(artifact.question ?? ""))) !==
          questionHash ||
        !Number.isSafeInteger(pointer.revision) ||
        pointer.revision < 1
      )
        fail();
      return pointer;
    }, signal);
  }
  async publish(
    artifact: KnowledgeArtifact,
    signal?: AbortSignal,
  ): Promise<{ artifact: KnowledgeArtifact; published: boolean }> {
    const parsed = await parseKnowledgeArtifact(artifact);
    const item = parsed.input.items[0];
    if (
      !item?.material ||
      !item.document ||
      parsed.input.items.length !== 1 ||
      parsed.purpose === "synthesis"
    )
      fail();
    const bytes = knowledgeContentBytes(parsed.content);
    const located = await this.database.locateArtifact(parsed.content_ref);
    const reference =
      located?.reference ??
      artifactReference("knowledge-summary", parsed.content_ref);
    const stage = await this.files.stage({ maxBytes: bytes.length });
    try {
      await stage.write(bytes);
      const file = await this.files.publish(stage, reference);
      if (
        file.sha256 !== parsed.content_ref.sha256 ||
        file.size !== bytes.length ||
        file.reference !== reference
      )
        fail();
    } finally {
      await stage.discard();
    }
    const questionHash = await sha256(
      new TextEncoder().encode(parsed.question ?? ""),
    );
    const result = await this.database.knowledge<{
      artifact_id: string;
      published: boolean;
    }>(
      "publish",
      {
        artifact_id: parsed.artifact_id,
        comparison_sha256: parsed.comparison_sha256,
        scope_kind: "literature",
        scope_key: item.literature_id,
        purpose: parsed.purpose,
        question_sha256: questionHash,
        question_text: parsed.question,
        manifest_sha256: parsed.input.manifest_sha256,
        manifest_json: json(parsed.input, 262234),
        method_id: parsed.method.id,
        method_version: parsed.method.version,
        parameters_sha256: parsed.method.parameters_sha256,
        method_json: json(parsed.method, 16384),
        content_sha256: parsed.content_ref.sha256,
        content_size: parsed.content_ref.byte_size,
        content_media_type: parsed.content_ref.media_type,
        content_reference: reference,
        coverage_json: json(parsed.coverage, 16384),
        provenance_json: json(parsed.provenance, 16384),
        created_at: parsed.provenance.generated_at,
        input: {
          input_id: item.input_id,
          literature_id: item.literature_id,
          asset_id: item.material.asset_id,
          asset_sha256: item.material.asset_sha256,
          asset_byte_size: item.material.byte_size,
          document_version_id: item.document.document_version_id,
          representation_sha256: item.document.representation_sha256,
        },
      },
      signal,
    );
    const stored = await this.byId(result.artifact_id);
    if (!stored) fail();
    return { artifact: stored, published: result.published };
  }
  updateDefault(
    input: Parameters<KnowledgeStoragePort["updateDefault"]>[0],
    signal?: AbortSignal,
  ): Promise<{ updated: boolean; revision: number | null }> {
    return this.database.knowledge(
      "update-default",
      {
        scope_key: input.literature_id,
        purpose: input.purpose,
        question_sha256: input.question_sha256,
        artifact_id: input.artifact_id,
        expected_revision: input.expected_revision,
      },
      signal,
    );
  }

  private async verifyCore(
    snapshot: Snapshot,
    signal?: AbortSignal,
  ): Promise<KnowledgeArtifact> {
    const row = snapshot.row;
    const ref = {
      sha256: row.content_sha256,
      byte_size: row.content_size,
      media_type: row.content_media_type,
    };
    const bytes = await this.files.withVerified(
      String(row.content_reference),
      ref as Parameters<FileStore["withVerified"]>[1],
      async (chunks) => {
        const parts: Uint8Array[] = [];
        for await (const part of chunks) {
          if (signal?.aborted) fail();
          parts.push(part);
        }
        return Buffer.concat(parts.map((part) => Buffer.from(part)));
      },
      { maxBytes: 512 * 1024, ...(signal ? { signal } : {}) },
    );
    const content: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
    const artifact = await parseKnowledgeArtifact({
      schema_version: 1,
      artifact_id: row.artifact_id,
      comparison_sha256: row.comparison_sha256,
      purpose: row.purpose,
      question: row.question_text,
      input: JSON.parse(String(row.manifest_json)) as unknown,
      method: JSON.parse(String(row.method_json)) as unknown,
      content_ref: ref,
      content,
      coverage: JSON.parse(String(row.coverage_json)) as unknown,
      provenance: JSON.parse(String(row.provenance_json)) as unknown,
    });
    const item = artifact.input.items[0];
    if (
      !item?.material ||
      !item.document ||
      snapshot.materials.length !== 1 ||
      snapshot.documents.length !== 1 ||
      snapshot.artifacts.length !== 0 ||
      snapshot.materials[0]?.input_id !== item.input_id ||
      snapshot.materials[0].literature_id !== item.literature_id ||
      snapshot.materials[0].asset_id !== item.material.asset_id ||
      snapshot.materials[0].asset_sha256 !== item.material.asset_sha256 ||
      snapshot.documents[0]?.input_id !== item.input_id ||
      snapshot.documents[0].document_version_id !==
        item.document.document_version_id ||
      snapshot.documents[0].representation_sha256 !==
        item.document.representation_sha256 ||
      row.manifest_sha256 !== artifact.input.manifest_sha256 ||
      row.method_id !== artifact.method.id ||
      row.method_version !== artifact.method.version ||
      row.parameters_sha256 !== artifact.method.parameters_sha256 ||
      row.scope_kind !== "literature" ||
      row.scope_key !== item.literature_id
    )
      fail();
    if (
      row.question_sha256 !==
      (await sha256(new TextEncoder().encode(artifact.question ?? "")))
    )
      fail();
    return artifact;
  }
  private async verify(
    snapshot: Snapshot,
    signal?: AbortSignal,
  ): Promise<KnowledgeArtifact> {
    const artifact = await this.verifyCore(snapshot, signal);
    await this.verifyOriginal(artifact, signal);
    return artifact;
  }
  private async verifyOriginal(
    artifact: KnowledgeArtifact,
    signal?: AbortSignal,
  ): Promise<void> {
    const item = artifact.input.items[0]!;
    await this.documentRead.withVerifiedVersion(
      item.document!.document_version_id,
      async (document, source, structure) => {
        if (
          document.representation_sha256 !==
            item.document!.representation_sha256 ||
          document.source_material_ref.asset_id !== item.material!.asset_id ||
          document.source_material_ref.asset_sha256 !==
            item.material!.asset_sha256 ||
          structure.segments.length !== artifact.coverage.total_segments ||
          source.length !== artifact.coverage.total_utf8_bytes
        )
          fail();
        const byId = new Map(
          structure.segments.map((segment) => [segment.segment_id, segment]),
        );
        for (const statement of artifact.content.statements)
          for (const evidence of statement.evidence) {
            if (
              evidence.target_kind !== "document" ||
              evidence.document_version_id !== document.document_version_id ||
              evidence.representation_sha256 !==
                document.representation_sha256 ||
              evidence.locator_scheme !== document.locator_scheme
            )
              fail();
            const segment = byId.get(evidence.locator.segment_id);
            if (
              !segment ||
              evidence.content_sha256 !==
                (await sha256(
                  source.subarray(segment.start_utf8, segment.end_utf8),
                ))
            )
              fail();
          }
      },
      signal,
    );
  }
}
