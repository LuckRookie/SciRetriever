import { artifactReference } from "../storage/artifact-layout.js";
import { createHash } from "node:crypto";
import {
  parseDocumentMaterialRef,
  parseDocumentRef,
  parseDocumentRequest,
  parseAssetId,
  type ArtifactRef,
  type DocumentResource,
  type ParseDocumentRequest,
  type ParseDocumentReceipt,
} from "@sciretriever/contracts";
import type { ParsingService } from "../parsing/service.js";
import { ParsingFailure, type ParserArtifactRules } from "../parsing/ports.js";
import type {
  SqliteWorker,
  DocumentInputSnapshot,
} from "../storage/sqlite/worker.js";
import { WriteAdmissionError } from "../storage/write-admission.js";
import {
  documentRepresentationHash,
  type DocumentStoragePort,
} from "./contract.js";
import {
  buildDocumentStructure,
  DOCUMENT_BUILDER_VERSION,
  MAX_DOCUMENT_MARKDOWN_BYTES,
} from "./builder.js";

export type {
  ParseDocumentRequest,
  ParseDocumentReceipt,
} from "@sciretriever/contracts";
const MAX_DOCUMENT_PDF_BYTES = 256 * 1024 * 1024;
const MAX_DOCUMENT_RESOURCE_BYTES = 32 * 1024 * 1024;
const MAX_DOCUMENT_RESOURCES_BYTES = 128 * 1024 * 1024;
const MAX_DOCUMENT_RESOURCES = 4096;

export class DocumentProcessingError extends Error {
  constructor(
    readonly code:
      | "material-missing"
      | "material-stale"
      | "parser-result-missing"
      | "parser-unavailable"
      | "document-integrity"
      | "document-publication"
      | "document-cancelled"
      | "catalog-v3-required",
    options?: ErrorOptions,
  ) {
    super("document processing failed", options);
    this.name = "DocumentProcessingError";
  }
}
function identity(namespace: string, value: string): string {
  const hex = createHash("sha256")
    .update(`${namespace}\0${value}`)
    .digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
function artifact(bytes: Uint8Array, hash: string, media: string): ArtifactRef {
  return {
    sha256: hash as ArtifactRef["sha256"],
    byte_size: bytes.byteLength,
    media_type: media,
  };
}
function cancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DocumentProcessingError("document-cancelled");
}
export class DocumentProcessingService {
  private readonly stop = new AbortController();
  private readonly active = new Set<Promise<unknown>>();
  private closing: Promise<void> | undefined;
  constructor(
    private readonly database: SqliteWorker,
    private readonly storage: DocumentStoragePort,
    private readonly rules: ParserArtifactRules,
    private readonly parsing: ParsingService | null,
  ) {}
  async parseDocuments(
    value: unknown,
    signal?: AbortSignal,
  ): Promise<ParseDocumentReceipt> {
    if (this.stop.signal.aborted)
      throw new DocumentProcessingError("document-cancelled");
    let request: ParseDocumentRequest;
    try {
      request = parseDocumentRequest(value);
    } catch (error) {
      throw new DocumentProcessingError("material-stale", { cause: error });
    }
    const combined = signal
      ? AbortSignal.any([signal, this.stop.signal])
      : this.stop.signal;
    const operation = this.process(request, combined);
    this.active.add(operation);
    try {
      return await operation;
    } finally {
      this.active.delete(operation);
    }
  }
  close(): Promise<void> {
    if (!this.closing) {
      let resolve!: () => void;
      this.closing = new Promise<void>((done) => {
        resolve = done;
      });
      this.stop.abort();
      void Promise.allSettled([...this.active]).then(() => resolve());
    }
    return this.closing;
  }
  private async process(
    value: ParseDocumentRequest,
    signal: AbortSignal,
  ): Promise<ParseDocumentReceipt> {
    cancelled(signal);
    const schema = await this.database.schema();
    if (
      schema.schema_version !== 3 &&
      schema.schema_version !== 4 &&
      schema.schema_version !== 5 &&
      schema.schema_version !== 6 &&
      schema.schema_version !== 7 &&
      schema.schema_version !== 8 &&
      schema.schema_version !== 9 &&
      schema.schema_version !== 10
    )
      throw new DocumentProcessingError("catalog-v3-required");
    const facts = await this.database.currentFacts(value.literature_id);
    const asset = facts?.primary_asset;
    if (!asset) throw new DocumentProcessingError("material-missing");
    if (
      asset.asset_id !== value.asset_id ||
      asset.sha256 !== value.asset_sha256 ||
      asset.media_type !== "application/pdf"
    )
      throw new DocumentProcessingError("material-stale");
    const material = parseDocumentMaterialRef({
      literature_id: value.literature_id,
      asset_id: asset.asset_id,
      asset_sha256: asset.sha256,
      media_type: asset.media_type,
      byte_size: asset.size_bytes,
      artifact: {
        sha256: asset.sha256,
        byte_size: asset.size_bytes,
        media_type: asset.media_type,
      },
    });
    if (material.byte_size > MAX_DOCUMENT_PDF_BYTES)
      throw new DocumentProcessingError("document-integrity");
    let snapshot: DocumentInputSnapshot | null;
    try {
      snapshot = await this.database.documentInput(material);
    } catch (error) {
      throw new DocumentProcessingError("document-integrity", { cause: error });
    }
    if (!snapshot) throw new DocumentProcessingError("material-stale");
    if (value.mode === "reparse") {
      if (!this.parsing)
        throw new DocumentProcessingError("parser-unavailable");
      const prepared = await this.parsing.prepareCurrentPrimary(
        value.literature_id,
        signal,
        {
          asset_id: parseAssetId(material.asset_id),
          sha256: material.asset_sha256,
        },
      );
      if (
        prepared.result.source_asset_id !== asset.asset_id ||
        prepared.result.source_sha256 !== asset.sha256
      ) {
        this.parsing.discardPrepared(prepared);
        throw new DocumentProcessingError("material-stale");
      }
      const result = await this.parsing.commitCurrentPrimary(prepared, signal);
      const markdown = await this.database.locateArtifact(result.markdown);
      const paths: Record<string, string> = {};
      for (const resource of result.resources) {
        const located = await this.database.locateArtifact(resource.artifact);
        if (!located) throw new DocumentProcessingError("document-integrity");
        paths[resource.reference] = located.reference;
      }
      if (!markdown) throw new DocumentProcessingError("document-integrity");
      snapshot = {
        source_artifact_path: snapshot.source_artifact_path,
        parser: {
          result,
          provenance_id: result.provenance.provenance.provenance_id,
          markdown_artifact_path: markdown.reference,
          resource_artifact_paths: paths,
        },
      };
    }
    if (!snapshot.parser)
      throw new DocumentProcessingError("parser-result-missing");
    const parser = snapshot.parser;
    const resources = parser.result.resources;
    const totalResourceBytes = resources.reduce(
      (size, item) => size + item.artifact.byte_size,
      0,
    );
    if (
      material.byte_size > MAX_DOCUMENT_PDF_BYTES ||
      parser.result.markdown.byte_size > MAX_DOCUMENT_MARKDOWN_BYTES ||
      resources.length > MAX_DOCUMENT_RESOURCES ||
      totalResourceBytes > MAX_DOCUMENT_RESOURCES_BYTES ||
      resources.some(
        (item) => item.artifact.byte_size > MAX_DOCUMENT_RESOURCE_BYTES,
      )
    )
      throw new DocumentProcessingError("document-integrity");
    const read = async (
      path: string,
      expected: ArtifactRef,
    ): Promise<Uint8Array> =>
      this.storage.withVerifiedArtifact(path, expected, async (chunks) => {
        const parts: Uint8Array[] = [];
        let size = 0;
        for await (const part of chunks) {
          cancelled(signal);
          size += part.length;
          if (size > expected.byte_size)
            throw new DocumentProcessingError("document-integrity");
          parts.push(part);
        }
        return new Uint8Array(Buffer.concat(parts.map((p) => Buffer.from(p))));
      });
    let commitStarted = false;
    try {
      await read(snapshot.source_artifact_path, material.artifact);
      const markdown = await read(
        parser.markdown_artifact_path,
        parser.result.markdown,
      );
      const resourceContents = [];
      for (const item of parser.result.resources) {
        const path = parser.resource_artifact_paths[item.reference];
        if (!path) throw new DocumentProcessingError("document-integrity");
        resourceContents.push({
          reference: item.reference,
          content: {
            artifact: item.artifact,
            bytes: await read(path, item.artifact),
          },
        });
      }
      await this.rules.validate(
        {
          markdown: { artifact: parser.result.markdown, bytes: markdown },
          resources: resourceContents,
        },
        signal,
      );
      let built: Awaited<ReturnType<typeof buildDocumentStructure>>;
      try {
        built = await buildDocumentStructure(markdown, signal);
      } catch (error) {
        throw new DocumentProcessingError(
          signal.aborted ? "document-cancelled" : "document-integrity",
          { cause: error },
        );
      }
      cancelled(signal);
      const structure = artifact(built.bytes, built.sha256, "application/json");
      const documentResources: DocumentResource[] = parser.result.resources.map(
        (item, index) => ({
          resource_id: `r${index + 1}`,
          reference: item.reference,
          relation: "other",
          artifact: item.artifact,
        }),
      );
      const representation = {
        source_material_ref: material,
        parser_result_sha256: parser.result.result_sha256,
        builder_version: DOCUMENT_BUILDER_VERSION,
        locator_scheme: "utf8-segment-v1" as const,
        markdown: parser.result.markdown,
        structure,
        resources: documentResources,
      };
      const representationHash =
        await documentRepresentationHash(representation);
      const documentId = identity(
        "document",
        `${material.literature_id}\0${material.asset_id}`,
      );
      const versionId = identity(
        "document-version",
        `${documentId}\0${representationHash}`,
      );
      const version = parseDocumentRef({
        schema_version: 1,
        document_id: documentId,
        document_version_id: versionId,
        representation_sha256: representationHash,
        parser_provenance_id: parser.provenance_id,
        ...representation,
      });
      const locatedStructure = await this.database.locateArtifact(structure);
      const structurePath =
        locatedStructure?.reference ??
        artifactReference("document-structure", structure);
      if (locatedStructure)
        await this.storage.withVerifiedArtifact(
          structurePath,
          structure,
          async (chunks) => {
            for await (const chunk of chunks) {
              void chunk;
              cancelled(signal);
            }
          },
        );
      else
        await this.storage.publishImmutableArtifact(
          structurePath,
          built.bytes,
          structure,
        );
      cancelled(signal);
      commitStarted = true;
      const committed = await this.storage.commitVersion(
        {
          version,
          source_artifact_path: snapshot.source_artifact_path,
          markdown_artifact_path: parser.markdown_artifact_path,
          structure_artifact_path: structurePath,
          resource_artifact_paths: parser.resource_artifact_paths,
          expected_default_revision: value.expected_default_revision,
        },
        signal,
      );
      const persisted = await this.database.documentVersion(versionId);
      if (!persisted) throw new DocumentProcessingError("document-integrity");
      return {
        document: persisted.version,
        parser_result_sha256: persisted.version.parser_result_sha256,
        parser_provenance_id: persisted.version.parser_provenance_id,
        parser_mode: value.mode,
        ...committed,
      };
    } catch (error) {
      if (
        error instanceof DocumentProcessingError ||
        error instanceof ParsingFailure
      )
        throw error;
      if (
        error instanceof WriteAdmissionError &&
        error.code === "write-admission-cancelled"
      )
        throw new DocumentProcessingError("document-cancelled", {
          cause: error,
        });
      if (signal.aborted && !commitStarted)
        throw new DocumentProcessingError("document-cancelled", {
          cause: error,
        });
      throw new DocumentProcessingError("document-publication", {
        cause: error,
      });
    }
  }
}
