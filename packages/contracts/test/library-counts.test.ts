import { expect, it } from "vitest";
import {
  parseFullTextCounts,
  parseLibraryCounts,
  parseLibraryExactCount,
  parseLibraryExactCountRequest,
  parseLibraryFacets,
  parseLibrarySearchTotal,
  parseLibrarySearchRequest,
} from "../src/index.js";

const counts = {
  total: 2,
  recently_opened: 0,
  unavailable_pdf: 1,
  with_primary_pdf: 0,
  full_text: { total: 1, obtained: 1, missing: 0, exhausted: 0 },
  statuses: {
    UNREVIEWED: 2,
    ASSET_READY: 0,
    ARCHIVING: 0,
    ARCHIVE_FAILED: 0,
    READY: 0,
    EXCLUDED: 0,
  },
};
it("parses exact version counts and paper counts without equating their units", () => {
  // The matching preprint can lack PDF while its sibling outside the scope has one.
  expect(parseLibraryCounts(counts)).toEqual(counts);
  for (const bad of [
    { ...counts, extra: 0 },
    { ...counts, with_primary_pdf: -1 },
    { ...counts, with_primary_pdf: 0.5 },
    { ...counts, with_primary_pdf: 3 },
    {
      ...counts,
      full_text: { total: 3, obtained: 3, missing: 0, exhausted: 0 },
    },
    { ...counts, full_text: { ...counts.full_text, total: 2 } },
    { ...counts, full_text: { ...counts.full_text, exhausted: 1 } },
    { ...counts, full_text: { ...counts.full_text, unknown: 1 } },
    { ...counts, recently_opened: 3 },
    { ...counts, unavailable_pdf: 3 },
    { ...counts, statuses: { ...counts.statuses, READY: 1 } },
  ])
    expect(() => parseLibraryCounts(bad)).toThrow();
  const { full_text, ...missingFullText } = counts;
  const { with_primary_pdf, ...missingPrimary } = counts;
  void full_text;
  void with_primary_pdf;
  expect(() => parseLibraryCounts(missingFullText)).toThrow();
  expect(() => parseLibraryCounts(missingPrimary)).toThrow();
});
it("checks FullTextCounts relations, exact keys and bounded integers", () => {
  expect(
    parseFullTextCounts({ total: 0, obtained: 0, missing: 0, exhausted: 0 }),
  ).toEqual({ total: 0, obtained: 0, missing: 0, exhausted: 0 });
  for (const bad of [
    { total: 1, obtained: 0, missing: 0, exhausted: 0 },
    { total: 1, obtained: 1, missing: 0, exhausted: 1 },
    { total: 1, obtained: -1, missing: 2, exhausted: 0 },
    {
      total: Number.MAX_SAFE_INTEGER + 1,
      obtained: 0,
      missing: 0,
      exhausted: 0,
    },
  ])
    expect(() => parseFullTextCounts(bad)).toThrow();
});
it("validates the truncation boundary, facet coverage, collection totals and exact snapshots", () => {
  for (const total_count of [9999, 10_000, 10_001]) {
    expect(parseLibrarySearchTotal({ total_count })).toEqual({ total_count });
    const truncated = { total_count, count_truncated: true };
    if (total_count === 10_000)
      expect(parseLibrarySearchTotal(truncated)).toEqual(truncated);
    else expect(() => parseLibrarySearchTotal(truncated)).toThrow();
  }
  const collection_counts = { collected: 1, discovered_only: 1 };
  expect(
    parseLibraryCounts({ ...counts, collection_counts }).collection_counts,
  ).toEqual(collection_counts);
  expect(() =>
    parseLibraryCounts({
      ...counts,
      collection_counts: { collected: 2, discovered_only: 1 },
    }),
  ).toThrow();
  const facets = {
    total: 10_001,
    coverage: { tags: 0, keywords: 10_000, subject_terms: 0 },
    tags: [],
    keywords: [],
    subject_terms: [],
  };
  expect(
    parseLibraryFacets({ ...facets, facets_truncated: true }).facets_truncated,
  ).toBe(true);
  expect(() =>
    parseLibraryFacets({
      ...facets,
      facets_truncated: true,
      coverage: { ...facets.coverage, keywords: 10_001 },
    }),
  ).toThrow();
  const snapshot_at = "2026-11-22T08:00:00.000Z";
  expect(
    parseLibraryExactCount({ snapshot_at, kind: "counts", counts }),
  ).toEqual({ snapshot_at, kind: "counts", counts });
  expect(() =>
    parseLibraryExactCount({
      snapshot_at,
      kind: "facets",
      facets: { ...facets, facets_truncated: true },
    }),
  ).toThrow();
  expect(() =>
    parseLibraryExactCount({ snapshot_at: "never", kind: "counts", counts }),
  ).toThrow();
  expect(() =>
    parseLibraryExactCountRequest({ kind: "counts", query: {}, limit: 1 }),
  ).toThrow();
  expect(() =>
    parseLibraryExactCountRequest({ kind: "facets", query: {} }),
  ).toThrow();
});
it("accepts true, false and null primary-PDF filters while preserving omitted query bytes", () => {
  const legacy =
    '{"text":null,"title":"Legacy","author":null,"author_orcids":[],"identifiers":[],"publication_year_from":null,"publication_year_to":null,"venue":null,"publisher":null,"publication_forms":[],"article_kinds":[],"languages":[],"intake_batch_ids":[],"subject_terms":[],"keywords":[],"version_roles":[],"statuses":[],"missing_steps":[],"needs_manual_pdf":null,"discovery_run_ids":[]}';
  const read = (query: Record<string, unknown>) =>
    parseLibrarySearchRequest({ query }).query;
  expect(JSON.stringify(read({ title: "Legacy" }))).toBe(legacy);
  expect(Object.hasOwn(read({ title: "Legacy" }), "has_primary_pdf")).toBe(
    false,
  );
  expect(JSON.stringify(read({ title: "Legacy", has_primary_pdf: null }))).toBe(
    legacy,
  );
  for (const value of [true, false])
    expect(read({ has_primary_pdf: value }).has_primary_pdf).toBe(value);
  for (const value of ["true", 0, 1, [], {}])
    expect(() => read({ has_primary_pdf: value })).toThrow();
});
