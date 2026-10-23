import {
  parseEvidenceRef,
  sha256,
  archiveContentVersion,
  type ArchiveProcessorInput,
  type ProcessorInput,
  type ProcessorReads,
  type SnapshotMember,
} from "@sciretriever/contracts";
import type { ArchiveReader } from "../archive/service.js";
import type { SnapshotService } from "./snapshots.js";
import type { SqliteAnnotationStorage } from "../storage/structure-annotations.js";
import type { DocumentReadService } from "../document/read.js";
import { processorError, type ProcessorSegment } from "./processor.js";
export class ProcessorArchiveSource {
  constructor(
    readonly archive: ArchiveReader,
    readonly snapshots: SnapshotService,
    private readonly annotations: SqliteAnnotationStorage,
    private readonly documents: DocumentReadService,
  ) {}
  async input(
    literature_id: string,
    reads: ProcessorReads,
    signal: AbortSignal,
    fixed?: SnapshotMember,
  ): Promise<ProcessorInput> {
    const state = await this.archive.status(literature_id, signal);
    if (state.status !== "READY")
      return {
        kind: "missing",
        input_id: "document",
        literature_id,
        reason: "not-ready",
      };
    const parts =
      fixed?.parts ??
      state.parts.map((p) => ({
        asset_id: p.asset_id,
        asset_sha256: p.asset_sha256,
        part: p.part,
        available: p.content_version !== null,
        content_version: p.content_version,
        document_version_id: p.content_version ? p.document_version_id : null,
        structure_annotation_id: p.content_version
          ? p.structure_annotation_id
          : null,
      }));
    return {
      kind: "archive-document",
      input_id: "document",
      literature_id,
      description_version:
        fixed?.description_version ?? state.description_version!,
      parts: parts
        .filter((p) => reads.parts === "all" || p.part === reads.parts)
        .sort((a, b) => a.asset_id.localeCompare(b.asset_id)),
    };
  }
  async segments(
    input: ArchiveProcessorInput,
    reads: ProcessorReads,
    signal: AbortSignal,
  ): Promise<
    readonly (ProcessorSegment & {
      asset_id: string;
      part: "main" | "supplementary";
    })[]
  > {
    const result: (ProcessorSegment & {
      asset_id: string;
      part: "main" | "supplementary";
    })[] = [];
    for (const [partIndex, part] of input.parts.entries()) {
      if (reads.parts !== "all" && part.part !== reads.parts)
        processorError("processor-read-outside-scope");
      if (!part.available) continue;
      if (
        (await archiveContentVersion(
          part.document_version_id!,
          part.structure_annotation_id!,
        )) !== part.content_version
      )
        processorError("processor-input-changed");
      const annotation = await this.annotations.byId(
        part.structure_annotation_id!,
        signal,
      );
      if (
        !annotation ||
        annotation.document_version_id !== part.document_version_id
      )
        processorError("processor-input-changed");
      const roles = new Map(
        annotation.segment_roles.map((s) => [s.segment_id, s.role]),
      );
      await this.documents.withVerifiedVersion(
        part.document_version_id!,
        async (version, bytes, structure) => {
          if (
            version.schema_version !== 2 ||
            structure.schema_version !== 2 ||
            version.source_material_ref.asset_id !== part.asset_id ||
            version.source_material_ref.asset_sha256 !== part.asset_sha256 ||
            version.source_material_ref.literature_id !== input.literature_id
          )
            processorError("processor-corrected-required");
          for (const [ordinal, s] of structure.segments.entries()) {
            if (
              reads.roles !== "all" &&
              !reads.roles.some((r) => r === roles.get(s.segment_id))
            )
              continue;
            const text = bytes.subarray(s.start_utf8, s.end_utf8);
            const paragraphTexts =
              ["text", "list"].includes(s.kind) &&
              !/\$\$|\\\[|```|~~~|\\begin\{/u.test(
                new TextDecoder().decode(text),
              )
                ? new TextDecoder("utf8", { fatal: true })
                    .decode(text)
                    .split(/\n\s*\n/u)
                    .filter((t) => t.trim())
                : [new TextDecoder("utf8", { fatal: true }).decode(text)];
            for (const [paragraph, paragraphText] of paragraphTexts.entries())
              result.push({
                document_title: structure.sections[0]?.title ?? "",
                section_path: structure.sections
                  .filter(
                    (section) =>
                      s.start_utf8 >= section.start_utf8 &&
                      s.start_utf8 < section.end_utf8,
                  )
                  .sort((a, b) => a.level - b.level)
                  .map((section) => section.title),
                ...(s.kind === "heading"
                  ? {
                      heading_level:
                        structure.sections.find(
                          (section) => section.start_utf8 === s.start_utf8,
                        )?.level ?? 1,
                    }
                  : {}),
                kind: s.kind,
                page: s.page,
                part_key: part.asset_id,
                segment_id: `d${partIndex}:s${ordinal}${paragraphTexts.length > 1 ? `:p${paragraph}` : ""}`,
                basis: s.basis,

                text: paragraphText,
                asset_id: part.asset_id,
                part: part.part,
                citation: {
                  kind: "document",
                  evidence: parseEvidenceRef({
                    schema_version: 1,
                    target_kind: "document",
                    locator_scheme: "utf8-segment-v1",
                    document_version_id: version.document_version_id,
                    representation_sha256: version.representation_sha256,
                    locator: { kind: "segment", segment_id: s.segment_id },
                    content_sha256: await sha256(text),
                  }),
                },
              });
          }
        },
        signal,
      );
    }
    return result;
  }
}
