import { buildDraftDocument } from "../src/document/draft-builder.js";
import { SqliteDocumentStorage } from "../src/document/storage.js";
import { SqliteRawParseStorage } from "../src/storage/raw-parsing.js";
import { artifactReference } from "../src/storage/artifact-layout.js";
import { coreProcessingFixture } from "./core-processing-fixture.js";
import { imageBytes } from "./archive-text-fixture.js";
import { sha256, type ArtifactRef } from "@sciretriever/contracts";

/** The fake external parser is the only substitute; publication and readers are real. */
export async function draftStorageFixture() {
  const e = await coreProcessingFixture({
    offline: true,
    analysisModel: false,
  });
  const rawStore = new SqliteRawParseStorage(e.app.database, e.app.files);
  const storage = new SqliteDocumentStorage(e.app.database, e.app.files);
  let text =
    "# Synthetic draft\n\nA synthetic finding.\n\n![Synthetic image](images/draft.png)\n";
  e.setText(text);
  e.setResources([
    {
      reference: "images/draft.png",
      content: {
        bytes: imageBytes,
        artifact: {
          sha256: await sha256(imageBytes),
          byte_size: imageBytes.length,
          media_type: "image/png",
        } as ArtifactRef,
      },
    },
  ]);
  const prepare = async (nextText?: string) => {
    if (nextText) {
      text = nextText;
      e.setText(text);
    }
    await e.app.documentProcessing.parseDocuments({
      ...e.rawParseRequest,
      force: !!nextText,
    });
    const raw = (await rawStore.current(e.asset.asset_id)).find(
      (r) => r.profile === "vlm-engine",
    )!.result!;
    const loaded = (await rawStore.load(raw.raw_parse_id))!;
    const material = (await e.app.database.documentMaterial(
      e.rawParseRequest.literature_id,
      e.asset.asset_id,
    ))!;
    const output = await buildDraftDocument(
      raw,
      {
        async readArtifact(id, kind, reference) {
          if (id !== raw.raw_parse_id)
            throw new Error("Unexpected synthetic raw");
          if (kind === "blocks") return loaded.blocks!.bytes;
          if (kind === "markdown") return loaded.markdown.bytes;
          const resource = loaded.resources.find(
            (r) => r.reference === reference,
          );
          if (!resource) throw new Error("Unknown synthetic image");
          return resource.content.bytes;
        },
      },
      [
        {
          page: 0,
          kind: "text-layer",
          text,
          visible_glyphs: text.length,
          unmapped_glyphs: 0,
          hidden_glyphs: 0,
          has_graphics: true,
        },
      ],
      material.material,
    );
    const v = output.document;
    const path = async (
      kind: Parameters<typeof artifactReference>[0],
      artifact: ArtifactRef,
    ) =>
      (await e.app.database.locateArtifact(artifact))?.reference ??
      artifactReference(kind, artifact);
    const paths = {
      draft_content_artifact_path: await path("draft-content", v.draft_content),
      markdown_artifact_path: await path("draft-markdown", v.markdown),
      structure_artifact_path: await path("document-structure", v.structure),
    };
    await storage.publishImmutableArtifact(
      paths.draft_content_artifact_path,
      output.content_bytes,
      v.draft_content,
    );
    await storage.publishImmutableArtifact(
      paths.markdown_artifact_path,
      output.markdown,
      v.markdown,
    );
    await storage.publishImmutableArtifact(
      paths.structure_artifact_path,
      output.structure_bytes,
      v.structure,
    );
    const resources: Record<string, string> = {};
    for (const resource of v.resources)
      resources[resource.reference] = (await e.app.database.locateArtifact(
        resource.artifact,
      ))!.reference;
    return {
      output,
      publication: {
        version: v,
        source_artifact_path: material.path,
        ...paths,
        resource_artifact_paths: resources,
        expected_current_revision:
          (await e.app.database.draftCurrent(e.asset.asset_id))?.revision ??
          null,
      },
    };
  };
  try {
    const initial = await prepare();
    return {
      e,
      rawStore,
      storage,
      prepare,
      ...initial,
      async close() {
        await rawStore.close();
        await e.close();
      },
    };
  } catch (error) {
    await rawStore.close();
    await e.close();
    throw error;
  }
}
