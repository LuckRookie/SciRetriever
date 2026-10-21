import { parseProofreadBlocksV1 } from "@sciretriever/contracts";
import { SqliteProofreadStorage } from "../storage/proofread.js";
import {
  buildProofreadStructure,
  PROOFREAD_DOCUMENT_BUILDER_VERSION,
} from "./proofread-builder.js";
import {
  sha256,
  parseDocumentRepresentationInput,
  type ArtifactRef,
  type DocumentRef,
  type DocumentRepresentationInput,
  type DocumentStructure,
} from "@sciretriever/contracts";
import type { FileStore } from "../storage/files/store.js";
import type { SqliteWorker } from "../storage/sqlite/worker.js";
import type { DocumentStoragePort } from "./contract.js";
import { documentRepresentationHash } from "./contract.js";
import {
  MAX_DOCUMENT_MARKDOWN_BYTES,
  MAX_DOCUMENT_STRUCTURE_BYTES,
} from "./limits.js";

/** Verifies the immutable closure of a corrected Document. */
export class SqliteDocumentStorage implements DocumentStoragePort {
  constructor(
    private readonly database: SqliteWorker,
    private readonly files: FileStore,
  ) {}

  async publishImmutableArtifact(
    reference: string,
    bytes: Uint8Array,
    expected: ArtifactRef,
  ): Promise<{ readonly reference: string; readonly created: boolean }> {
    if (
      bytes.byteLength !== expected.byte_size ||
      (await sha256(bytes)) !== expected.sha256
    )
      throw new Error("document artifact integrity failed");
    const stage = await this.files.stage({
      maxBytes: Math.max(1, expected.byte_size),
    });
    try {
      await stage.write(bytes);
      const published = await this.files.publish(stage, reference);
      if (
        published.sha256 !== expected.sha256 ||
        published.size !== expected.byte_size
      )
        throw new Error("document artifact integrity failed");
      return { reference: published.reference, created: published.created };
    } finally {
      await stage.discard();
    }
  }

  async inspectExactInput(
    input: DocumentRepresentationInput,
  ): Promise<"available" | "stale" | "missing" | "integrity-failure"> {
    const parsed = parseDocumentRepresentationInput(input);
    if ("proofread_id" in parsed) {
      try {
        const output = await new SqliteProofreadStorage(
          this.database,
          this.files,
        ).load(parsed.proofread_id);
        if (
          output.version.content_sha256 !== parsed.proofread_content_sha256 ||
          output.version.part_asset_id !==
            parsed.source_material_ref.asset_id ||
          output.version.part_sha256 !==
            parsed.source_material_ref.asset_sha256 ||
          output.version.status !== "complete"
        )
          return "stale";
        const built = await buildProofreadStructure(
          output.version,
          output.blocks.bytes,
          output.markdown.bytes,
        );
        return built.sha256 === parsed.structure.sha256 &&
          output.version.markdown.sha256 === parsed.markdown.sha256
          ? "available"
          : "integrity-failure";
      } catch {
        return "integrity-failure";
      }
    }
    return "integrity-failure";
  }

  commitVersion(
    input: Parameters<DocumentStoragePort["commitVersion"]>[0],
    signal?: AbortSignal,
  ): ReturnType<DocumentStoragePort["commitVersion"]> {
    return this.database.commitDocumentVersion(input, signal);
  }

  withPinnedVersion<T>(
    documentVersionId: string,
    consume: (version: DocumentRef) => Promise<T>,
    signal?: AbortSignal,
    reserveVerifiedBytes?: (bytes: number) => void,
  ): Promise<T> {
    return this.withVerifiedDocument(
      documentVersionId,
      consume,
      signal,
      reserveVerifiedBytes,
    );
  }

  async withVerifiedDocument<T>(
    documentVersionId: string,
    consume: (
      version: DocumentRef,
      markdown: Uint8Array,
      structure: DocumentStructure,
    ) => Promise<T>,
    signal?: AbortSignal,
    reserveVerifiedBytes?: (bytes: number) => void,
  ): Promise<T> {
    if (signal?.aborted) throw new Error("document read cancelled");
    const snapshot = await this.database.documentVersion(documentVersionId);
    if (!snapshot) throw new Error("document version missing");
    const v = snapshot.version;
    if (
      v.source_material_ref.byte_size > 256 * 1024 * 1024 ||
      v.markdown.byte_size > MAX_DOCUMENT_MARKDOWN_BYTES ||
      v.resources.length > 4096 ||
      v.resources.some(
        (resource) => resource.artifact.byte_size > 32 * 1024 * 1024,
      ) ||
      v.resources.reduce(
        (sum, resource) => sum + resource.artifact.byte_size,
        0,
      ) >
        128 * 1024 * 1024 ||
      v.structure.byte_size > MAX_DOCUMENT_STRUCTURE_BYTES
    )
      throw new Error("document artifact limit exceeded");
    if (
      v.schema_version !== 2 ||
      v.builder_version !== PROOFREAD_DOCUMENT_BUILDER_VERSION
    )
      throw new Error("document builder unsupported");
    if (
      (await documentRepresentationHash({
        source_material_ref: v.source_material_ref,
        proofread_id: v.proofread_id,
        proofread_content_sha256: v.proofread_content_sha256,
        builder_version: v.builder_version,
        locator_scheme: v.locator_scheme,
        markdown: v.markdown,
        structure: v.structure,
        resources: v.resources,
      })) !== v.representation_sha256
    )
      throw new Error("document representation hash mismatch");
    // Admit the declared closure before opening its first byte stream. The
    // callback also covers callers that share a budget across document owners.
    reserveVerifiedBytes?.(
      v.source_material_ref.byte_size +
        v.markdown.byte_size +
        v.structure.byte_size +
        v.resources.reduce(
          (sum, resource) => sum + resource.artifact.byte_size,
          0,
        ),
    );
    const closure: [string, ArtifactRef][] = [
      [snapshot.source_artifact_path, v.source_material_ref.artifact],
    ];
    for (const resource of v.resources) {
      const path = snapshot.resource_artifact_paths[resource.reference];
      if (!path) throw new Error("document resource missing");
      closure.push([path, resource.artifact]);
    }
    // Bounded independent reads preserve every byte/path check without walking
    // hundreds of image paths serially. Settle all readers before returning.
    let next = 0;
    const checks = await Promise.allSettled(
      Array.from({ length: Math.min(8, closure.length) }, async () => {
        while (next < closure.length) {
          const [path, expected] = closure[next++]!;
          await this.withVerifiedArtifact(
            path,
            expected,
            async (chunks) => {
              for await (const chunk of chunks) {
                void chunk;
                if (signal?.aborted) throw new Error("document read cancelled");
              }
            },
            signal,
          );
        }
      }),
    );
    const failure = checks.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
    const markdown = await this.readBytes(
      snapshot.markdown_artifact_path,
      v.markdown,
      MAX_DOCUMENT_MARKDOWN_BYTES,
      signal,
    );
    const structure = await this.readBytes(
      snapshot.structure_artifact_path,
      v.structure,
      MAX_DOCUMENT_STRUCTURE_BYTES,
      signal,
    );
    const built = await this.verifiedProofreadStructure(
      v,
      markdown,
      signal,
      reserveVerifiedBytes,
    );
    if (!Buffer.from(built.bytes).equals(Buffer.from(structure)))
      throw new Error("document structure mismatch");
    // The current catalog protects published artifacts; this fixed version remains
    // durable through the callback. Future GC must add a cross-process read pin.
    if (signal?.aborted) throw new Error("document read cancelled");
    return consume(v, markdown, built.structure);
  }
  private async verifiedProofreadStructure(
    v: Extract<DocumentRef, { schema_version: 2 }>,
    markdown: Uint8Array,
    signal?: AbortSignal,
    reserveVerifiedBytes?: (bytes: number) => void,
  ) {
    const output = await new SqliteProofreadStorage(
      this.database,
      this.files,
    ).documentSource(v.proofread_id, signal, reserveVerifiedBytes);
    if (
      output.version.content_sha256 !== v.proofread_content_sha256 ||
      output.version.part_asset_id !== v.source_material_ref.asset_id ||
      output.version.part_sha256 !== v.source_material_ref.asset_sha256
    )
      throw new Error("document proofread binding mismatch");
    return buildProofreadStructure(output.version, output.blocks, markdown);
  }
  async corrections(
    document: DocumentRef,
    segmentId: string,
    signal?: AbortSignal,
  ) {
    if (document.schema_version !== 2)
      throw new Error("document corrections unsupported");
    const output = await new SqliteProofreadStorage(
      this.database,
      this.files,
    ).load(document.proofread_id, signal);
    const draft = output.drafts.find((d) => d.block_id === segmentId);
    const block = parseProofreadBlocksV1(
      JSON.parse(new TextDecoder().decode(output.blocks.bytes)),
      output.resources.map((r) => r.reference),
    ).blocks.find((b) => b.block_id === segmentId);
    if (!block) throw new Error("document correction record missing");
    return {
      proofread_id: document.proofread_id,
      block_id: segmentId,
      draft: draft ?? null,
      block,
      page_image: {
        asset_id: document.source_material_ref.asset_id,
        asset_sha256: document.source_material_ref.asset_sha256,
        page: block.page,
        region: block.region,
      },
      suspects: output.version.suspects.filter((s) =>
        s.block_ids.includes(segmentId),
      ),
      edits: output.version.edits.filter(
        (e) =>
          block.edit_refs.includes(e.edit_id) ||
          (e.edit.kind === "insert_after"
            ? e.edit.after_block_id === segmentId
            : e.edit.block_id === segmentId),
      ),
    };
  }

  withVerifiedArtifact<T>(
    reference: string,
    expected: ArtifactRef,
    consume: (chunks: AsyncIterable<Uint8Array>) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    return this.files.withVerified(reference, expected, consume, {
      maxBytes: expected.byte_size,
      ...(signal ? { signal } : {}),
    });
  }
  private readBytes(
    reference: string,
    expected: ArtifactRef,
    limit: number,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    if (expected.byte_size > limit)
      throw new Error("document artifact limit exceeded");
    return this.withVerifiedArtifact(
      reference,
      expected,
      async (chunks) => {
        const parts: Uint8Array[] = [];
        for await (const part of chunks) {
          if (signal?.aborted) throw new Error("document read cancelled");
          parts.push(part);
        }
        return new Uint8Array(
          Buffer.concat(parts.map((part) => Buffer.from(part))),
        );
      },
      signal,
    );
  }
}
