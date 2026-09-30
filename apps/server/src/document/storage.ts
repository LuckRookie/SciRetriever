import {
  sha256,
  parseDocumentRepresentationInput,
  type ArtifactRef,
  type DocumentRef,
  type DocumentRepresentationInput,
} from "@sciretriever/contracts";
import type { FileStore } from "../storage/files/store.js";
import type { SqliteWorker } from "../storage/sqlite/worker.js";
import type { DocumentStoragePort } from "./contract.js";
import { documentRepresentationHash } from "./contract.js";
import {
  buildDocumentStructure,
  DOCUMENT_BUILDER_VERSION,
  MAX_DOCUMENT_MARKDOWN_BYTES,
  MAX_DOCUMENT_STRUCTURE_BYTES,
} from "./builder.js";

/** The v3 deletion paths remain disabled; this pin freezes and verifies one exact closure. */
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
    const snapshot = await this.database.documentInput(
      parsed.source_material_ref,
    );
    if (!snapshot) return "missing";
    if (
      !snapshot.parser ||
      snapshot.parser.result.result_sha256 !== parsed.parser_result_sha256 ||
      snapshot.parser.result.markdown.sha256 !== parsed.markdown.sha256 ||
      snapshot.parser.result.resources.length !== parsed.resources.length
    )
      return "stale";
    for (const resource of parsed.resources)
      if (
        !snapshot.parser.result.resources.some(
          (item) =>
            item.reference === resource.reference &&
            item.artifact.sha256 === resource.artifact.sha256 &&
            item.artifact.byte_size === resource.artifact.byte_size &&
            item.artifact.media_type === resource.artifact.media_type,
        )
      )
        return "stale";
    try {
      const closure: [string, ArtifactRef][] = [
        [snapshot.source_artifact_path, parsed.source_material_ref.artifact],
        [snapshot.parser.markdown_artifact_path, parsed.markdown],
      ];
      for (const resource of parsed.resources) {
        const path =
          snapshot.parser.resource_artifact_paths[resource.reference];
        if (!path) return "integrity-failure";
        closure.push([path, resource.artifact]);
      }
      for (const [path, expected] of closure)
        await this.withVerifiedArtifact(path, expected, async (chunks) => {
          for await (const chunk of chunks) void chunk;
        });
      if (parsed.builder_version !== DOCUMENT_BUILDER_VERSION)
        return "integrity-failure";
      const structure = await this.database.locateArtifact(parsed.structure);
      if (!structure) return "integrity-failure";
      const markdown = await this.readBytes(
        snapshot.parser.markdown_artifact_path,
        parsed.markdown,
        MAX_DOCUMENT_MARKDOWN_BYTES,
      );
      const structureBytes = await this.readBytes(
        structure.reference,
        parsed.structure,
        MAX_DOCUMENT_STRUCTURE_BYTES,
      );
      if (
        !Buffer.from((await buildDocumentStructure(markdown)).bytes).equals(
          Buffer.from(structureBytes),
        )
      )
        return "integrity-failure";
    } catch {
      return "integrity-failure";
    }
    return "available";
  }

  commitVersion(
    input: Parameters<DocumentStoragePort["commitVersion"]>[0],
    signal?: AbortSignal,
  ): ReturnType<DocumentStoragePort["commitVersion"]> {
    return this.database.commitDocumentVersion(input, signal);
  }

  async withPinnedVersion<T>(
    documentVersionId: string,
    consume: (version: DocumentRef) => Promise<T>,
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
    if (v.builder_version !== DOCUMENT_BUILDER_VERSION)
      throw new Error("document builder unsupported");
    if (
      (await documentRepresentationHash({
        source_material_ref: v.source_material_ref,
        parser_result_sha256: v.parser_result_sha256,
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
      [snapshot.markdown_artifact_path, v.markdown],
      [snapshot.structure_artifact_path, v.structure],
    ];
    for (const resource of v.resources) {
      const path = snapshot.resource_artifact_paths[resource.reference];
      if (!path) throw new Error("document resource missing");
      closure.push([path, resource.artifact]);
    }
    for (const [path, expected] of closure)
      await this.withVerifiedArtifact(path, expected, async (chunks) => {
        for await (const chunk of chunks) {
          void chunk;
          if (signal?.aborted) throw new Error("document read cancelled");
        }
      });
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
    if (
      !Buffer.from(
        (await buildDocumentStructure(markdown, signal)).bytes,
      ).equals(Buffer.from(structure))
    )
      throw new Error("document structure mismatch");
    // Catalog v3 has no physical reclamation writer; this fixed version remains
    // durable through the callback. Future GC must add a cross-process read pin.
    if (signal?.aborted) throw new Error("document read cancelled");
    return consume(v);
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
    return this.withVerifiedArtifact(reference, expected, async (chunks) => {
      const parts: Uint8Array[] = [];
      for await (const part of chunks) {
        if (signal?.aborted) throw new Error("document read cancelled");
        parts.push(part);
      }
      return new Uint8Array(
        Buffer.concat(parts.map((part) => Buffer.from(part))),
      );
    });
  }
}
