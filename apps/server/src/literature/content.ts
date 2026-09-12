import { ftsIndexText } from "./unicode-casefold.js";
import { createHash } from "node:crypto";
import {
  contentCanonicalJsonBytes,
  parseLiteratureContent,
  parseLiteratureContentProposal,
  parseLiteratureDetail,
  parseArtifactRef,
  type LiteratureContent,
  type LiteratureContentProposal,
  type LiteratureDetail,
  type ArtifactRef,
} from "@sciretriever/contracts";
import type { FileStore } from "../storage/files/store.js";
import type { ContentAcceptanceCommit } from "../storage/sqlite/repositories.js";
export class ContentAcceptanceError extends Error {
  constructor(
    readonly code:
      | "content-structure"
      | "content-stale"
      | "content-publication"
      | "content-cancelled",
  ) {
    super("literature content acceptance failed");
  }
}
export interface ContentAcceptanceRepository {
  acceptLiteratureContent(command: ContentAcceptanceCommit): Promise<boolean>;
  locateArtifact(value: ArtifactRef): Promise<{
    readonly reference: string;
    readonly artifact: ArtifactRef;
  } | null>;
}
export async function decideContentAcceptance(
  current: LiteratureDetail,
  proposal: LiteratureContentProposal,
): Promise<LiteratureContent> {
  const p = proposal,
    asset = current.primary_pdf?.asset,
    parser = current.parser_result;
  if (
    current.literature.literature_id !== p.literature_id ||
    !asset ||
    asset.asset_id !== p.primary_asset_id ||
    asset.sha256 !== p.primary_pdf_sha256 ||
    !parser ||
    parser.source_asset_id !== asset.asset_id ||
    parser.source_sha256 !== asset.sha256 ||
    parser.result_sha256 !== p.parser_result_sha256 ||
    current.metadata_revision !== p.input_metadata_revision ||
    current.metadata_sha256 !== p.input_metadata_sha256
  )
    throw new ContentAcceptanceError("content-stale");
  if (
    p.final_metadata.title === null &&
    !p.final_metadata.identifiers.some((i) => i.namespace === "doi")
  )
    throw new ContentAcceptanceError("content-structure");
  return parseLiteratureContent({
    literature_content_sha256: p.literature_content_sha256,
    metadata_revision: current.metadata_revision + 1,
    metadata_sha256: p.metadata_sha256,
    sections: p.sections,
    references: p.references,
    markdown: p.markdown,
    provenance: p.provenance,
  });
}
/** Literature alone assigns the output revision; Storage commits the entire replacement atomically. */
export class LiteratureContentService {
  constructor(
    private readonly library: { detail(id: string): Promise<LiteratureDetail> },
    private readonly repository: ContentAcceptanceRepository,
    private readonly files: FileStore,
  ) {}
  async accept(
    value: unknown,
    markdownBytes: Uint8Array,
    signal?: AbortSignal,
  ): Promise<LiteratureContent> {
    const check = () => {
      if (signal?.aborted)
        throw new ContentAcceptanceError("content-cancelled");
    };
    check();
    let proposal: LiteratureContentProposal, bytes: Uint8Array;
    try {
      if (
        !(markdownBytes instanceof Uint8Array) ||
        markdownBytes.length > 16 * 1024 * 1024
      )
        throw new ContentAcceptanceError("content-structure");
      bytes = Uint8Array.from(markdownBytes);
      proposal = await parseLiteratureContentProposal(structuredClone(value));
      if (
        bytes.length !== proposal.markdown.byte_size ||
        createHash("sha256").update(bytes).digest("hex") !==
          proposal.markdown.sha256
      )
        throw new ContentAcceptanceError("content-structure");
    } catch {
      throw new ContentAcceptanceError("content-structure");
    }
    check();
    const current = await parseLiteratureDetail(
      await this.library.detail(proposal.literature_id),
    );
    const content = await decideContentAcceptance(current, proposal);
    const structured = contentCanonicalJsonBytes(content);
    if (structured.length > 16 * 1024 * 1024)
      throw new ContentAcceptanceError("content-structure");
    const descriptor = parseArtifactRef({
      sha256: createHash("sha256").update(structured).digest("hex"),
      byte_size: structured.length,
      media_type: "application/json",
    });
    check();
    const publish = async (artifact: ArtifactRef, bytes: Uint8Array) => {
      const located = await this.repository.locateArtifact(artifact);
      const path = located?.reference ?? `objects/${artifact.sha256}.bin`;
      const stage = await this.files.stage({ maxBytes: artifact.byte_size });
      try {
        await stage.write(bytes);
        await this.files.publish(stage, path);
      } finally {
        await stage.discard();
      }
      const h = artifact.sha256;
      return {
        id: `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`,
        path,
      };
    };
    try {
      return await this.files.withWrite(async () => {
        check();
        const json = await publish(descriptor, structured),
          markdown = await publish(content.markdown, bytes);
        const accepted = await this.repository.acceptLiteratureContent({
          input_metadata_revision: proposal.input_metadata_revision,
          input_metadata_sha256: proposal.input_metadata_sha256,
          final_metadata: proposal.final_metadata,
          content_body: content.sections
            .flatMap((s) => [
              s.title ?? "",
              s.markdown,
              ...s.subsections.flatMap((sub) => [sub.title, sub.markdown]),
            ])
            .map(ftsIndexText)
            .filter(Boolean)
            .join("\n"),
          content: {
            literature_id: proposal.literature_id,
            literature_content_sha256: content.literature_content_sha256,
            metadata_revision: content.metadata_revision,
            metadata_sha256: content.metadata_sha256,
            primary_asset_id: proposal.primary_asset_id,
            primary_asset_sha256: proposal.primary_pdf_sha256,
            parser_result_sha256: proposal.parser_result_sha256,
            structured_artifact_id: json.id,
            structured_artifact_path: json.path,
            structured_artifact_sha256: descriptor.sha256,
            structured_artifact_byte_size: descriptor.byte_size,
            structured_artifact_media_type: descriptor.media_type,
            markdown_artifact_id: markdown.id,
            markdown_artifact_path: markdown.path,
            markdown_artifact_sha256: content.markdown.sha256,
            markdown_artifact_byte_size: content.markdown.byte_size,
            markdown_artifact_media_type: "text/markdown",
            provenance: content.provenance,
            reference_texts: content.references,
          },
        });
        if (!accepted) throw new ContentAcceptanceError("content-stale");
        return content;
      }, signal);
    } catch (error) {
      if (error instanceof ContentAcceptanceError) throw error;
      throw new ContentAcceptanceError("content-publication");
    }
  }
}
