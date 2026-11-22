import { expect, it } from "vitest";
import {
  EMPTY_METADATA,
  INTAKE_HTTP_ENDPOINTS,
  parseAcquirePdfCounts,
  parseAcquirePdfScope,
  parseAcquirePdfSelector,
  parseIntakeBatch,
  parseIntakeBatchId,
  parseIntakeBatchPage,
  parseIntakeBatchQuery,
  parseIntakeBatchRename,
  parseIntakeTaskScope,
  parseFullTextCounts,
  parseLibraryFacets,
  parseLibraryFacetsRequest,
  parseLibraryQuery,
  parseLibrarySearchRequest,
  parseLiteratureMetadata,
  type LibrarySort,
} from "../src/index.js";
const id = "00000000-0000-0000-0000-000000000001";
it("describes the intake folder response with its items wrapper and tree fields", () => {
  expect(
    INTAKE_HTTP_ENDPOINTS.find(
      (route) => route[1] === "/api/v1/intake/folders",
    ),
  ).toEqual([
    "POST",
    "/api/v1/intake/folders",
    "folders",
    "{}",
    "{items:[{folder_id,parent_id,name,position}]}",
  ]);
});
const batch = {
  batch_id: id,
  kind: "topic",
  label: "search",
  default_label: "search",
  renamed: false,
  origin: "web",
  created_at: "2026-11-01T00:00:00.000Z",
  finished_at: null,
  state: "running",
  result: null,
  confirmation: null,
  confirmed_at: null,
  initiated_by: "local:web",
  source: null,
  progress: null,
  request: {
    query: "search",
    year_from: null,
    year_to: null,
    providers: ["crossref"],
  },
  counts: {
    hits: 3,
    created: 1,
    enriched: 1,
    matched: 1,
    rejected: 0,
    restored: 0,
    conflicts: 0,
    possible_duplicates: 0,
    pending_decision: 0,
    needs_metadata: 0,
  },
  pdf: { has_pdf: 1, unavailable: 1, pending: 1 },
  full_text: { total: 3, obtained: 1, missing: 2, exhausted: 1 },
  estimates: { acquire_pdf: 1, parse: 1 },
  discovery_run_id: null,
  source_failures: 0,
};
it("validates paper-level full-text counts and disjoint parse task scopes", () => {
  expect(parseFullTextCounts(batch.full_text)).toEqual(batch.full_text);
  const scope = {
    selector: { kind: "query", query: {}, sort: "title-asc", limit: null },
    counts: {
      matched: 4,
      process: 1,
      skipped_no_pdf: 2,
      skipped_parsed: 1,
      over_limit: 0,
    },
  };
  expect(parseIntakeTaskScope(scope)).toMatchObject({ counts: scope.counts });
  for (const counts of [
    { ...scope.counts, process: 2 },
    { ...scope.counts, skipped_no_pdf: -1 },
    { ...scope.counts, skipped_has_pdf: 0 },
  ])
    expect(() => parseIntakeTaskScope({ ...scope, counts })).toThrow();
  for (const counts of [
    { total: 3, obtained: 2, missing: 2, exhausted: 0 },
    { total: 3, obtained: 2, missing: 1, exhausted: 2 },
    { ...batch.full_text, total: -1 },
    { ...batch.full_text, obtained: 1.5 },
    { ...batch.full_text, extra: 0 },
  ])
    expect(() => parseFullTextCounts(counts)).toThrow();
});
it("round-trips the optional persisted metadata-only flag without accepting it on discovery batches", () => {
  const imported = {
    ...batch,
    kind: "import",
    confirmation: "batch",
    request: { format: "bibtex", metadata_only: true },
  };
  expect(parseIntakeBatch(imported).request.metadata_only).toBe(true);
  expect(
    parseIntakeBatch({ ...imported, request: { format: "bibtex" } }).request
      .metadata_only,
  ).toBeUndefined();
  for (const metadata_only of [1, "true", null])
    expect(() =>
      parseIntakeBatch({
        ...imported,
        request: { format: "bibtex", metadata_only },
      }),
    ).toThrow();
  expect(() =>
    parseIntakeBatch({
      ...batch,
      request: { ...batch.request, metadata_only: true },
    }),
  ).toThrow();
});
it("validates batch counters including the legacy exception and closed kind-specific inputs", () => {
  expect(parseIntakeBatch(batch)).toEqual(batch);
  const query = "energy\nAND storage";
  expect(
    parseIntakeBatch({
      ...batch,
      label: query,
      default_label: query,
      request: { ...batch.request, query },
    }).request.query,
  ).toBe(query);
  expect(parseIntakeBatchId(id)).toBe(id);
  expect(
    parseIntakeBatchPage({ items: [batch], next_cursor: null }).items,
  ).toHaveLength(1);
  expect(
    parseIntakeBatch({
      ...batch,
      kind: "legacy",
      origin: "migration",
      request: {},
      counts: { ...batch.counts, created: 0, enriched: 0, matched: 0 },
    }).counts.hits,
  ).toBe(3);
  for (const v of [
    { ...batch, counts: { ...batch.counts, hits: 4 } },
    { ...batch, pdf: { ...batch.pdf, pending: 0 } },
    { ...batch, full_text: { ...batch.full_text, total: 4 } },
    { ...batch, full_text: { ...batch.full_text, exhausted: 3 } },
    { ...batch, estimates: { acquire_pdf: -1, parse: 0 } },
    { ...batch, origin: "guessed" },
    { ...batch, request: { format: "ris" } },
    { ...batch, counts: { ...batch.counts, rejected: 1 } },
    { ...batch, extra: true },
    { ...batch, request: { year_from: 2027, year_to: 2026 } },
  ])
    expect(() => parseIntakeBatch(v)).toThrow();
});
it("bounds list, rename and facets requests without accepting unknown fields", () => {
  expect(parseIntakeBatchQuery({ operation: "list", request: {} })).toEqual({
    operation: "list",
    request: { limit: 50, cursor: null },
  });
  expect(
    parseIntakeBatchQuery({ operation: "get", request: { batch_id: id } })
      .operation,
  ).toBe("get");
  expect(
    parseIntakeBatchRename({ batch_id: id, label: "  new name  " }).label,
  ).toBe("new name");
  expect(
    parseIntakeBatchRename({ batch_id: id, label: null }).label,
  ).toBeNull();
  for (const label of ["  ", "x".repeat(121), "bad\nname"])
    expect(() => parseIntakeBatchRename({ batch_id: id, label })).toThrow();
  expect(() =>
    parseIntakeBatchQuery({ operation: "list", request: { limit: 101 } }),
  ).toThrow();
  expect(() => parseLibraryFacetsRequest({ query: {}, limit: 31 })).toThrow();
  expect(
    parseLibraryFacets({
      total: 3,
      coverage: { tags: 0, keywords: 2, subject_terms: 0 },
      tags: [],
      keywords: [{ value: "Energy", count: 2, tag: null }],
      subject_terms: [],
    }).keywords[0]?.count,
  ).toBe(2);
  expect(() =>
    parseLibraryFacets({
      total: 1,
      coverage: { tags: 0, keywords: 1, subject_terms: 0 },
      tags: [],
      keywords: [{ value: "a", count: 2, tag: null }],
      subject_terms: [],
    }),
  ).toThrow();
});
it("requires all three facet layers, bounded coverage and closed nullable keyword tag links", () => {
  const facets = {
    total: 4,
    coverage: { tags: 2, keywords: 3, subject_terms: 4 },
    tags: [{ tag_id: id, value: "Energy", count: 2 }],
    keywords: [
      { value: "Batteries", count: 3, tag: { tag_id: id, name: "Energy" } },
    ],
    subject_terms: [{ value: "Physics", count: 4 }],
  };
  expect(parseLibraryFacets(facets)).toEqual(facets);
  for (const invalid of [
    { total: 4, keywords: [], subject_terms: [] },
    { ...facets, coverage: { ...facets.coverage, tags: 5 } },
    { ...facets, coverage: { ...facets.coverage, tags: -1 } },
    { ...facets, coverage: { ...facets.coverage, keywords: 0.5 } },
    { ...facets, coverage: { ...facets.coverage, subject_terms: Infinity } },
    { ...facets, coverage: { ...facets.coverage, extra: 0 } },
    { ...facets, tags: [{ tag_id: "invalid", value: "Energy", count: 2 }] },
    { ...facets, tags: [{ tag_id: id, value: "Energy", count: 3 }] },
    { ...facets, tags: Array.from({ length: 31 }, () => facets.tags[0]) },
    { ...facets, keywords: [{ value: "a", count: 1 }] },
    { ...facets, keywords: [{ value: "a", count: 1, tag: { tag_id: id } }] },
    {
      ...facets,
      keywords: [
        { value: "a", count: 1, tag: { tag_id: id, name: "", extra: true } },
      ],
    },
    { ...facets, subject_terms: [{ value: "Physics", count: 0 }] },
  ])
    expect(() => parseLibraryFacets(invalid)).toThrow();
});
it("decodes historic metadata and queries with empty new fields and preserves new selectors", () => {
  const old: Record<string, unknown> = { ...EMPTY_METADATA };
  delete old.subject_terms;
  expect(parseLiteratureMetadata(old).subject_terms).toEqual([]);
  expect(
    parseLiteratureMetadata({ ...old, subject_terms: ["Physics"] })
      .subject_terms,
  ).toEqual(["Physics"]);
  const query = parseLibrarySearchRequest({
    query: { intake_batch_ids: [id], subject_terms: ["physics"] },
  }).query;
  expect(parseLibraryQuery(query)).toEqual(query);
  const selector = { kind: "query", query, sort: "title-desc", limit: 2 };
  expect(parseAcquirePdfSelector(selector)).toEqual(selector);
  expect(
    parseAcquirePdfSelector({ kind: "literatures", literature_ids: [id, id] }),
  ).toEqual({ kind: "literatures", literature_ids: [id] });
  const counts = {
    matched: 10,
    process: 2,
    skipped_has_pdf: 2,
    skipped_unavailable: 1,
    over_limit: 5,
  };
  expect(parseAcquirePdfScope({ selector, counts })).toEqual({
    selector,
    counts,
  });
  expect(() => parseAcquirePdfCounts({ ...counts, matched: 11 })).toThrow();
  for (const v of [
    { ...selector, limit: 0 },
    { ...selector, sort: "random" },
    { ...selector, unknown: true },
    { kind: "literatures", literature_ids: [] },
  ])
    expect(() => parseAcquirePdfSelector(v)).toThrow();
});

it("shares the collected sort between search and persisted PDF selectors", () => {
  const sort: LibrarySort = "collected-desc";
  const query = { collection_scope: "collected" };
  const search = parseLibrarySearchRequest({ query, sort });
  expect(search.sort).toBe(sort);
  const selector = { kind: "query", query: search.query, sort, limit: 4 };
  expect(parseAcquirePdfSelector(selector)).toEqual(selector);
  const counts = {
    matched: 10,
    process: 4,
    skipped_has_pdf: 1,
    skipped_unavailable: 2,
    over_limit: 3,
  };
  expect(parseAcquirePdfScope({ selector, counts })).toEqual({
    selector,
    counts,
  });
  expect(() =>
    parseAcquirePdfSelector({ ...selector, cursor: "synthetic" }),
  ).toThrow();
});

it("binds the six batch states to nullable results and rejects the retired status field", () => {
  for (const state of [
    "collecting",
    "awaiting-confirmation",
    "running",
    "cancelled",
  ])
    expect(
      parseIntakeBatch({
        ...batch,
        kind: "import",
        request: { format: "records", file_name: null },
        state,
        result: null,
        confirmation: "batch",
      }).state,
    ).toBe(state);
  for (const result of ["completed", "partial", "failed", "interrupted"])
    expect(
      parseIntakeBatch({ ...batch, state: "finished", result }).result,
    ).toBe(result);
  expect(
    parseIntakeBatch({ ...batch, state: "withdrawn", result: null }).state,
  ).toBe("withdrawn");
  for (const patch of [
    { state: "importing" },
    { state: "completed" },
    { state: "finished", result: null },
    { state: "running", result: "completed" },
    { status: "running" },
    { initiated_by: "invented" },
  ])
    expect(() => parseIntakeBatch({ ...batch, ...patch })).toThrow();
});
