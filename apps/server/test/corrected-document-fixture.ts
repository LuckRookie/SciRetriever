import type { Application } from "../src/bootstrap/application.js";
/** Fixture setup follows the three explicit production operations. It is not a product command. */
export function correctedDocumentFixture(app: Application) {
  return {
    async parseDocuments(
      value: {
        literature_id: string;
        asset_id: string;
        asset_sha256: string;
        mode?: string;
        expected_default_revision?: number | null;
      },
      signal?: AbortSignal,
    ) {
      const request = structuredClone(value);
      await app.documentProcessing.parseDocuments(
        {
          literature_id: request.literature_id,
          asset_id: request.asset_id,
          asset_sha256: request.asset_sha256,
          profiles: ["pipeline", "vlm-engine"],
          force: request.mode !== "reuse-current",
        },
        signal,
      );
      const proofread = await app.proofreading!.build(
        { asset_id: request.asset_id },
        signal,
      );
      if (proofread.version.status !== "complete")
        throw new Error(
          `Synthetic proofreading did not complete: ${JSON.stringify(proofread.version.failure)}`,
        );
      const published = await app.proofreadDocuments.publish(
        {
          literature_id: request.literature_id,
          asset_id: request.asset_id,
          proofread_id: proofread.version.proofread_id,
          expected_default_revision: request.expected_default_revision ?? null,
        },
        signal,
      );
      const version = (await app.database.documentVersion(
        published.document.document_version_id,
      ))!.version;
      if (version.schema_version !== 2)
        throw new Error("Corrected document required");
      return { ...published, document: version };
    },
  };
}
