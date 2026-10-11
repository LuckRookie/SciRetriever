import { describe, expect, it, vi } from "vitest";
import { parseMetadataObservation } from "@sciretriever/contracts";
import {
  metadataDate,
  metadataDateParts,
  metadataInteger,
  parseProviderObservation,
} from "../src/providers/shared/metadata-values.js";

function candidate() {
  return {
    observation_id: "00000000-0000-4000-8000-000000000001",
    provenance: {
      provenance_id: "00000000-0000-4000-8000-000000000002",
      source_kind: "metadata-provider",
      source_name: "fixture",
      source_record_id: "10.1000/boundary",
      observed_at: "2026-10-10T00:00:00Z",
      input_sha256: "a".repeat(64),
      parameters_sha256: null,
    },
    metadata: {
      title: "Valid title",
      authors: [],
      abstract: null,
      publication_date: null,
      publication_year: null,
      document_type: null,
      language: null,
      venue: null,
      publisher: null,
      volume: null,
      issue: null,
      pages: null,
      identifiers: [{ namespace: "doi", value: "10.1000/boundary" }],
      keywords: [],
    },
    version_role: "published",
    version_links: [],
    declared_keywords: [],
    reference_texts: [],
    reference_count: null,
    cited_by_count: null,
    asset_hints: [],
  };
}
const diagnostics = () => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
});

describe("optional metadata field boundary", () => {
  it.each([
    [" 2024 ", 2024],
    ["0", 0],
    [12, 12],
    ["2024 draft", null],
    ["1.2", null],
    ["1e3", null],
    ["0xff", null],
    [true, null],
    [null, null],
    [-1, null],
    [Number.MAX_SAFE_INTEGER + 1, null],
  ])("accepts only complete nonnegative integers: %j", (input, expected) => {
    expect(metadataInteger(input)).toBe(expected);
  });

  it.each([
    [[2024, null, 12], "2024"],
    [[2024, 13, 1], "2024"],
    [[2024, 2, 29], "2024-02-29"],
    [[2023, 2, 29], "2023-02"],
    [[1900, 2, 29], "1900-02"],
    [[2000, 2, 29], "2000-02-29"],
    [[2024, 4, 31], "2024-04"],
    [[0, 1, 1], null],
    [[2024.5], null],
    [["2024", 1, 1], null],
  ])("retains only positional date precision: %j", (input, expected) => {
    expect(metadataDateParts(input)).toBe(expected);
  });

  it.each([
    ["2024", "2024"],
    ["2024-02", "2024-02"],
    ["2024-02-29T10:20:30.456+08:00", "2024-02-29"],
    ["2024-02-29T10:20:30Z", "2024-02-29"],
    ["2024-02-31", "2024-02"],
    ["2024-00-12", "2024"],
    ["2024 draft", null],
    ["March 2024", null],
  ])("supports explicit date forms without guessing: %s", (input, expected) => {
    expect(metadataDate(input)).toBe(expected);
  });

  it("retains useful author and list fields while logging only paths", () => {
    const input = candidate();
    const log = diagnostics();
    const author = {
      kind: "person",
      display_name: "Ada\n Lovelace",
      given_name: "Ada",
      family_name: "Lovelace",
      orcid: "invalid-orcid",
      affiliations: [{ name: "Valid institute", ror: "invalid-ror" }, null],
    };
    const result = parseProviderObservation(
      {
        ...input,
        metadata: {
          ...input.metadata,
          title: "  Cafe\u0301\n research 🧪 ",
          abstract: "do-not-log-this\u0000",
          publication_year: "2024 draft",
          authors: [
            author,
            null,
            {
              ...author,
              display_name: "Grace",
              orcid: "https://orcid.org/0000-0002-1825-0097",
              affiliations: [],
            },
          ],
          keywords: ["Chemistry\n synthesis", {}, "valid"],
        },
        reference_count: "12",
        cited_by_count: -1,
        reference_texts: [
          "Good\n citation",
          { title: "Do not recursively search" },
        ],
        asset_hints: [
          {
            url: "https://example.test/paper.pdf?token=do-not-log-this",
            kind: "direct-file",
            media_type: "application/pdf",
            asset_role: "primary-pdf",
            version_role: "published",
            access_status: "open",
            license: null,
          },
        ],
      },
      log,
    );
    expect(result.metadata).toMatchObject({
      title: "Café research 🧪",
      abstract: null,
      publication_year: null,
      keywords: ["Chemistry synthesis", "valid"],
      authors: [
        {
          display_name: "Ada Lovelace",
          orcid: null,
          affiliations: [{ name: "Valid institute", ror: null }],
        },
        { display_name: "Grace", orcid: "0000-0002-1825-0097" },
      ],
    });
    expect(result).toMatchObject({
      reference_count: 12,
      cited_by_count: null,
      reference_texts: ["Good citation"],
      asset_hints: [],
    });
    expect(log.warn).toHaveBeenCalledOnce();
    expect(log.warn.mock.calls[0]?.[1]).toMatchObject({
      provider: "fixture",
      code: "metadata-optional-field-discarded",
    });
    expect(JSON.stringify(log.warn.mock.calls)).toContain("metadata.abstract");
    expect(JSON.stringify(log.warn.mock.calls)).not.toMatch(
      /do-not-log-this|example\.test|invalid-orcid|10\.1000/u,
    );
    expect(input.metadata.title).toBe("Valid title");
    expect(parseMetadataObservation(result)).toEqual(result);
  });

  it("does not weaken the internal contract, identifiers or provenance", () => {
    const input = candidate();
    const invalidOptional = {
      ...input,
      metadata: { ...input.metadata, title: "bad\u0000" },
    };
    expect(() => parseMetadataObservation(invalidOptional)).toThrow();
    expect(
      parseProviderObservation(invalidOptional, diagnostics()).metadata.title,
    ).toBeNull();
    expect(() =>
      parseProviderObservation({
        ...input,
        metadata: {
          ...input.metadata,
          identifiers: [{ namespace: "doi", value: "not-a-doi" }],
        },
      }),
    ).toThrow();
    expect(() =>
      parseProviderObservation({
        ...input,
        provenance: { ...input.provenance, source_record_id: null },
      }),
    ).toThrow();
    expect(() =>
      parseProviderObservation({
        ...input,
        version_links: [
          {
            record_id: null,
            identifiers: [{ namespace: "doi", value: "not-a-doi" }],
          },
        ],
      }),
    ).toThrow();
  });

  it("propagates internal errors instead of treating them as field loss", () => {
    const bug = new Error("implementation failure");
    const metadata = {
      ...candidate().metadata,
      get title(): string {
        throw bug;
      },
    };
    expect(() =>
      parseProviderObservation({ ...candidate(), metadata }, diagnostics()),
    ).toThrow(bug);
  });
});
