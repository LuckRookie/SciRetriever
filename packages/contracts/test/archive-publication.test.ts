import { expect, it } from "vitest";
import {
  ARCHIVE_STEPS,
  archiveHash,
  archiveProofreadHash,
  parseArrangementQueryV2,
  parseArrangementEditRequest,
  parseArchiveIssueCount,
  parseArchiveUsageEstimateV2,
  parseArchiveTextBundleV2,
  parsePageProofreadRecord,
  parseProofreadVersionV2,
} from "../src/index.js";
const id = "00000000-0000-0000-0000-000000000001",
  hash = archiveHash("a".repeat(64));
it("accepts an exact nonnegative integer for the archive issue count", () => {
  expect(parseArchiveIssueCount({ total_count: 0 })).toEqual({
    total_count: 0,
  });
  expect(parseArchiveIssueCount({ total_count: 12 })).toEqual({
    total_count: 12,
  });
  for (const invalid of [
    {},
    { total_count: -1 },
    { total_count: 1.5 },
    { total_count: "1" },
    { total_count: 1, items: [] },
  ])
    expect(() => parseArchiveIssueCount(invalid)).toThrow();
});
it("bounds fixed-version arrangement queries and rejects old, unknown or overlarge requests", () => {
  const base = { schema_version: 2, asset_id: id, proofread_id: null };
  expect(parseArrangementQueryV2({ ...base, kind: "summary" })).toMatchObject(
    base,
  );
  const page = {
    ...base,
    kind: "pages",
    cursor: null,
    limit: 200,
    max_bytes: 65536,
  };
  expect(parseArrangementQueryV2(page)).toEqual(page);
  for (const change of [
    { schema_version: 1 },
    { limit: 201 },
    { max_bytes: 65537 },
    { kind: "document" },
    { cursor: "x".repeat(4097) },
    { extra: true },
  ])
    expect(() => parseArrangementQueryV2({ ...page, ...change })).toThrow();
  expect(() =>
    parseArrangementQueryV2({
      ...base,
      kind: "leaves",
      visibility: "deleted",
      drop_reason: null,
      page_index: null,
      cursor: null,
      limit: 1,
      max_bytes: 1024,
    }),
  ).toThrow();
});
it("requires all CAS identities and one explicit destination per manually changed leaf", () => {
  const request = {
    schema_version: 2,
    literature_id: id,
    asset_id: id,
    expected_proofread_id: id,
    expected_arrangement_id: hash,
    expected_manual_revision: 0,
    changes: [
      {
        kind: "restore",
        leaf_id: id,
        target: { role: "end-matter" },
        presentation: { kind: "content" },
      },
    ],
  };
  expect(parseArrangementEditRequest(request)).toEqual(request);
  for (const change of [
    { expected_manual_revision: -1 },
    { expected_arrangement_id: id },
    { actor: "body-actor" },
    { changes: [] },
    { changes: [...request.changes, ...request.changes] },
    { changes: [{ ...request.changes[0], target: { role: "front-matter" } }] },
  ])
    expect(() =>
      parseArrangementEditRequest({ ...request, ...change }),
    ).toThrow();
});
it("keeps unknown archive estimates nullable and validates ranges and the six-step vocabulary", () => {
  const request = {
    schema_version: 2,
    kind: "archive",
    available: false,
    no_hard_limit: true,
    count: 1,
    reused_count: 0,
    total_pdf_pages: 10,
    expected_proofread_pages: 10,
    page_basis: "all-pdf-pages",
    estimate_method: "matched-history-v1",
    components: ARCHIVE_STEPS.map((step) => ({
      step,
      unit: step === "proofread" ? "page" : "part",
      units: 1,
      sample_count: 0,
      basis: "unknown",
      calls: null,
      input_tokens: null,
      output_tokens: null,
      unknown_code: "no-matching-history",
    })),
    total: { calls: null, input_tokens: null, output_tokens: null },
  };
  expect(parseArchiveUsageEstimateV2(request).total.calls).toBeNull();
  expect(() =>
    parseArchiveUsageEstimateV2({ ...request, no_hard_limit: false }),
  ).toThrow();
  expect(() =>
    parseArchiveUsageEstimateV2({
      ...request,
      total: { ...request.total, calls: { median: 3, p90: 2 } },
    }),
  ).toThrow();
  expect(() =>
    parseArchiveUsageEstimateV2({
      ...request,
      components: request.components.map((c) => ({ ...c, step: "document" })),
    }),
  ).toThrow();
});
it("binds V2 version identity to accepted facts, preserves actual usage separately and rejects false completion", async () => {
  const usage = {
    calls: 0,
    compaction_calls: 0,
    input_tokens: 0,
    output_tokens: 0,
    usage_complete: true,
    elapsed_ms: 0,
  };
  const page = parsePageProofreadRecord(
    {
      schema_version: 2,
      page_index: 0,
      page_kind: "text-layer",
      page_input_sha256: hash,
      retained_leaf_ids: [],
      evidence: {
        read_leaf_ids: [],
        viewed_full_page: false,
        viewed_regions: [],
      },
      suspects: [],
      dispositions: [],
      corrections: [],
      usage,
      status: "pending",
      no_change: true,
      not_required_reason: null,
      classified_leaf_ids: [],
      stop: {
        code: "interrupted",
        step: "proofread",
        scope: "page",
        page_index: 0,
        retryable: true,
        cause_code: null,
        validation: null,
        progress: null,
      },
    },
    1,
  );
  const body = {
    schema_version: 2 as const,
    part_asset_id: id,
    part_sha256: hash,
    draft_input: {
      profile: "pipeline" as const,
      raw_parse_id: id,
      result_sha256: hash,
    },
    method: {
      arrange: "arrange-v1",
      page_classify: "pages-v1",
      suspects: "suspects-v1",
      correction: "correct-v1",
      model_config_sha256: null,
    },
    manual_decision_ids: [],
    status: "incomplete" as const,
    arrangement_id: null,
    blocks: { sha256: hash, byte_size: 2, media_type: "application/json" },
    pages: [page],
    resources: [],
    usage,
    stop: null,
  };
  const identity = async (
    value: typeof body | (Omit<typeof body, "status"> & { status: "complete" }),
  ) => {
    const digest = await archiveProofreadHash(value),
      proofread_id = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20, 32)}`;
    return { ...value, proofread_id, content_sha256: digest };
  };
  const value = await identity(body);
  expect((await parseProofreadVersionV2(value)).status).toBe("incomplete");
  expect(
    (
      await parseProofreadVersionV2({
        ...value,
        usage: { ...usage, calls: 2, input_tokens: 40 },
      })
    ).proofread_id,
  ).toBe(value.proofread_id);
  await expect(
    parseProofreadVersionV2({ ...value, part_sha256: "b".repeat(64) }),
  ).rejects.toThrow();
  await expect(
    parseProofreadVersionV2(await identity({ ...body, status: "complete" })),
  ).rejects.toThrow();
  const bundle = {
    schema_version: 2,
    page_count: 1,
    source_blocks: [],
    arrangement: null,
    leaves: [],
  };
  expect(parseArchiveTextBundleV2(bundle)).toEqual(bundle);
  expect(() =>
    parseArchiveTextBundleV2({ ...bundle, leaves: [{ leaf_id: id }] }),
  ).toThrow();
});
