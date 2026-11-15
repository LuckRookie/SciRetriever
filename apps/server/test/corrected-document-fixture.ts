import type { Application } from "../src/bootstrap/application.js";
/** Prepares raw facts, then explicitly publishes corrected text for tests that require v2 evidence. */
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
      await app.rawParsing!.parseAsset(
        request.asset_id,
        ["pipeline", "vlm-engine"],
        signal,
        {
          expected_sha256: request.asset_sha256,
          force: request.mode !== "reuse-current",
        },
      );
      const proofread = await app.proofreading!.build(
        { asset_id: request.asset_id },
        signal,
      );
      if (proofread.version.status !== "complete")
        throw new Error(
          `Synthetic proofreading did not complete: ${JSON.stringify(proofread.version.failure)}`,
        );
      // Raw publication may invalidate the previous default.
      // Fixture setup publishes against the current revision of this phase;
      // stale-CAS behavior is exercised directly on the publication service.
      const current = await app.database.documentDefault(
        request.literature_id,
        request.asset_id,
        request.asset_sha256,
      );
      const published = await app.proofreadDocuments.publish(
        {
          literature_id: request.literature_id,
          asset_id: request.asset_id,
          proofread_id: proofread.version.proofread_id,
          expected_default_revision: current?.revision ?? null,
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
