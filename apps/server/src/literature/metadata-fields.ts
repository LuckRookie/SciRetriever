import {
  canonicalJsonText as canonical,
  METADATA_FIELDS,
  parseLiteratureMetadata,
  parseMetadataFieldCandidate,
  type LiteratureMetadata,
  type MetadataField,
  type MetadataFieldCandidate,
  type MetadataFieldState,
} from "@sciretriever/contracts";
import { normalizeIdentityText } from "./identity-rules.js";
import { authorListsAlign } from "./metadata-rules.js";

const PROOFREAD_FIRST = new Set<MetadataField>([
  "article_kind",
  "abstract",
  "language",
  "keywords",
]);
export function metadataFieldEmpty(value: unknown): boolean {
  return value === null || (Array.isArray(value) && value.length === 0);
}
export function metadataValuesEqual(
  field: MetadataField,
  left: LiteratureMetadata[MetadataField],
  right: LiteratureMetadata[MetadataField],
): boolean {
  if (field === "authors" && Array.isArray(left) && Array.isArray(right))
    return authorListsAlign(
      left as LiteratureMetadata["authors"],
      right as LiteratureMetadata["authors"],
    );
  if (typeof left === "string" && typeof right === "string")
    return normalizeIdentityText(left) === normalizeIdentityText(right);
  if (field === "keywords" && Array.isArray(left) && Array.isArray(right))
    return (
      canonical(
        (left as readonly string[]).map(normalizeIdentityText).sort(),
      ) ===
      canonical((right as readonly string[]).map(normalizeIdentityText).sort())
    );
  if (field === "identifiers" && Array.isArray(left) && Array.isArray(right))
    return (
      canonical([...left].map(canonical).sort()) ===
      canonical([...right].map(canonical).sort())
    );
  return canonical(left) === canonical(right);
}
function priority(
  field: MetadataField,
  source: MetadataFieldCandidate["evidence"]["source"],
) {
  return source === "manual"
    ? 0
    : (source === "proofread") === PROOFREAD_FIRST.has(field)
      ? 1
      : 2;
}

/** One deterministic rule table for archive, observation arrivals and manual edits. */
export function adjudicateMetadataFields(input: {
  readonly current: LiteratureMetadata;
  readonly states: readonly MetadataFieldState[];
  /** Candidates already follow the configured provider precedence within the same source class. */
  readonly candidates: readonly MetadataFieldCandidate[];
  readonly manual?: readonly MetadataFieldCandidate[];
  readonly unlock?: readonly MetadataField[];
  readonly preserve_nonempty?: boolean;
}): {
  readonly metadata: LiteratureMetadata;
  readonly states: readonly MetadataFieldState[];
} {
  const metadata = { ...parseLiteratureMetadata(input.current) };
  const candidates = new Map<MetadataField, MetadataFieldCandidate[]>();
  input.candidates.forEach((value) => {
    const candidate = parseMetadataFieldCandidate(value);
    if (metadataFieldEmpty(candidate.value)) return;
    const values = candidates.get(candidate.field);
    if (values) values.push(candidate);
    else candidates.set(candidate.field, [candidate]);
  });
  const manual = (input.manual ?? []).map(parseMetadataFieldCandidate);
  if (
    manual.some((c) => c.evidence.source !== "manual") ||
    new Set(manual.map((c) => c.field)).size !== manual.length
  )
    throw new Error("invalid manual field decisions");
  const states: MetadataFieldState[] = [];
  for (const field of METADATA_FIELDS) {
    const previous = input.states.find((s) => s.field === field);
    if (
      previous &&
      !metadataValuesEqual(field, metadata[field], previous.value)
    )
      throw new Error("metadata field state is stale");
    const edit = manual.find((c) => c.field === field);
    const unlocked = input.unlock?.includes(field) ?? false;
    let locked = edit !== undefined || (previous?.locked === true && !unlocked);
    const values = candidates.get(field) ?? [];
    if (
      previous &&
      (previous.evidence.source !== "manual" || locked || values.length === 0)
    )
      values.push(previous);
    // Stable sort preserves declared source precedence and never chooses by arrival timestamp.
    values.sort(
      (a, b) =>
        priority(field, a.evidence.source) - priority(field, b.evidence.source),
    );
    const preserve =
      (input.preserve_nonempty ?? false) &&
      !metadataFieldEmpty(metadata[field]);
    const selected = edit ?? (locked || preserve ? previous : values[0]);
    if (!selected) continue; // Unattributed historic fields are not assigned invented provenance.
    if (unlocked && !edit) locked = false;
    const conflicts: MetadataFieldCandidate[] = [];
    for (const candidate of values) {
      if (
        candidate === selected ||
        metadataFieldEmpty(candidate.value) ||
        metadataFieldEmpty(selected.value) ||
        metadataValuesEqual(field, selected.value, candidate.value)
      )
        continue;
      if (!conflicts.some((other) => canonical(other) === canonical(candidate)))
        conflicts.push({
          field,
          value: candidate.value,
          evidence: candidate.evidence,
        });
    }
    Object.assign(metadata, { [field]: selected.value });
    states.push(
      Object.freeze({
        field,
        value: selected.value,
        evidence: selected.evidence,
        locked,
        conflict: conflicts.length > 0,
        conflicts: Object.freeze(conflicts),
      }),
    );
  }
  return {
    metadata: parseLiteratureMetadata(metadata),
    states: Object.freeze(states),
  };
}
