import { expect, it } from "vitest";
import {
  DRAFT_FAILURE_CODES,
  parseFormDraftsCounts,
  parseFormDraftsPartResult,
  parseFormDraftsPreviewRequest,
  parseFormDraftsRequest,
  parseIntakeTaskScope,
} from "../src/index.js";

const id = "00000000-0000-0000-0000-000000000001";
const selector = { kind: "literatures", literature_ids: [id] };
const counts = {
  matched: 8,
  process: 3,
  process_parts: 5,
  skipped_has_draft: 2,
  skipped_no_raw_parse: 1,
  over_limit: 2,
};
it("defaults the explicit older-method flag off and accepts the same selectors for preview and submission", () => {
  expect(parseFormDraftsPreviewRequest({ selector })).toEqual({
    selector,
    include_older_method: false,
  });
  expect(
    parseFormDraftsRequest({
      selector,
      include_older_method: true,
      idempotency_key: "drafts:fixture-1",
    }),
  ).toEqual({
    selector,
    include_older_method: true,
    idempotency_key: "drafts:fixture-1",
  });
  expect(
    parseFormDraftsPreviewRequest({
      selector: { kind: "query", query: {}, sort: "title-asc", limit: 2 },
    }),
  ).toMatchObject({ selector: { sort: "title-asc", limit: 2 } });
  for (const include_older_method of [null, "true", 1])
    expect(() =>
      parseFormDraftsPreviewRequest({ selector, include_older_method }),
    ).toThrow();
  for (const input of [
    { selector, idempotency_key: "" },
    { selector, idempotency_key: "x", force: true },
    { selector: { kind: "all-pending" }, idempotency_key: "x" },
    {
      selector: { kind: "literatures", literature_ids: Array(10_001).fill(id) },
      idempotency_key: "x",
    },
  ])
    expect(() => parseFormDraftsRequest(input)).toThrow();
});
it("keeps draft counts disjoint and carries them through the existing saved task scope parser", () => {
  expect(parseFormDraftsCounts(counts)).toEqual(counts);
  expect(parseIntakeTaskScope({ selector, counts })).toEqual({
    selector,
    counts,
  });
  for (const changed of [
    { ...counts, matched: 9 },
    { ...counts, process_parts: 2 },
    { ...counts, skipped_no_raw_parse: -1 },
    { ...counts, process: 1.5 },
    { ...counts, skipped_has_pdf: 1 },
    { ...counts, process_parts: Number.MAX_SAFE_INTEGER + 1 },
    { ...counts, process: 0, matched: 5 },
  ])
    expect(() => parseFormDraftsCounts(changed)).toThrow();
});
it("validates each part result without accepting unsupported failure or mixed success fields", () => {
  const accepted = {
    asset_id: id,
    part: "main",
    status: "formed",
    document_version_id: id,
    failure_code: null,
    default_changed: true,
  };
  expect(parseFormDraftsPartResult(accepted)).toEqual(accepted);
  expect(
    parseFormDraftsPartResult({ ...accepted, status: "reused" }),
  ).toMatchObject({ status: "reused" });
  const skipped = {
    ...accepted,
    status: "skipped",
    document_version_id: null,
    default_changed: false,
  };
  expect(parseFormDraftsPartResult(skipped)).toEqual(skipped);
  for (const failure_code of DRAFT_FAILURE_CODES)
    expect(
      parseFormDraftsPartResult({ ...skipped, status: "failed", failure_code }),
    ).toMatchObject({ status: "failed", failure_code });
  for (const input of [
    { ...accepted, document_version_id: null },
    { ...accepted, failure_code: "needs-parse" },
    { ...accepted, status: { toString: () => "formed" } },
    { ...skipped, status: "failed" },
    { ...skipped, status: "failed", failure_code: "input-missing" },
    { ...skipped, default_changed: true },
    { ...skipped, part: "other" },
    { ...skipped, extra: true },
  ])
    expect(() => parseFormDraftsPartResult(input)).toThrow();
});
