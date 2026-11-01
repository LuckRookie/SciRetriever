import { expect, it } from "vitest";
import {
  EMPTY_METADATA,
  parseAcquirePdfCounts,
  parseAcquirePdfScope,
  parseAcquirePdfSelector,
  parseIntakeBatch,
  parseIntakeBatchId,
  parseIntakeBatchPage,
  parseIntakeBatchQuery,
  parseIntakeBatchRename,
  parseLibraryFacets,
  parseLibraryFacetsRequest,
  parseLibraryQuery,
  parseLibrarySearchRequest,
  parseLiteratureMetadata,
} from "../src/index.js";
const id = "00000000-0000-0000-0000-000000000001";
const batch = {
  batch_id: id,
  kind: "topic",
  label: "search",
  default_label: "search",
  renamed: false,
  origin: "web",
  created_at: "2026-11-01T00:00:00.000Z",
  finished_at: null,
  status: "running",
  request: {
    query: "search",
    year_from: null,
    year_to: null,
    providers: ["crossref"],
  },
  counts: { hits: 3, created: 1, enriched: 1, matched: 1, rejected: 0 },
  pdf: { has_pdf: 1, unavailable: 1, pending: 1 },
  discovery_run_id: null,
  source_failures: 0,
};
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
      keywords: [{ value: "Energy", count: 2 }],
      subject_terms: [],
    }).keywords[0]?.count,
  ).toBe(2);
  expect(() =>
    parseLibraryFacets({
      total: 1,
      keywords: [{ value: "a", count: 2 }],
      subject_terms: [],
    }),
  ).toThrow();
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
