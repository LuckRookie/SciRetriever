import { expect, it } from "vitest";
import {
  idleIndexRefreshStatus,
  parseIndexRefreshStatus,
  parseArchiveModelUsage,
} from "../src/index.js";

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
