import { coreProcessingFixture } from "./core-processing-fixture.js";
import { SqliteDocumentStorage } from "../src/document/storage.js";
import { SqliteAnnotationStorage } from "../src/storage/structure-annotations.js";
import { TagService, type TagModel } from "../src/tags/service.js";
import type { TagDraft, TagAssignment } from "@sciretriever/contracts";
export const topicDraft = (
  name: string,
  parent_id: string | null = null,
): TagDraft => ({
  name_zh: "",
  name_en: name,
  aliases: [],
  definition: { includes: name, excludes: "" },
  parent_id,
  category: "Synthetic science",
  kind: "topic",
});
export async function tagFixture(model: TagModel | null = null) {
  const e = await coreProcessingFixture();
  try {
    e.setText(
      "# Abstract\n\nSynthetic photoredox catalysis studies.\n\n# Introduction\n\nVisible light catalysis.\n\n# Conclusion\n\nThe main finding concerns photocatalysis.\n",
    );
    await e.app.documentProcessing.parseDocuments(e.rawParseRequest);
    const proof = await e.app.proofreading!.build({
      asset_id: e.asset.asset_id,
    });
    const doc = (
      await e.app.proofreadDocuments.publish({
        literature_id: e.rawParseRequest.literature_id,
        asset_id: e.asset.asset_id,
        proofread_id: proof.version.proofread_id,
        expected_default_revision: null,
      })
    ).document;
    const annotation = await e.app.structureAnnotations!.build({
      document_version_id: doc.document_version_id,
      max_prefix_characters: 128,
    });
    const documents = new SqliteDocumentStorage(e.app.database, e.app.files),
      annotations = new SqliteAnnotationStorage(e.app.database, e.app.files);
    const tags = new TagService(
      e.app.database,
      documents,
      annotations,
      e.app.metadataFields,
      model,
    );
    const id = e.rawParseRequest.literature_id;
    const segments = (await annotations.byId(
      annotation.annotation_id,
    ))!.segment_roles
      .filter((s) => s.role === "abstract")
      .map((s) => s.segment_id);
    const create = async (name: string, parent_id: string | null = null) => {
      const c = await tags.change({
        mutation: { op: "create", tag: topicDraft(name, parent_id) },
        expected_version: (await tags.state()).version,
        reason: "Synthetic tag",
      });
      return c.inverse[0]!.tag_id;
    };
    const assign = async (
      ids: readonly string[],
      locked = false,
    ): Promise<TagAssignment> =>
      tags.assign({
        literature_id: id,
        items: ids.map((tag_id, n) => ({
          tag_id,
          rank: n + 1,
          reason: "Synthetic evidence",
          evidence: [
            {
              document_version_id: doc.document_version_id,
              segment_ids: segments,
            },
          ],
          origin: "manual",
          locked,
        })),
        expected_revision: (await tags.assignment(id))?.revision ?? 0,
        expected_version: (await tags.state()).version,
        model: null,
        reason: "Synthetic assignment",
      });
    return {
      ...e,
      tags,
      doc,
      annotation,
      id,
      segments,
      create,
      assign,
      request: {
        literature_id: id,
        document_version_id: doc.document_version_id,
        annotation_id: annotation.annotation_id,
      },
    };
  } catch (error) {
    await e.close();
    throw error;
  }
}
