import { describe, expect, it } from "vitest";
import {
  EMPTY_METADATA,
  METADATA_FIELDS,
  parseMetadataFieldCandidate,
  type MetadataField,
  type MetadataFieldCandidate,
} from "@sciretriever/contracts";
import { adjudicateMetadataFields } from "../src/literature/metadata-fields.js";
function candidate(
  field: MetadataField,
  value: unknown,
  source: "authority" | "proofread" | "manual" = "authority",
): MetadataFieldCandidate {
  return parseMetadataFieldCandidate({
    field,
    value,
    evidence:
      source === "proofread"
        ? {
            source,
            document_version_id: "fixed-document",
            fragment_ids: ["p1"],
          }
        : {
            source,
            observation_id: `${source}-observation`,
            provenance: {
              provenance_id: "00000000-0000-4000-8000-000000000001",
              source_kind: source === "manual" ? "user" : "metadata-provider",
              source_name:
                source === "manual" ? "bibliographic-import" : "crossref",
              source_record_id: source === "manual" ? null : "record",
              observed_at: "2026-10-20T00:00:00Z",
              input_sha256: null,
              parameters_sha256: null,
            },
          },
  });
}
describe("field adjudication", () => {
  it.each([
    ["title", "Authority title", "Proofread title", "Authority title"],
    ["abstract", "Provider abstract", "Article abstract", "Article abstract"],
    ["article_kind", "review", "research-article", "research-article"],
    [
      "publication_form",
      "journal-article",
      "conference-paper",
      "journal-article",
    ],
    ["language", "en", "fr", "fr"],
  ] as const)("uses the accepted priority for %s", (field, a, b, expected) => {
    const result = adjudicateMetadataFields({
      current: EMPTY_METADATA,
      states: [],
      candidates: [candidate(field, b, "proofread"), candidate(field, a)],
    });
    expect(result.metadata[field]).toEqual(expected);
    expect(result.states[0]?.conflict).toBe(true);
    expect(result.states[0]?.conflicts).toHaveLength(1);
  });
  it("preserves a manual empty value across repeated archive and observation arrivals", () => {
    const first = adjudicateMetadataFields({
      current: EMPTY_METADATA,
      states: [],
      candidates: [candidate("title", "provider")],
      manual: [candidate("title", null, "manual")],
    });
    const next = adjudicateMetadataFields({
      current: first.metadata,
      states: first.states,
      candidates: [candidate("title", "replacement")],
    });
    expect(next.metadata.title).toBeNull();
    expect(next.states[0]?.locked).toBe(true);
  });
  it("adds missing fields after READY but preserves adjudicated nonempty fields and records conflicts", () => {
    const first = adjudicateMetadataFields({
      current: EMPTY_METADATA,
      states: [],
      candidates: [candidate("title", "old")],
    });
    const next = adjudicateMetadataFields({
      current: first.metadata,
      states: first.states,
      preserve_nonempty: true,
      candidates: [
        candidate("title", "new"),
        candidate("abstract", "new abstract"),
      ],
    });
    expect(next.metadata.title).toBe("old");
    expect(next.metadata.abstract).toBe("new abstract");
    expect(next.states.find((s) => s.field === "title")?.conflict).toBe(true);
  });
  it("does not fabricate provenance for legacy values", () => {
    const result = adjudicateMetadataFields({
      current: { ...EMPTY_METADATA, title: "legacy" },
      states: [],
      preserve_nonempty: true,
      candidates: [candidate("title", "new")],
    });
    expect(result.metadata.title).toBe("legacy");
    expect(result.states).toEqual([]);
  });
  it("normalizes case and spacing for conflict comparison and preserves the winning text", () => {
    const result = adjudicateMetadataFields({
      current: EMPTY_METADATA,
      states: [],
      candidates: [
        candidate("title", "A   Study"),
        candidate("title", "a study", "proofread"),
      ],
    });
    expect(result.states[0]?.conflict).toBe(false);
  });
  it("rejects stale states instead of overwriting unrelated manual edits", () => {
    const first = adjudicateMetadataFields({
      current: EMPTY_METADATA,
      states: [],
      manual: [candidate("title", "manual", "manual")],
      candidates: [],
    });
    expect(() =>
      adjudicateMetadataFields({
        current: { ...first.metadata, title: "changed" },
        states: first.states,
        candidates: [],
      }),
    ).toThrow("stale");
  });
  it("strictly validates the selected field type and evidence shape", () => {
    expect(METADATA_FIELDS).not.toContain("document_type");
    expect(() => candidate("article_kind", "journal-article")).toThrow();
    expect(() => candidate("publication_form", "preprint")).toThrow();
    expect(() => candidate("authors", ["A"])).toThrow();
    expect(() =>
      parseMetadataFieldCandidate({ ...candidate("title", "x"), extra: true }),
    ).toThrow();
  });
});
