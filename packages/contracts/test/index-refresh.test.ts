import { expect, it } from "vitest";
import {
  idleIndexRefreshStatus,
  parseIndexRefreshStatus,
  parseArchiveModelUsage,
  parseIndexVerificationResult,
} from "../src/index.js";

it("accepts optional incremental queue metrics and rejects invalid counters or verification receipts", () => {
  expect(
    parseIndexRefreshStatus({
      ...idleIndexRefreshStatus(),
      pending_literatures: 2,
      last_refresh_ms: 3,
    }),
  ).toMatchObject({ pending_literatures: 2, last_refresh_ms: 3 });
  for (const extra of [
    { pending_literatures: -1 },
    { pending_literatures: 1.1 },
    { last_refresh_ms: "3" },
  ])
    expect(() =>
      parseIndexRefreshStatus({ ...idleIndexRefreshStatus(), ...extra }),
    ).toThrow();
  const receipt = {
    schema_version: 1,
    status: "verified",
    elapsed_ms: 3,
    generation_id: "00000000-0000-0000-0000-000000000101",
    source_revision: 3,
    entry_count: 4,
    source_count: 1,
  };
  expect(parseIndexVerificationResult(receipt)).toEqual(receipt);
  for (const extra of [
    { status: "updated" },
    { elapsed_ms: -1 },
    { secret: "synthetic" },
    { entry_count: -1 },
  ])
    expect(() =>
      parseIndexVerificationResult({ ...receipt, ...extra }),
    ).toThrow();
});

it("round-trips refresh status and rejects unknown fields, raw errors and invalid revisions", () => {
  const value = {
    ...idleIndexRefreshStatus(),
    status: "failed",
    requested_revision: 2,
    indexed_revision: 1,
    requested_at: "2026-10-28T00:00:00.000Z",
    technical_details: { code: "index-source-invalid" },
  };
  expect(parseIndexRefreshStatus(value)).toEqual(value);
  for (const bad of [
    { ...value, secret: "synthetic" },
    { ...value, status: "error" },
    { ...value, requested_revision: -1 },
    { ...value, technical_details: { code: "raw error text" } },
    {
      ...value,
      technical_details: { code: "index-failed", message: "synthetic" },
    },
    { ...value, finished_at: "not-a-date" },
  ])
    expect(() => parseIndexRefreshStatus(bad)).toThrow();
});
it("keeps historical usage readable and validates rate-limit retry diagnostics", () => {
  const usage = {
    calls: 3,
    compaction_calls: 0,
    input_tokens: null,
    output_tokens: null,
    usage_complete: false,
    elapsed_ms: 5,
  };
  expect(parseArchiveModelUsage(usage)).toEqual(usage);
  const retry = {
    page_index: 2,
    retry_after_ms: 15,
    wait_ms: 16,
    concurrency_before: 3,
    concurrency_after: 2,
  };
  expect(
    parseArchiveModelUsage({ ...usage, rate_limits: [retry] }),
  ).toMatchObject({ rate_limits: [retry] });
  for (const bad of [
    { ...retry, concurrency_after: 4 },
    { ...retry, concurrency_before: 0 },
    { ...retry, retry_after_ms: -1 },
    { ...retry, message: "synthetic" },
  ])
    expect(() =>
      parseArchiveModelUsage({ ...usage, rate_limits: [bad] }),
    ).toThrow();
});
