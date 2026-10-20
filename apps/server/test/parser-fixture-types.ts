/** Only historical catalog fixtures can create a legacy ParserResult. */
import type {
  AssetId,
  Sha256,
  ParserProvenance,
  ParserResult,
} from "@sciretriever/contracts";
import type {
  ParserRequest,
  StagedParserArtifact,
  StagedParserResource,
} from "../src/parsing/ports.js";
export interface StagedParserOutput {
  readonly source_asset_id: AssetId;
  readonly source_sha256: Sha256;
  readonly page_count: number;
  readonly markdown: StagedParserArtifact;
  readonly resources: readonly StagedParserResource[];
  readonly provenance: ParserProvenance;
}
export interface ParserBackend {
  parse(
    request: ParserRequest,
    signal?: AbortSignal,
  ): Promise<StagedParserOutput>;
}
export interface ParserPublication {
  readonly literature_id: string;
  readonly result: ParserResult;
  readonly markdown: StagedParserArtifact;
  readonly resources: readonly StagedParserResource[];
}
