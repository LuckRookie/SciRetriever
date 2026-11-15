import { parseDocumentRequest } from "@sciretriever/contracts";
import type { nextWorkspace } from "./next-workspace-fixture.js";
import { missingId } from "./processor-workspace-fixture.js";
import { syntheticReadingPdf } from "./reading-pdf-fixture.js";

type Workspace = Awaited<ReturnType<typeof nextWorkspace>>;
type Setup = NonNullable<Parameters<typeof nextWorkspace>[0]>["setup"];

/** The text the draft is formed from: a title, a paragraph and a second one. */
export const DRAFT_TEXT =
  "# Synthetic research paper - page 1\n\nPage 1: reported results and evidence.\n\nA second paragraph of the draft.";

/** Setup: the unparsed paper gets a one-page PDF (plan 21: parsing forms its draft). */
export const draftPdf: Setup = async (env) => {
  await env.app.maintenance!.ingestPdf({
    literature_id: missingId,
    bytes: syntheticReadingPdf(1),
  });
};

/**
 * Parses that paper as a processing operation (the Web has no parse action),
 * which forms a draft that becomes its default text. Returns the draft's
 * document version.
 */
export async function formDraft(w: Workspace) {
  w.env.setText(DRAFT_TEXT);
  const asset = (await w.env.app.library.detail(missingId)).primary_pdf!.asset;
  const job = await w.env.app.processingTasks!.submit({
    schema_version: 1,
    idempotency_key: "draft-fixture-parse",
    operations: [
      {
        operation: "parse-documents",
        request: parseDocumentRequest({
          literature_id: missingId,
          asset_id: asset.asset_id,
          asset_sha256: asset.sha256,
          force: false,
        }),
      },
    ],
  });
  await w.env.app.processingTasks!.run(job.job_id);
  const read = await w.env.app.documentRead.default({
    literature_id: missingId,
    asset_id: asset.asset_id,
    asset_sha256: asset.sha256,
  });
  if (!read.default) throw new Error("the fixture's draft was not formed");
  return read.default.document_version_id;
}

export { doubtfulDraft } from "./draft-doubts.js";
