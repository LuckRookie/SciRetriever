import { parseProofreadBlocksV1 } from "@sciretriever/contracts";
import { arrangementLeafId } from "../archive/arrangement.js";
import { isArrangedBuilder } from "../archive/render.js";
import type { DocumentReadService } from "../document/read.js";
import type { SqliteDocumentStorage } from "../document/storage.js";
import type { LiteratureQueryService } from "../literature/query.js";
import type { SqliteArchiveTextStorage } from "../storage/archive-text.js";
import type { SqliteProofreadStorage } from "../storage/proofread.js";
import type { SqliteAnnotationStorage } from "../storage/structure-annotations.js";
import type { FullTextSource } from "./fulltext.js";

/** Translation follows one primary default, never an unrelated current proofread. */
export function fullTextSource(options: {
  readonly library: Pick<LiteratureQueryService, "detail">;
  readonly documents: Pick<
    DocumentReadService,
    "default" | "withVerifiedTextVersion"
  >;
  readonly drafts: Pick<SqliteDocumentStorage, "draftContent">;
  readonly corrected: Pick<SqliteArchiveTextStorage, "load">;
  readonly legacy: Pick<SqliteProofreadStorage, "documentSource">;
  readonly annotations: Pick<SqliteAnnotationStorage, "current">;
}) {
  return async (
    literatureId: string,
    signal?: AbortSignal,
  ): Promise<FullTextSource | null> => {
    const asset = (await options.library.detail(literatureId)).primary_pdf
      ?.asset;
    if (!asset) return null;
    const current = await options.documents.default(
      {
        literature_id: literatureId,
        asset_id: asset.asset_id,
        asset_sha256: asset.sha256,
      },
      signal,
    );
    if (!current.default) return null;
    return options.documents.withVerifiedTextVersion(
      current.default.document_version_id,
      async (version, _bytes, structure) => {
        if (
          version.source_material_ref.asset_id !== asset.asset_id ||
          version.source_material_ref.asset_sha256 !== asset.sha256 ||
          version.source_material_ref.literature_id !== literatureId
        )
          throw new Error("Translation default material changed");
        if (version.schema_version === 3) {
          const content = await options.drafts.draftContent(version, signal);
          const retained = new Set(content.leaves.map((leaf) => leaf.leaf_id));
          return {
            page_count: content.pages.length,
            blocks: content.source_blocks.flatMap((root) => {
              const leaf_id = arrangementLeafId(
                root.root_block_id,
                0,
                [...root.text].length,
                content.raw.result_sha256,
              );
              return retained.has(leaf_id)
                ? [
                    {
                      leaf_id,
                      type: root.type,
                      role: "",
                      region: root.region_hint,
                      page_index: root.page_hint,
                      source: root.text,
                    },
                  ]
                : [];
            }),
          };
        }
        if (isArrangedBuilder(version.builder_version)) {
          const output = await options.corrected.load(
            version.proofread_id,
            signal,
          );
          if (!output) throw new Error("Translation corrected source missing");
          return {
            page_count: output.bundle.page_count,
            blocks: output.bundle.leaves.flatMap((leaf) =>
              leaf.destination.kind === "assigned"
                ? [
                    {
                      leaf_id: leaf.leaf.leaf_id,
                      type: leaf.leaf.type,
                      role: leaf.destination.target.role,
                      region: leaf.leaf.region,
                      page_index: leaf.leaf.page_index,
                      source: leaf.corrected_text ?? leaf.leaf.original_text,
                    },
                  ]
                : [],
            ),
          };
        }
        const source = await options.legacy.documentSource(
          version.proofread_id,
          signal,
        );
        const blocks = parseProofreadBlocksV1(
          JSON.parse(
            new TextDecoder("utf-8", { fatal: true }).decode(source.blocks),
          ),
          version.resources.map((resource) => resource.reference),
        );
        const annotation = await options.annotations.current(
          version.document_version_id,
          signal,
        );
        const roles = new Map(
          annotation?.segment_roles.map((segment) => [
            segment.segment_id,
            segment.role,
          ]),
        );
        const segments = new Map(
          structure.segments.flatMap((segment) =>
            "block_id" in segment ? [[segment.block_id, segment] as const] : [],
          ),
        );
        return {
          page_count: blocks.page_count,
          blocks: blocks.blocks.flatMap((block) => {
            const segment = segments.get(block.block_id);
            return segment
              ? [
                  {
                    leaf_id: block.block_id,
                    type: block.type,
                    role: roles.get(segment.segment_id) ?? "",
                    region: block.region,
                    page_index: block.page,
                    source: block.text,
                  },
                ]
              : [];
          }),
        };
      },
      signal,
    );
  };
}
