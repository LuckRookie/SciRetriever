import { createHash } from "node:crypto";
import type { ArtifactRef, ParserResult } from "@sciretriever/contracts";
import type { FileStore } from "../storage/files/store.js";
import type { ParserResultPublication } from "../storage/sqlite/repositories.js";
import {
  ParsingFailure,
  type ParserPublication,
  type StagedParserArtifact,
} from "./ports.js";
import type { ParserResultPublisher } from "./service.js";
interface ParserPublicationRepository {
  locateArtifact(value: ArtifactRef): Promise<{
    readonly reference: string;
    readonly artifact: ArtifactRef;
  } | null>;
  commitCurrentParser(
    literatureId: string,
    result: ParserResultPublication,
  ): Promise<ParserResult | null>;
}
function artifactId(hash: string): string {
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
}
export class ImmutableParserPublisher implements ParserResultPublisher {
  constructor(
    private readonly repository: ParserPublicationRepository,
    private readonly files: FileStore,
  ) {}
  publish(command: ParserPublication): Promise<ParserResult> {
    const copy = structuredClone(command);
    return this.files.withWrite(() => this.publishAdmitted(copy));
  }
  private async publishAdmitted(
    command: ParserPublication,
  ): Promise<ParserResult> {
    const publish = async (value: StagedParserArtifact) => {
      const a = value.artifact;
      if (
        value.bytes.length !== a.byte_size ||
        createHash("sha256").update(value.bytes).digest("hex") !== a.sha256
      )
        throw new ParsingFailure("parser-publication");
      const located = await this.repository.locateArtifact(a);
      const path = located?.reference ?? `objects/${a.sha256}.bin`;
      const stage = await this.files.stage({
        maxBytes: Math.max(1, a.byte_size),
      });
      try {
        await stage.write(value.bytes);
        await this.files.publish(stage, path);
      } finally {
        await stage.discard();
      }
      return {
        artifact_id: artifactId(a.sha256),
        artifact_path: path,
        artifact_sha256: a.sha256,
        artifact_byte_size: a.byte_size,
        artifact_media_type: a.media_type,
      };
    };
    const markdown = await publish(command.markdown);
    const resources = [];
    for (const r of command.resources)
      resources.push({ reference: r.reference, ...(await publish(r.content)) });
    const r = command.result;
    const accepted = await this.repository.commitCurrentParser(
      command.literature_id,
      {
        source_asset_id: r.source_asset_id,
        source_sha256: r.source_sha256,
        result_sha256: r.result_sha256,
        page_count: r.page_count,
        markdown_artifact_id: markdown.artifact_id,
        markdown_artifact_path: markdown.artifact_path,
        markdown_sha256: markdown.artifact_sha256,
        markdown_byte_size: markdown.artifact_byte_size,
        markdown_media_type: "text/markdown",
        provenance: r.provenance.provenance,
        parser_version: r.provenance.parser_version,
        mode: r.provenance.mode,
        model_identity: r.provenance.model_identity,
        resources,
      },
    );
    if (!accepted) throw new ParsingFailure("parser-stale");
    return accepted;
  }
}
