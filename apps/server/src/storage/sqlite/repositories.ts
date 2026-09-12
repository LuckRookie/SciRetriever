import { sha256 } from "@sciretriever/contracts";
import type {
  Author,
  Identifier,
  Literature,
  Provenance,
  Reference,
} from "@sciretriever/contracts";
import { SqliteWorker } from "./worker.js";
import type { FileStore } from "../files/store.js";

export interface ObservationProvenance {
  readonly provenance_id: string;
  readonly source_kind: Provenance["source_kind"];
  readonly source_name: string;
  readonly source_record_id: string | null;
  readonly observed_at: string;
  readonly input_sha256: string | null;
  readonly parameters_sha256: string | null;
}
export interface MetadataObservation {
  readonly version_links?: readonly import("@sciretriever/contracts").ProviderLiteratureKey[];
  readonly asset_hints?: readonly import("@sciretriever/contracts").AssetHint[];
  readonly observation_id: string;
  readonly provenance: ObservationProvenance;
  readonly literature_id?: string;
  readonly version_role: Literature["version_role"] | null;
  readonly reference_count: number | null;
  readonly cited_by_count: number | null;
  readonly metadata: Omit<Literature["metadata"], "authors"> & {
    readonly authors: readonly Author[];
  };
  readonly declared_keywords: readonly string[];
  readonly reference_texts: readonly string[];
}
export interface ProviderRelationEndpoint {
  readonly record_id: string | null;
  readonly identifiers: readonly Identifier[];
}
export interface ProviderRelationObservation {
  readonly observation_id: string;
  readonly provenance: ObservationProvenance;
  readonly citing: ProviderRelationEndpoint;
  readonly cited: ProviderRelationEndpoint;
}
export interface LiteratureAssetPublication {
  readonly literature_asset_id: string;
  readonly literature_id: string;
  readonly asset: import("@sciretriever/contracts").Asset;
  readonly role:
    | "primary-pdf"
    | "supplementary-pdf"
    | "xml"
    | "html"
    | "supplementary";
  readonly provenance: ObservationProvenance;
  readonly source_url: string | null;
}
export interface ParserResultPublication {
  readonly source_asset_id: string;
  readonly source_sha256: string;
  readonly result_sha256: string;
  readonly page_count: number;
  readonly markdown_artifact_id: string;
  readonly markdown_artifact_path: string;
  readonly markdown_sha256: string;
  readonly markdown_byte_size: number;
  readonly markdown_media_type: "text/markdown";
  readonly provenance: ObservationProvenance;
  readonly parser_version: string;
  readonly mode: string | null;
  readonly model_identity: string | null;
  readonly resources?: readonly ParserResourcePublication[];
}
export interface ParserResourcePublication {
  readonly reference: string;
  readonly artifact_id: string;
  readonly artifact_path: string;
  readonly artifact_sha256: string;
  readonly artifact_byte_size: number;
  readonly artifact_media_type: string;
}
export interface LiteratureContentPublication {
  readonly literature_id: string;
  readonly literature_content_sha256: string;
  readonly metadata_revision: number;
  readonly metadata_sha256: string;
  readonly primary_asset_id: string;
  readonly primary_asset_sha256: string;
  readonly parser_result_sha256: string;
  readonly structured_artifact_id: string;
  readonly structured_artifact_path: string;
  readonly structured_artifact_sha256: string;
  readonly structured_artifact_byte_size: number;
  readonly structured_artifact_media_type: string;
  readonly markdown_artifact_id: string;
  readonly markdown_artifact_path: string;
  readonly markdown_artifact_sha256: string;
  readonly markdown_artifact_byte_size: number;
  readonly markdown_artifact_media_type: "text/markdown";
  readonly provenance: ObservationProvenance;
  readonly reference_texts: readonly string[];
}
export type ReferenceSupport =
  | {
      readonly kind: "provider_relation";
      readonly observation_id: string;
    }
  | {
      readonly kind: "metadata_reference_text";
      readonly metadata_observation_id: string;
      readonly reference_index: number;
    }
  | {
      readonly kind: "content_reference_text";
      readonly literature_content_sha256: string;
      readonly reference_index: number;
    };
export interface ReferenceSnapshot {
  readonly reference: Reference;
  readonly supports: readonly ReferenceSupport[];
}

export class RepositoryError extends Error {
  readonly code = "repository" as const;
  constructor() {
    super("repository operation failed");
    this.name = "RepositoryError";
  }
}

export class ObservationRepository {
  constructor(private readonly worker: SqliteWorker) {}
  publish(observation: MetadataObservation): Promise<boolean> {
    return this.worker.putObservation(observation);
  }
  get(observationId: string): Promise<MetadataObservation | null> {
    return this.worker.getObservation(observationId);
  }
  publishProviderRelation(
    observation: ProviderRelationObservation,
  ): Promise<boolean> {
    return this.worker.putProviderRelation(observation);
  }
  getProviderRelation(
    observationId: string,
  ): Promise<ProviderRelationObservation | null> {
    return this.worker.getProviderRelation(observationId);
  }
  accept(
    observationId: string,
    literatureId: string,
    expectedMetadataRevision: number,
    expectedMetadataSha256: string,
  ): Promise<boolean> {
    return this.worker.acceptObservation(
      observationId,
      literatureId,
      expectedMetadataRevision,
      expectedMetadataSha256,
    );
  }
}

export class AssetRepository {
  constructor(
    private readonly worker: SqliteWorker,
    private readonly files?: FileStore,
  ) {}
  publish(asset: Parameters<SqliteWorker["putAsset"]>[0]): Promise<boolean> {
    return this.worker.putAsset(asset);
  }
  publishForLiterature(
    publication: LiteratureAssetPublication,
  ): Promise<boolean> {
    return this.worker.putLiteratureAsset(publication);
  }
  publishParserResult(result: ParserResultPublication): Promise<boolean> {
    return this.worker.putParserResult(result);
  }
  publishContent(content: LiteratureContentPublication): Promise<boolean> {
    return this.worker.putLiteratureContent(content);
  }
  getContent(
    literatureId: string,
  ): Promise<LiteratureContentPublication | null> {
    return this.worker.getLiteratureContent(literatureId);
  }
  async readAsset(assetId: string): Promise<Uint8Array> {
    if (!this.files) throw new RepositoryError();
    const asset = await this.worker.getAsset(assetId);
    if (!asset) throw new RepositoryError();
    const bytes = await this.files.read(asset.path, asset.size_bytes);
    if (
      bytes.byteLength !== asset.size_bytes ||
      (await sha256(bytes)) !== asset.sha256
    )
      throw new RepositoryError();
    return bytes;
  }
}

export class ReferenceRepository {
  constructor(private readonly worker: SqliteWorker) {}
  publish(reference: Reference): Promise<boolean> {
    return this.worker.putReference(reference);
  }
  supportWithProviderObservation(
    referenceId: string,
    observationId: string,
  ): Promise<boolean> {
    return this.worker.putProviderReferenceSupport(referenceId, observationId);
  }
  supportWithMetadataReferenceText(
    referenceId: string,
    metadataObservationId: string,
    referenceIndex: number,
  ): Promise<boolean> {
    return this.worker.putMetadataReferenceSupport(
      referenceId,
      metadataObservationId,
      referenceIndex,
    );
  }
  supportWithContentReferenceText(
    referenceId: string,
    literatureContentSha256: string,
    referenceIndex: number,
  ): Promise<boolean> {
    return this.worker.putContentReferenceSupport(
      referenceId,
      literatureContentSha256,
      referenceIndex,
    );
  }
  snapshot(): Promise<readonly ReferenceSnapshot[]> {
    return this.worker.referenceSnapshot();
  }
}

export type ObservationIdentifier = Identifier;

export interface ContentAcceptanceCommit {
  readonly input_metadata_revision: number;
  readonly input_metadata_sha256: string;
  readonly final_metadata: import("@sciretriever/contracts").LiteratureMetadata;
  readonly content: LiteratureContentPublication;
  readonly content_body: string;
}
