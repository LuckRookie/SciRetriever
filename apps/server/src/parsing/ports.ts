import type {
  ArtifactRef,
  Asset,
  LiteratureCurrentFacts,
  AssetId,
  Sha256,
  RawParse,
  RawParseProfile,
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
export interface ParserArtifacts {
  readonly markdown: StagedParserArtifact;
  readonly resources: readonly StagedParserResource[];
}
export interface StagedRawParseOutput {
  readonly result: RawParse;
  readonly blocks: StagedParserArtifact;
  readonly markdown: StagedParserArtifact;
  readonly resources: readonly StagedParserResource[];
  readonly private_content_list: StagedParserArtifact;
}
export interface RawParserBackend {
  identity(
    profile: RawParseProfile,
  ): Promise<
    Pick<RawParse, "parser_version" | "model_identity" | "parameters_sha256">
  >;
  parseRaw(
    request: ParserRequest,
    profile: RawParseProfile,
    signal?: AbortSignal,
  ): Promise<StagedRawParseOutput>;
}
export interface ParserArtifactRules {
  validate(
    output: ParserArtifacts,
    signal?: AbortSignal,
    blockReferences?: readonly string[],
  ): Promise<void>;
}
export class ParsingFailure extends Error {
  constructor(
    readonly code:
      | "parser-structure"
      | "parser-unavailable"
      | "parser-cancelled"
      | "parser-stale"
      | "parser-publication",
    readonly source_type?: string,
  ) {
    super("literature parsing failed");
  }
}

export interface ParsingSource {
  currentFacts(literatureId: string): Promise<LiteratureCurrentFacts | null>;
  withArtifact<T>(
    asset: Asset,
    consume: (chunks: AsyncIterable<Uint8Array>) => Promise<T>,
    options: { maxBytes: number; signal: AbortSignal },
  ): Promise<T>;
  inspectPdf(
    bytes: Uint8Array,
    signal: AbortSignal,
  ): Promise<{ readonly page_count: number }>;
}

/** Internal operation-local publication boundary; never part of parser requests. */
export type ParsingCommit = <T>(publish: () => Promise<T>) => Promise<T>;
