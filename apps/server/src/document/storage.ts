import { isDeepStrictEqual } from "node:util";
import { SqliteArchiveTextStorage } from "../storage/archive-text.js";
import { renderArrangement, isArrangedBuilder } from "../archive/render.js";
import { parseProofreadBlocksV1 } from "@sciretriever/contracts";
import { SqliteProofreadStorage } from "../storage/proofread.js";
import {
  buildProofreadStructure,
  PROOFREAD_DOCUMENT_BUILDER_VERSION,
} from "./proofread-builder.js";
import {
  sha256,
  DOCUMENT_READ_MAX_RESOURCE_BYTES,
  parseDocumentRepresentationInput,
  MAX_DRAFT_CONTENT_BYTES,
  parseDraftContent,
  type DraftDocumentRef,
  type ArtifactRef,
  type DocumentRef,
  type DocumentRepresentationInput,
  type RawParseResource,
  type DocumentResource,
} from "@sciretriever/contracts";
import type { FileStore } from "../storage/files/store.js";
import type { SqliteWorker } from "../storage/sqlite/worker.js";
import type { FileFingerprint } from "../storage/files/reader.js";
import {
  DocumentVerificationCache,
  type DocumentVerificationCacheLimits,
  type DocumentVerificationProof,
  type VerifiedDocumentStructure,
} from "./verification-cache.js";
import {
  DRAFT_BUILDER,
  draftRepresentationHash,
  rebuildDraftDocument,
} from "./draft-builder.js";
import type { DraftVersionPublication } from "../storage/sqlite/draft-text-engine.js";
import type { DocumentVersionSnapshot } from "../storage/sqlite/worker.js";
import type { DocumentStoragePort } from "./contract.js";
import { documentRepresentationHash } from "./contract.js";
import {
  MAX_DOCUMENT_MARKDOWN_BYTES,
  MAX_DOCUMENT_STRUCTURE_BYTES,
} from "./limits.js";

function sameResourceClosure(
  built: readonly RawParseResource[],
  declared: readonly DocumentResource[],
) {
  const byReference = new Map(built.map((r) => [r.reference, r.artifact]));
  return (
    built.length === declared.length &&
    declared.every((r) => {
      const expected = byReference.get(r.reference);
      return (
        expected?.sha256 === r.artifact.sha256 &&
        expected.byte_size === r.artifact.byte_size &&
        expected.media_type === r.artifact.media_type
      );
    })
  );
}

/** Verifies the immutable closure of either text level, using its fixed builder. */
export class SqliteDocumentStorage implements DocumentStoragePort {
  private readonly verification: DocumentVerificationCache;
  constructor(
    private readonly database: SqliteWorker,
    private readonly files: FileStore,
    cacheLimits: DocumentVerificationCacheLimits = {},
  ) {
    this.verification = new DocumentVerificationCache(cacheLimits);
  }

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
        if (isArrangedBuilder(parsed.builder_version)) {
          const output = await new SqliteArchiveTextStorage(
            this.database,
            this.files,
          ).load(parsed.proofread_id);
          if (
            !output ||
            output.version.content_sha256 !== parsed.proofread_content_sha256 ||
            output.version.part_asset_id !==
              parsed.source_material_ref.asset_id ||
            output.version.part_sha256 !==
              parsed.source_material_ref.asset_sha256 ||
            output.version.status !== "complete"
          )
            return "stale";
          const built = renderArrangement(
            output.bundle,
            output.version.resources,
            parsed.builder_version,
          );
          return sameResourceClosure(built.resources, parsed.resources) &&
            built.sha256 === parsed.structure.sha256 &&
            built.markdown.length === parsed.markdown.byte_size &&
            (await sha256(built.markdown)) === parsed.markdown.sha256
            ? "available"
            : "integrity-failure";
        }
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
  async commitDraftVersion(
    input: Omit<DraftVersionPublication, "facts">,
    signal?: AbortSignal,
  ) {
    const v = input.version;
    const content = await this.readBytes(
      input.draft_content_artifact_path,
      v.draft_content,
      MAX_DRAFT_CONTENT_BYTES,
      signal,
    );
    const built = await rebuildDraftDocument(v, content, signal);
    const artifacts: [string, ArtifactRef][] = [
      [input.source_artifact_path, v.source_material_ref.artifact],
      [input.markdown_artifact_path, v.markdown],
      [input.structure_artifact_path, v.structure],
      ...v.resources.map((r): [string, ArtifactRef] => [
        input.resource_artifact_paths[r.reference]!,
        r.artifact,
      ]),
    ];
    if (
      v.source_material_ref.byte_size > 256 * 1024 * 1024 ||
      v.resources.length > 4096 ||
      v.resources.some(
        (r) => r.artifact.byte_size > DOCUMENT_READ_MAX_RESOURCE_BYTES,
      ) ||
      v.resources.reduce((n, r) => n + r.artifact.byte_size, 0) >
        128 * 1024 * 1024
    )
      throw new Error("document artifact limit exceeded");
    for (const [path, artifact] of artifacts) {
      if (!path) throw new Error("document resource missing");
      await this.withVerifiedArtifact(
        path,
        artifact,
        async (chunks) => {
          for await (const chunk of chunks) {
            void chunk;
            signal?.throwIfAborted();
          }
        },
        signal,
      );
    }
    return this.database.commitDraftVersion(
      { ...input, facts: built.counts },
      signal,
    );
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
      structure: VerifiedDocumentStructure,
    ) => Promise<T>,
    signal?: AbortSignal,
    reserveVerifiedBytes?: (bytes: number) => void,
  ): Promise<T> {
    let verified;
    try {
      verified = await this.verifiedDocument(
        documentVersionId,
        signal,
        reserveVerifiedBytes,
      );
    } catch (error) {
      this.verification.discardVersion(documentVersionId);
      throw error;
    }
    return consume(
      verified.version,
      new Uint8Array(verified.proof.markdown),
      structuredClone(verified.proof.structure),
    );
  }
  private async verifiedDocument(
    documentVersionId: string,
    signal?: AbortSignal,
    reserveVerifiedBytes?: (bytes: number) => void,
  ) {
    this.files.assertOpen();
    if (signal?.aborted) throw new Error("document read cancelled");
    const snapshot = await this.database.documentVersion(documentVersionId);
    if (!snapshot) throw new Error("document version missing");
    const v = snapshot.version;
    if (
      v.source_material_ref.byte_size > 256 * 1024 * 1024 ||
      v.markdown.byte_size > MAX_DOCUMENT_MARKDOWN_BYTES ||
      v.resources.length > 4096 ||
      v.resources.some(
        (resource) =>
          resource.artifact.byte_size > DOCUMENT_READ_MAX_RESOURCE_BYTES,
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
      (v.schema_version === 3 &&
        (v.builder_version !== DRAFT_BUILDER ||
          v.draft_content.byte_size > MAX_DRAFT_CONTENT_BYTES)) ||
      (v.schema_version === 2 &&
        v.builder_version !== PROOFREAD_DOCUMENT_BUILDER_VERSION &&
        !isArrangedBuilder(v.builder_version))
    )
      throw new Error("document builder unsupported");
    if (
      (v.schema_version === 3
        ? draftRepresentationHash(v)
        : await documentRepresentationHash({
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
    const key = `${documentVersionId}:${v.representation_sha256}`;
    this.verification.discardVersion(documentVersionId, key);
    const binding = await this.verificationBinding(v, snapshot, signal);
    // A cache hit admits the same logical closure as a cold verification. It
    // must not let a caller bypass its aggregate verified-byte budget.
    reserveVerifiedBytes?.(
      v.source_material_ref.byte_size +
        v.markdown.byte_size +
        v.structure.byte_size +
        v.resources.reduce(
          (sum, resource) => sum + resource.artifact.byte_size,
          0,
        ),
    );
    reserveVerifiedBytes?.(binding.verified_bytes);
    const binary: [string, ArtifactRef][] = [
      [snapshot.source_artifact_path, v.source_material_ref.artifact],
    ];
    for (const resource of v.resources) {
      const path = snapshot.resource_artifact_paths[resource.reference];
      if (!path) throw new Error("document resource missing");
      binary.push([path, resource.artifact]);
    }
    const paths = [
      ...new Set([
        ...binary.map(([path]) => path),
        snapshot.markdown_artifact_path,
        snapshot.structure_artifact_path,
        ...binding.paths,
      ]),
    ];
    const declarations = JSON.stringify({
      version: v,
      binary,
      markdown_path: snapshot.markdown_artifact_path,
      structure_path: snapshot.structure_artifact_path,
      binding,
    });
    const cached = this.verification.get(key, declarations);
    let proof: DocumentVerificationProof;
    if (
      cached &&
      isDeepStrictEqual(
        cached.fingerprints,
        await this.fingerprints(paths, signal),
      )
    ) {
      this.verification.touch(key, cached);
      proof = cached;
    } else {
      this.verification.delete(key);
      proof = await this.verification.verify(
        key,
        declarations,
        async (stop) => {
          const before = await this.fingerprints(paths, stop);
          let next = 0;
          const checks = await Promise.allSettled(
            Array.from({ length: Math.min(8, binary.length) }, async () => {
              while (next < binary.length) {
                const [path, expected] = binary[next++]!;
                await this.withVerifiedArtifact(
                  path,
                  expected,
                  async (chunks) => {
                    for await (const chunk of chunks) {
                      void chunk;
                      stop.throwIfAborted();
                    }
                  },
                  stop,
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
            stop,
          );
          const structure = await this.readBytes(
            snapshot.structure_artifact_path,
            v.structure,
            MAX_DOCUMENT_STRUCTURE_BYTES,
            stop,
          );
          const built =
            v.schema_version === 3
              ? await this.verifiedDraftStructure(v, snapshot, markdown, stop)
              : await this.verifiedProofreadStructure(v, markdown, stop);
          if (!Buffer.from(built.bytes).equals(Buffer.from(structure)))
            throw new Error("document structure mismatch");
          const afterBinding = await this.verificationBinding(
            v,
            snapshot,
            stop,
          );
          const after = await this.fingerprints(paths, stop);
          if (
            !isDeepStrictEqual(before, after) ||
            !isDeepStrictEqual(binding, afterBinding)
          )
            throw new Error("document changed during verification");
          this.files.assertOpen();
          stop.throwIfAborted();
          const metadata = JSON.stringify([...after], (_key, value: unknown) =>
            typeof value === "bigint" ? value.toString() : value,
          );
          return {
            declarations,
            fingerprints: after,
            markdown,
            structure: built.structure,
            weight:
              markdown.byteLength +
              structure.byteLength +
              Buffer.byteLength(declarations) +
              Buffer.byteLength(metadata) +
              512,
          };
        },
        signal,
      );
    }
    this.files.assertOpen();
    signal?.throwIfAborted();
    return { version: v, proof };
  }
  private async fingerprints(paths: readonly string[], signal?: AbortSignal) {
    const result = new Map<string, FileFingerprint>();
    let next = 0;
    const checks = await Promise.allSettled(
      Array.from({ length: Math.min(8, paths.length) }, async () => {
        while (next < paths.length) {
          signal?.throwIfAborted();
          const path = paths[next++]!;
          result.set(path, await this.files.fingerprint(path, signal));
        }
      }),
    );
    const failure = checks.find((r) => r.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
    return result;
  }
  private async verificationBinding(
    v: DocumentRef,
    snapshot: DocumentVersionSnapshot,
    signal?: AbortSignal,
  ) {
    if (v.schema_version === 3) {
      if (!snapshot.draft_content_artifact_path)
        throw new Error("document draft content missing");
      const raw = await this.database.rawParse<Record<string, unknown> | null>(
        "get",
        v.raw_parse_id,
        signal,
      );
      const facts = await this.database.draftVersionFacts(
        v.document_version_id,
      );
      if (
        !raw ||
        raw.result_sha256 !== v.raw_parse_result_sha256 ||
        raw.source_asset_id !== v.source_material_ref.asset_id ||
        raw.source_sha256 !== v.source_material_ref.asset_sha256 ||
        !facts
      )
        throw new Error("document raw binding mismatch");
      return {
        source: { raw, facts },
        paths: [snapshot.draft_content_artifact_path],
        verified_bytes: v.draft_content.byte_size,
      };
    }
    const source = await this.proofreadBinding(v, signal);
    return {
      source,
      paths: [source.manifest.reference, source.blocks.reference],
      verified_bytes:
        source.blocks.artifact.byte_size +
        (isArrangedBuilder(v.builder_version)
          ? 0
          : source.manifest.artifact.byte_size),
    };
  }
  private async verifiedDraftStructure(
    v: DraftDocumentRef,
    snapshot: DocumentVersionSnapshot,
    markdown: Uint8Array,
    signal?: AbortSignal,
  ) {
    if (!snapshot.draft_content_artifact_path)
      throw new Error("document draft content missing");
    const content = await this.readBytes(
      snapshot.draft_content_artifact_path,
      v.draft_content,
      MAX_DRAFT_CONTENT_BYTES,
      signal,
    );
    const built = await rebuildDraftDocument(v, content, signal);
    const facts = await this.database.draftVersionFacts(v.document_version_id);
    if (
      !Buffer.from(markdown).equals(Buffer.from(built.markdown)) ||
      !isDeepStrictEqual(facts, built.counts)
    )
      throw new Error("document draft content mismatch");
    return { bytes: built.structure_bytes, structure: built.structure };
  }
  /** The caller verified the document closure; delivered content bytes are rechecked. */
  async draftDifferences(
    v: DraftDocumentRef,
    segmentId: string,
    signal?: AbortSignal,
  ) {
    const snapshot = await this.database.documentVersion(v.document_version_id);
    if (
      !snapshot?.draft_content_artifact_path ||
      snapshot.version.representation_sha256 !== v.representation_sha256
    )
      throw new Error("document draft content missing");
    const bytes = await this.readBytes(
      snapshot.draft_content_artifact_path,
      v.draft_content,
      MAX_DRAFT_CONTENT_BYTES,
      signal,
    );
    const content = parseDraftContent(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
    );
    const group = content.operations.find(
      (op) => op.kind === "merge" && op.leaf_ids[0] === segmentId,
    );
    const ids = group?.kind === "merge" ? group.leaf_ids : [segmentId];
    const leaves = new Map(content.leaves.map((l) => [l.leaf_id, l]));
    return ids.flatMap((id) => {
      const leaf = leaves.get(id);
      if (!leaf) throw new Error("document draft segment missing");
      return leaf.differences;
    });
  }
  private async proofreadBinding(
    v: Extract<DocumentRef, { schema_version: 2 }>,
    signal?: AbortSignal,
  ) {
    const binding = await new SqliteProofreadStorage(
      this.database,
      this.files,
    ).documentBinding(v.proofread_id, signal);
    if (
      binding.proofread_id !== v.proofread_id ||
      binding.status !== "complete" ||
      binding.content_sha256 !== v.proofread_content_sha256 ||
      binding.part_asset_id !== v.source_material_ref.asset_id ||
      binding.part_sha256 !== v.source_material_ref.asset_sha256 ||
      binding.manifest.artifact.byte_size > 32 * 1024 * 1024 ||
      binding.blocks.artifact.byte_size > 32 * 1024 * 1024
    )
      throw new Error("document proofread binding mismatch");
    return binding;
  }
  private async verifiedProofreadStructure(
    v: Extract<DocumentRef, { schema_version: 2 }>,
    markdown: Uint8Array,
    signal?: AbortSignal,
  ) {
    if (isArrangedBuilder(v.builder_version)) {
      const output = await new SqliteArchiveTextStorage(
        this.database,
        this.files,
      ).load(v.proofread_id, signal);
      if (
        !output ||
        output.version.status !== "complete" ||
        output.version.content_sha256 !== v.proofread_content_sha256 ||
        output.version.part_asset_id !== v.source_material_ref.asset_id ||
        output.version.part_sha256 !== v.source_material_ref.asset_sha256
      )
        throw new Error("document proofread binding mismatch");
      const built = renderArrangement(
        output.bundle,
        output.version.resources,
        v.builder_version,
      );
      if (!Buffer.from(markdown).equals(built.markdown))
        throw new Error("document source-map mismatch");
      if (!sameResourceClosure(built.resources, v.resources))
        throw new Error("document resource closure mismatch");
      return built;
    }
    const output = await new SqliteProofreadStorage(
      this.database,
      this.files,
    ).documentSource(v.proofread_id, signal);
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
    if (isArrangedBuilder(document.builder_version)) {
      const output = await new SqliteArchiveTextStorage(
        this.database,
        this.files,
      ).load(document.proofread_id, signal);
      const row = output?.bundle.leaves.find(
        (l) =>
          l.leaf.leaf_id === segmentId && l.destination.kind === "assigned",
      );
      if (!output || !row)
        throw new Error("document correction record missing");
      return {
        schema_version: 2,
        format: "arranged-v2",
        proofread_id: document.proofread_id,
        leaf: row.leaf,
        corrected_text: row.corrected_text,
        page_record: output.version.pages[row.leaf.page_index],
        corrections: output.version.pages
          .flatMap((p) => p.corrections)
          .filter((c) => c.operation.leaf_id === segmentId),
        page_image: {
          asset_id: document.source_material_ref.asset_id,
          asset_sha256: document.source_material_ref.asset_sha256,
          page: row.leaf.page_index,
          region: row.leaf.region,
        },
      };
    }
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
