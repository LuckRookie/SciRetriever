import type {
  ArtifactRef,
  AssetId,
  Sha256,
  ParserProvenance,
  ParserResult,
} from "@sciretriever/contracts";
export interface ParserRequest {
  readonly source_asset_id: AssetId;
  readonly source_sha256: Sha256;
  readonly media_type: "application/pdf";
  withContent<T>(
    consume: (chunks: AsyncIterable<Uint8Array>) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T>;
}
export interface StagedParserArtifact {
  readonly artifact: ArtifactRef;
  readonly bytes: Uint8Array;
}
export interface StagedParserResource {
  readonly reference: string;
  readonly content: StagedParserArtifact;
}
export interface StagedParserOutput {
  readonly source_asset_id: AssetId;
  readonly source_sha256: Sha256;
  readonly page_count: number;
  readonly markdown: StagedParserArtifact;
  readonly resources: readonly StagedParserResource[];
  readonly provenance: ParserProvenance;
}
/** Stable compatibility boundary implemented by every parsing backend. */
export interface ParserBackend {
  parse(
    request: ParserRequest,
    signal?: AbortSignal,
  ): Promise<StagedParserOutput>;
}
/** @deprecated Use ParserBackend; retained for the existing public API. */
export type ParserPort = ParserBackend;
export interface ParserArtifactRules {
  validate(
    output: Pick<StagedParserOutput, "markdown" | "resources">,
    signal?: AbortSignal,
  ): Promise<void>;
}
export interface ParserPublication {
  readonly literature_id: string;
  readonly result: ParserResult;
  readonly markdown: StagedParserArtifact;
  readonly resources: readonly StagedParserResource[];
}
export class ParsingFailure extends Error {
  constructor(
    readonly code:
      | "parser-structure"
      | "parser-unavailable"
      | "parser-cancelled"
      | "parser-stale"
      | "parser-publication",
  ) {
    super("literature parsing failed");
  }
}
