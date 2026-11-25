import type {
  ArchiveState,
  LiteratureStatus,
  MissingStep,
} from "@sciretriever/contracts";

/** Current evidence, never the presence of an old summary, defines readiness. */
export function deriveCurrentState(
  facts: ArchiveState,
  maxTags = 6,
  archiveProfile: "pipeline" | "vlm-engine" = "vlm-engine",
): { status: LiteratureStatus; missing_step: MissingStep | null } {
  const main = facts.parts.find((p) => p.part === "main");
  if (!main) return { status: "UNREVIEWED", missing_step: "primary-pdf" };
  const accepted =
    facts.mode === "full"
      ? [archiveProfile, "vlm-engine-markdown-only"]
      : ["vlm-engine-markdown-only"];
  if (!accepted.some((p) => main.raw_profiles.includes(p)))
    return { status: "ASSET_READY", missing_step: "raw-parse" };
  if (!facts.started) return { status: "ASSET_READY", missing_step: "arrange" };
  const arranged = main.format === "arranged-v2";
  const missing: MissingStep | null =
    arranged &&
    !main.steps.some((s) => s.step === "arrange" && s.status === "done")
      ? "arrange"
      : !main.proofread_complete
        ? "proofread"
        : !main.document_version_id
          ? arranged
            ? "render"
            : "document"
          : !main.structure_satisfied
            ? arranged
              ? "render"
              : "structure"
            : facts.metadata_missing.length
              ? "metadata"
              : facts.tag_count < 1 || facts.tag_count > maxTags
                ? "tags"
                : null;
  if (facts.running) return { status: "ARCHIVING", missing_step: missing };
  if (
    ["correction-or-editorial", "perspective-or-commentary"].includes(
      facts.article_kind ?? "",
    )
  )
    return { status: "EXCLUDED", missing_step: null };
  // A translation issue never affects readiness (spec 9.3).
  const failure = facts.issues.find(
    (i) =>
      i.affects_readiness &&
      i.resolution !== "continue" &&
      i.step !== "translate",
  );
  if (failure && failure.step !== "translate")
    return { status: "ARCHIVE_FAILED", missing_step: failure.step };
  return { status: missing ? "ASSET_READY" : "READY", missing_step: missing };
}
