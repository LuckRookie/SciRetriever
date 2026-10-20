import {
  createInputManifest,
  parseExtractionPreparationRequest,
  requiredPreparationCapabilities,
  type InputManifestItem,
} from "@sciretriever/contracts";
import type { DocumentReadService } from "../src/document/read.js";

/** An external caller binds its own raw inputs using public read contracts. */
export async function externalManifestFixture(
  documents: DocumentReadService,
  value: unknown,
) {
  const { spec, inputs } = await parseExtractionPreparationRequest(value);
  const items: InputManifestItem[] = [];
  for (const input of inputs) {
    const evidence =
      input.asset_id === null
        ? null
        : (
            await documents.materialEvidence({
              literature_id: input.literature_id,
              asset_id: input.asset_id,
            })
          ).evidence;
    if (
      evidence &&
      (evidence.target_kind !== "material" ||
        evidence.material.asset_sha256 !== input.asset_sha256)
    )
      throw new Error("External fixture material binding mismatch");
    const material =
      evidence?.target_kind === "material" ? evidence.material : null;
    const described =
      input.document_version_id === null
        ? null
        : await documents.describe({
            document_version_id: input.document_version_id,
          });
    const capabilities: InputManifestItem["capabilities"][number][] = material
      ? ["material-file-v1"]
      : [];
    if (described) {
      capabilities.push("document-segment-v1");
      if (described.capabilities.text) capabilities.push("document-text-v1");
      if (described.capabilities.outline)
        capabilities.push("document-outline-v1");
      if (described.capabilities.resources)
        capabilities.push("document-resources-v1");
    }
    items.push({
      input_id: input.input_id,
      literature_id: input.literature_id,
      material,
      document: described?.document ?? null,
      capabilities,
      gaps: described
        ? []
        : material
          ? ["document-missing"]
          : ["material-missing", "document-missing"],
    });
  }
  const manifest = await createInputManifest(items);
  return {
    spec,
    manifest,
    missing_required_capabilities: manifest.items
      .map((item) => ({
        input_id: item.input_id,
        capabilities: requiredPreparationCapabilities(spec).filter(
          (capability) => !item.capabilities.includes(capability),
        ),
      }))
      .filter((item) => item.capabilities.length > 0),
  };
}
