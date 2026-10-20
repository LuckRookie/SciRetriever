import { expect, it } from "vitest";
import { coreProcessingFixture } from "./core-processing-fixture.js";
import { SqliteAnnotationStorage } from "../src/storage/structure-annotations.js";
import { SqliteDocumentStorage } from "../src/document/storage.js";
import { ArchiveMetadataService } from "../src/literature/archive-metadata.js";
import type { MetadataFragment } from "../src/literature/metadata-proposals.js";
it("uses DSH over corrected front matter, keeps authority bibliography, applies abstract evidence and reports usage", async () => {
  const e = await coreProcessingFixture({ analysisModel: true });
  try {
    e.setText(
      "# Abstract\n\nA corrected synthetic abstract.\n\n# Introduction\n\nSynthetic body.\n\n# References\n\n[1] Example doi:10.1234/example\n",
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
    const store = new SqliteAnnotationStorage(e.app.database, e.app.files);
    const fragment = (await store.byId(
      annotation.annotation_id,
    ))!.segment_roles.find((s) => s.role === "abstract")!.segment_id;
    e.setModel(() => ({
      proposals: [
        {
          field: "abstract",
          value: "A corrected synthetic abstract.",
          fragment_ids: [fragment],
        },
        {
          field: "article_kind",
          value: "research-article",
          fragment_ids: [fragment],
        },
      ],
    }));
    const before = await e.app.metadataFields.read(
      e.rawParseRequest.literature_id,
    );
    const calls = e.modelCalls;
    const result = await e.app.archiveMetadata.build({
      literature_id: e.rawParseRequest.literature_id,
      document_version_id: doc.document_version_id,
      annotation_id: annotation.annotation_id,
      expected_revision: before.metadata_revision,
    });
    expect(e.modelCalls - calls).toBe(1);
    expect(result.usage.calls).toBe(1);
    const after = await e.app.metadataFields.read(
      e.rawParseRequest.literature_id,
    );
    expect(after.literature.metadata.abstract).toBe(
      "A corrected synthetic abstract.",
    );
    expect(after.literature.metadata.title).toBe(
      before.literature.metadata.title,
    );
    expect(
      after.field_states.find((f) => f.field === "abstract")?.evidence,
    ).toMatchObject({
      source: "proofread",
      document_version_id: doc.document_version_id,
      fragment_ids: [fragment],
    });
    // A stale metadata revision is rejected before another model request.
    await expect(
      e.app.archiveMetadata.build({
        literature_id: e.rawParseRequest.literature_id,
        document_version_id: doc.document_version_id,
        annotation_id: annotation.annotation_id,
        expected_revision: before.metadata_revision,
      }),
    ).rejects.toThrow("metadata-revision-stale");
    expect(e.modelCalls - calls).toBe(1);
  } finally {
    await e.close();
  }
});
it("detects required metadata omissions without inventing values", async () => {
  const e = await coreProcessingFixture({ analysisModel: false });
  try {
    e.setText("# Abstract\n\nSynthetic text.\n\n# References\n\n[1] Example\n");
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
    const before = await e.app.metadataFields.read(
      e.rawParseRequest.literature_id,
    );
    const cleared = await e.app.metadataFields.edit({
      literature_id: e.rawParseRequest.literature_id,
      expected_revision: before.metadata_revision,
      set: [{ field: "article_kind", value: null }],
      unlock: [],
    });
    let supplied: readonly MetadataFragment[] = [];
    const service = new ArchiveMetadataService(
      e.app.database,
      e.app.metadataFields,
      new SqliteDocumentStorage(e.app.database, e.app.files),
      new SqliteAnnotationStorage(e.app.database, e.app.files),
      {
        async propose(fragments) {
          supplied = fragments;
          return {
            value: { proposals: [] },
            usage: { calls: 1, input_tokens: 7, output_tokens: 1 },
            model: { provider: "fake", model: "fake" },
          };
        },
      },
    );
    const result = await service.build({
      literature_id: e.rawParseRequest.literature_id,
      document_version_id: doc.document_version_id,
      annotation_id: annotation.annotation_id,
      expected_revision: cleared.metadata_revision,
    });
    expect(result.status).toBe("failed");
    expect(result.missing).toContain("metadata-missing:article_kind");
    expect(supplied.length).toBeGreaterThan(0);
    expect(
      (await e.app.metadataFields.read(e.rawParseRequest.literature_id))
        .literature.metadata.article_kind,
    ).toBeNull();
  } finally {
    await e.close();
  }
});
