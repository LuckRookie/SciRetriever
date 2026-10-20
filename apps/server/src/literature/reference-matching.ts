import {
  EMPTY_METADATA,
  parseIdentifier,
  type LiteratureMetadata,
  type Literature,
  type StructureReference,
} from "@sciretriever/contracts";
import {
  decodeBibliography,
  type BibliographyInputFormat,
} from "./bibliography-import.js";
import {
  fallbackIdentityKey,
  resolveLiteratureIdentity,
} from "./identity-rules.js";
/** No fuzzy citation parsing. Structured citations may supply a complete strict fallback key. */
export function referenceIdentityMetadata(
  reference: Pick<StructureReference, "doi" | "text">,
): LiteratureMetadata | null {
  if (reference.doi !== null) {
    try {
      return {
        ...EMPTY_METADATA,
        identifiers: [
          parseIdentifier({ namespace: "doi", value: reference.doi }),
        ],
      };
    } catch {
      return null;
    }
  }
  const text = reference.text.trim();
  const format: BibliographyInputFormat | null = /^@[a-z]+\s*[{(]/iu.test(text)
    ? "bibtex"
    : /^TY\s*- /u.test(text)
      ? "ris"
      : /^[{[]/u.test(text)
        ? "csl-json"
        : null;
  if (!format) return null;
  const result = decodeBibliography(Buffer.from(text), format, {
    maxInputBytes: 65536,
    observationId: () => "00000000-0000-4000-8000-000000000001",
    provenanceId: () => "00000000-0000-4000-8000-000000000002",
    observedAt: () => "2026-10-20T00:00:00Z",
  });
  if (result.items.length !== 1 || result.items[0]?.status !== "decoded")
    return null;
  const metadata = result.items[0].observation!.metadata;
  return metadata.identifiers.some((i) => i.namespace === "doi") ||
    fallbackIdentityKey(metadata)
    ? metadata
    : null;
}
export function matchArchiveReference(
  sourceId: string,
  reference: Pick<StructureReference, "doi" | "text">,
  candidates: readonly Literature[],
) {
  const metadata = referenceIdentityMetadata(reference);
  if (!metadata)
    return {
      target: null,
      basis: null,
      reason: "reference-identity-incomplete",
    } as const;
  const match = resolveLiteratureIdentity(metadata, candidates);
  if (match.decision !== "matched")
    return { target: null, basis: null, reason: match.reason } as const;
  if (match.literature.literature_id === sourceId)
    return {
      target: null,
      basis: null,
      reason: "reference-self-link",
    } as const;
  return {
    target: match.literature,
    basis:
      match.reason === "fallback"
        ? ("strict-fallback" as const)
        : metadata.identifiers.some((i) => i.namespace === "doi")
          ? ("doi" as const)
          : ("stable-identifier" as const),
    reason: null,
  };
}
