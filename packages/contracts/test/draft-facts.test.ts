import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import {
  canonicalJsonBytes,
  ContractValidationError,
  DRAFT_FACT_SORTS,
  parseAcquirePdfSelector,
  parseAsset,
  parseDraftFacts,
  parseFormDraftsPreviewRequest,
  parseLibrarySearchRequest,
  parseLiteratureAssetView,
  parseLiteratureDefaultText,
  parseLiteratureSearchItem,
} from "../src/index.js";

const id = "00000000-0000-0000-0000-000000000001";
const query = (value: unknown) =>
  parseLibrarySearchRequest({ query: value }).query;
const facts = {
  differs_segments: 1,
  differences: 2,
  image_only_pages: 3,
  citing_results: 4,
  unfound_citations: 5,
};

it("parses a closed set of nonnegative integer facts and a coherent fixed default", () => {
  expect(parseDraftFacts(facts)).toEqual(facts);
  for (const key of Object.keys(facts)) {
    for (const value of [
      -1,
      0.1,
      Infinity,
      NaN,
      Number.MAX_SAFE_INTEGER + 1,
      "1",
      null,
      undefined,
    ])
      expect(() => parseDraftFacts({ ...facts, [key]: value })).toThrow(
        ContractValidationError,
      );
    expect(() =>
      parseDraftFacts(
        Object.fromEntries(Object.entries(facts).filter(([k]) => k !== key)),
      ),
    ).toThrow();
  }
  expect(() => parseDraftFacts({ ...facts, extra: 0 })).toThrow();
  for (const [text_level, draft_facts] of [
    ["draft", facts],
    ["proofread", null],
  ] as const) {
    const value = { document_version_id: id, text_level, draft_facts };
    expect(parseLiteratureDefaultText(value)).toEqual(value);
  }
  for (const value of [
    { document_version_id: id, text_level: "draft", draft_facts: null },
    { document_version_id: id, text_level: "proofread", draft_facts: facts },
    {
      document_version_id: "not-a-version",
      text_level: "draft",
      draft_facts: facts,
    },
    { document_version_id: id, text_level: "raw", draft_facts: facts },
  ])
    expect(() => parseLiteratureDefaultText(value)).toThrow();
});

it("normalizes only supplied fact filters and accepts the new ordering in every query selector", () => {
  const empty = canonicalJsonBytes(query({}));
  expect(
    canonicalJsonBytes(
      query({
        text_levels: [],
        has_draft_differences: null,
        has_image_only_pages: null,
        cited_by_results: null,
        has_unfound_citations: null,
      }),
    ),
  ).toEqual(empty);
  const input = {
    text_levels: ["proofread", "draft", "draft"],
    has_draft_differences: true,
    has_image_only_pages: false,
    cited_by_results: true,
    has_unfound_citations: false,
  };
  expect(query(input)).toMatchObject({
    ...input,
    text_levels: ["draft", "proofread"],
  });
  for (const sort of DRAFT_FACT_SORTS) {
    const selector = { kind: "query", query: input, sort, limit: 50 };
    expect(parseLibrarySearchRequest({ query: input, sort })).toMatchObject({
      sort,
    });
    expect(parseAcquirePdfSelector(selector)).toMatchObject({ sort });
    expect(parseFormDraftsPreviewRequest({ selector })).toMatchObject({
      selector: { sort },
    });
  }
  for (const text_levels of [null, "draft", ["raw"], [null]])
    expect(() => query({ text_levels })).toThrow();
  for (const key of [
    "has_draft_differences",
    "has_image_only_pages",
    "cited_by_results",
    "has_unfound_citations",
  ])
    for (const value of ["true", 1, [], {}])
      expect(() => query({ [key]: value })).toThrow();
  expect(() => query({ draft_facts: facts })).toThrow();
});

it("keeps PDF defaults optional and forbids them on non-PDF assets", () => {
  const fixture = JSON.parse(
    readFileSync(
      new URL(
        "../../../tests/fixtures/compat-v1/records.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as Record<string, unknown>;
  const asset = parseAsset(fixture.asset),
    view = {
      asset,
      literature_asset: {
        literature_asset_id: id,
        literature_id: id,
        asset_id: asset.asset_id,
        role: "primary-pdf",
        provenance: fixture.provenance,
        source_url: null,
      },
    };
  expect(parseLiteratureAssetView(view)).not.toHaveProperty("default_text");
  for (const default_text of [
    null,
    { document_version_id: id, text_level: "draft", draft_facts: facts },
    { document_version_id: id, text_level: "proofread", draft_facts: null },
  ])
    expect(
      parseLiteratureAssetView({ ...view, default_text }).default_text,
    ).toEqual(default_text);
  expect(() =>
    parseLiteratureAssetView({
      ...view,
      asset: { ...asset, media_type: "text/html" },
      literature_asset: { ...view.literature_asset, role: "html" },
      default_text: null,
    }),
  ).toThrow();
});

it("keeps list facts optional while rejecting contradictory grades and counts", () => {
  const fixture = JSON.parse(
    readFileSync(
      new URL(
        "../../../tests/fixtures/compat-v1/records.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as Record<string, unknown>;
  const { document_type: legacy, ...metadata } = fixture.metadata as Record<
    string,
    unknown
  >;
  void legacy;
  const item = {
    literature: {
      literature_id: id,
      meta_literature_id: id,
      version_role: "published",
      metadata: {
        ...metadata,
        publication_form: "journal-article",
        article_kind: null,
      },
      status: "UNREVIEWED",
    },
    metadata_revision: 1,
    metadata_sha256: "a".repeat(64),
    missing_step: "primary-pdf",
    needs_manual_pdf: false,
  };
  expect(parseLiteratureSearchItem(item)).not.toHaveProperty("draft_facts");
  expect(
    parseLiteratureSearchItem({
      ...item,
      text_level: "draft",
      draft_facts: facts,
    }).draft_facts,
  ).toEqual(facts);
  for (const text_level of ["proofread", null]) {
    expect(
      parseLiteratureSearchItem({ ...item, text_level, draft_facts: null })
        .draft_facts,
    ).toBeNull();
    expect(() =>
      parseLiteratureSearchItem({ ...item, text_level, draft_facts: facts }),
    ).toThrow();
  }
  expect(() =>
    parseLiteratureSearchItem({
      ...item,
      text_level: "draft",
      draft_facts: null,
    }),
  ).toThrow();
});
