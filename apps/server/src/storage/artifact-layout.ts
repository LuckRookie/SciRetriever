import type { ArtifactRef } from "@sciretriever/contracts";

const directories = {
  "original-pdf": "originals/pdf",
  "parser-markdown": "parsed/markdown",
  "parser-resource": "parsed/resources",
  "raw-parse-manifest": "parsed/raw/manifests",
  "raw-parse-blocks": "parsed/raw/blocks",
  "raw-parse-private": "parsed/raw/private",
  "proofread-manifest": "parsed/proofread/manifests",
  "proofread-blocks": "parsed/proofread/blocks",
  "proofread-markdown": "parsed/proofread/markdown",
  "proofread-drafts": "parsed/proofread/drafts",
  "proofread-cache": "parsed/proofread/cache",
  "proofread-decision": "parsed/proofread/decisions",
  "structure-annotation": "parsed/annotations",
  "document-structure": "parsed/structure",
  "knowledge-summary": "knowledge/summaries",
  "knowledge-synthesis": "knowledge/syntheses",
  "processor-result": "knowledge/results",
  "processor-collection": "knowledge/collections",
} as const;

const extensions: Readonly<Record<string, string>> = {
  "application/pdf": "pdf",
  "text/markdown": "md",
  "application/json": "json",
  "application/vnd.sciretriever.knowledge+json": "json",
  "text/plain": "txt",
  "text/csv": "csv",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/svg+xml": "svg",
  "image/avif": "avif",
  "image/bmp": "bmp",
};

/** New immutable bytes only. Existing catalog references always take priority. */
export function artifactReference(
  kind: keyof typeof directories,
  artifact: Pick<ArtifactRef, "sha256" | "media_type">,
): string {
  if (!/^[a-f0-9]{64}$/u.test(artifact.sha256))
    throw new TypeError("Invalid artifact digest");
  const directory =
    kind === "parser-resource" && artifact.media_type.startsWith("image/")
      ? "parsed/images"
      : directories[kind];
  const extension = extensions[artifact.media_type] ?? "bin";
  return `${directory}/${artifact.sha256.slice(0, 2)}/${artifact.sha256}.${extension}`;
}

/** Namespace check; callers must also validate the relative path and ownership. */
export function hasManagedArtifactPrefix(reference: string): boolean {
  return [
    ...Object.values(directories),
    "parsed/images",
    "objects",
    ".objects",
    ".candidates",
  ].some((directory) => reference.startsWith(`${directory}/`));
}
