import { parseAssetId, parseLiteratureId } from "@sciretriever/contracts";
import type { Application } from "../bootstrap/application.js";
import { operationRecord, ProductOperationError } from "./query-operations.js";

/** One explicit save, then deterministic publication/structure/reference rebuild. */
export async function saveProofread(
  app: Application,
  value: unknown,
  signal?: AbortSignal,
) {
  const r = operationRecord(
    value,
    ["literature_id", "asset_id", "proofread_id", "markdown", "actor"],
    ["page_starts_utf8"],
  );
  const literature = parseLiteratureId(r.literature_id),
    asset = parseAssetId(r.asset_id);
  if (!app.proofreading || !app.structureAnnotations)
    throw new ProductOperationError("proofread-unavailable");
  const initial = await app.archive.status(literature, signal),
    part = initial.parts.find((p) => p.asset_id === asset);
  if (!part) throw new ProductOperationError("material-missing");
  const { literature_id, ...edit } = r;
  void literature_id;
  const saved = await app.proofreading.save(edit, signal);
  if (!saved.changed)
    return {
      saved: true,
      changed: false,
      proofread_id: saved.version.proofread_id,
      rebuild: { status: "unchanged" },
    };
  try {
    const current = await app.database.documentDefault(
      literature,
      asset,
      part.asset_sha256,
    );
    const published = await app.proofreadDocuments.publish(
      {
        literature_id: literature,
        asset_id: asset,
        proofread_id: saved.version.proofread_id,
        expected_default_revision: current?.revision ?? null,
      },
      signal,
    );
    const document = await app.database.documentDefault(
      literature,
      asset,
      part.asset_sha256,
    );
    if (!document) throw new ProductOperationError("document-missing");
    const structure = await app.structureAnnotations.buildRules(
      { document_version_id: document.document_version_id },
      signal,
    );
    const references =
      part.part === "main"
        ? await app.archiveReferences.build(
            {
              literature_id: literature,
              document_version_id: document.document_version_id,
              annotation_id: structure.annotation_id,
            },
            signal,
          )
        : null;
    return {
      saved: true,
      changed: true,
      proofread_id: saved.version.proofread_id,
      rebuild: {
        status: "completed",
        document: published,
        structure,
        references,
      },
    };
  } catch (error) {
    if (signal?.aborted) throw error;
    const code =
      error &&
      typeof error === "object" &&
      "code" in error &&
      typeof error.code === "string"
        ? error.code
        : "proofread-rebuild-failed";
    return {
      saved: true,
      changed: true,
      proofread_id: saved.version.proofread_id,
      rebuild: { status: "failed", code },
    };
  }
}
