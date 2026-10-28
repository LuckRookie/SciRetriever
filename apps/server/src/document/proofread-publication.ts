import { createHash } from "node:crypto";
import {
  ContractValidationError,
  parseAssetId,
  parseLiteratureId,
  parseDocumentRef,
  type ArtifactRef,
} from "@sciretriever/contracts";
import type { SqliteWorker } from "../storage/sqlite/worker.js";
import type { FileStore } from "../storage/files/store.js";
import { SqliteProofreadStorage } from "../storage/proofread.js";
import { artifactReference } from "../storage/artifact-layout.js";
import { SqliteDocumentStorage } from "./storage.js";
import { documentRepresentationHash } from "./contract.js";
import {
  buildProofreadStructure,
  PROOFREAD_DOCUMENT_BUILDER_VERSION,
} from "./proofread-builder.js";

export class ProofreadDocumentError extends Error {
  constructor(
    readonly code: string,
    options?: ErrorOptions,
  ) {
    super("proofread document publication failed", options);
  }
}
function identity(namespace: string, value: string) {
  const hex = createHash("sha256")
    .update(`${namespace}\0${value}`)
    .digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
/** One document per literature and part asset, whichever flow publishes its versions. */
export function documentIdentity(literature: string, asset: string) {
  return identity("document", `${literature}\0${asset}`);
}
/** Explicit publication used by archiving; parsing and read operations never call it. */
export class ProofreadDocumentService {
  private readonly stop = new AbortController();
  private readonly active = new Set<Promise<unknown>>();
  constructor(
    private readonly database: SqliteWorker,
    private readonly files: FileStore,
    private readonly refreshIndex: (signal: AbortSignal) => Promise<unknown>,
  ) {}
  async close() {
    this.stop.abort();
    await Promise.allSettled([...this.active]);
  }
  publish(value: unknown, signal?: AbortSignal) {
    const active = signal
      ? AbortSignal.any([signal, this.stop.signal])
      : this.stop.signal;
    const work = this.perform(value, active);
    this.active.add(work);
    void work.then(
      () => this.active.delete(work),
      () => this.active.delete(work),
    );
    return work;
  }
  private async perform(value: unknown, signal: AbortSignal) {
    const check = () => {
      if (signal.aborted)
        throw new ProofreadDocumentError("document-cancelled");
    };
    check();
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.keys(value).sort().join() !==
        "asset_id,expected_default_revision,literature_id,proofread_id"
    )
      throw new ContractValidationError();
    const r = value as Record<string, unknown>,
      literature = parseLiteratureId(r.literature_id),
      asset = parseAssetId(r.asset_id),
      proofreadId = parseAssetId(r.proofread_id);
    if (
      r.expected_default_revision !== null &&
      (!Number.isSafeInteger(r.expected_default_revision) ||
        Number(r.expected_default_revision) < 1)
    )
      throw new ContractValidationError();
    if (![12].includes(Number((await this.database.schema()).schema_version)))
      throw new ProofreadDocumentError("catalog-current-required");
    const source = await this.database.documentMaterial(literature, asset);
    if (!source) throw new ProofreadDocumentError("material-missing");
    const proofreads = new SqliteProofreadStorage(this.database, this.files);
    const state = await proofreads.state(asset, signal);
    const output = await proofreads.load(proofreadId, signal),
      v = output.version;
    if (
      state.current?.proofread_id !== proofreadId ||
      v.status !== "complete" ||
      v.part_asset_id !== asset ||
      v.part_sha256 !== source.material.asset_sha256 ||
      JSON.stringify(v.manual_decision_ids) !==
        JSON.stringify(state.decisions.map((d) => d.decision_id).sort())
    )
      throw new ProofreadDocumentError("document-input-stale");
    const store = new SqliteDocumentStorage(this.database, this.files);
    if (source.material.byte_size > 256 * 1024 * 1024)
      throw new ProofreadDocumentError("document-budget");
    await store.withVerifiedArtifact(
      source.path,
      source.material.artifact,
      async (chunks) => {
        for await (const part of chunks) {
          void part;
          check();
        }
      },
      signal,
    );
    const built = await buildProofreadStructure(
      v,
      output.blocks.bytes,
      output.markdown.bytes,
      signal,
    );
    const structure: ArtifactRef = {
      sha256: built.sha256,
      byte_size: built.bytes.length,
      media_type: "application/json",
    };
    const representation = {
      source_material_ref: source.material,
      proofread_id: proofreadId,
      proofread_content_sha256: v.content_sha256,
      builder_version: PROOFREAD_DOCUMENT_BUILDER_VERSION,
      locator_scheme: "utf8-segment-v1" as const,
      markdown: v.markdown,
      structure,
      resources: v.resources.map((r, i) => ({
        resource_id: `r${i + 1}`,
        reference: r.reference,
        relation: "image" as const,
        artifact: r.artifact,
      })),
    };
    const hash = await documentRepresentationHash(representation),
      documentId = documentIdentity(literature, asset);
    let document = parseDocumentRef({
      schema_version: 2,
      document_id: documentId,
      document_version_id: identity(
        "document-version",
        `${documentId}\0${hash}`,
      ),
      representation_sha256: hash,
      ...representation,
    });
    const path = await this.database.locateArtifact(structure);
    const structurePath =
      path?.reference ?? artifactReference("document-structure", structure);
    check();
    await store.publishImmutableArtifact(structurePath, built.bytes, structure);
    const markdown = await this.database.locateArtifact(v.markdown);
    if (!markdown) throw new ProofreadDocumentError("document-integrity");
    const resources: Record<string, string> = {};
    for (const resource of v.resources) {
      const located = await this.database.locateArtifact(resource.artifact);
      if (!located) throw new ProofreadDocumentError("document-integrity");
      resources[resource.reference] = located.reference;
    }
    check();
    const previousDefault = await this.database.documentDefault(
      literature,
      asset,
      source.material.asset_sha256,
    );
    const result = await this.database.commitDocumentVersion(
      {
        version: document,
        source_artifact_path: source.path,
        markdown_artifact_path: markdown.reference,
        structure_artifact_path: structurePath,
        resource_artifact_paths: resources,
        expected_default_revision: r.expected_default_revision as number | null,
        expected_manual_revision: state.manual_revision,
      },
      signal,
    );
    const persisted = await this.database.documentVersion(
      document.document_version_id,
    );
    if (
      !persisted ||
      persisted.version.schema_version !== 2 ||
      persisted.version.representation_sha256 !== document.representation_sha256
    )
      throw new ProofreadDocumentError("document-integrity");
    document = persisted.version;
    // Index failure cannot roll back a valid fixed document; expose a retryable projection outcome.
    let index_status: "updated" | "unchanged" | "failed" = "unchanged";
    if (
      result.default_updated &&
      previousDefault?.document_version_id !== document.document_version_id
    ) {
      try {
        await this.refreshIndex(signal);
        index_status = "updated";
      } catch {
        index_status = "failed";
      }
    }
    if (document.schema_version !== 2)
      throw new ProofreadDocumentError("document-integrity");
    // The response is a fixed reference, not a potentially multi-megabyte resource manifest.
    return {
      document: {
        schema_version: document.schema_version,
        document_id: document.document_id,
        document_version_id: document.document_version_id,
        representation_sha256: document.representation_sha256,
        source_material_ref: document.source_material_ref,
        proofread_id: document.proofread_id,
        proofread_content_sha256: document.proofread_content_sha256,
        builder_version: document.builder_version,
        locator_scheme: document.locator_scheme,
      },
      ...result,
      index_status,
    };
  }
}
