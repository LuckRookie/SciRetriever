import { expect, it } from "vitest";
import {
  parseSourceSaveRequest,
  parseSourceSelectionSaveRequest,
  parseSourceTestResult,
  parseConfigurationApplyState,
} from "../src/index.js";
const request = {
  source: "wiley",
  baseline: "a".repeat(64),
  parameters: { action: "keep" },
  credentials: [{ field: "tdm_api_token", action: "clear" }],
  test_after_save: true,
};
it("parses closed source edits and exact selections", () => {
  expect(parseSourceSaveRequest(request)).toEqual(request);
  for (const edit of [
    { ...request, secret: "forbidden" },
    {
      ...request,
      credentials: [{ field: "tdm_api_token", action: "replace", value: "" }],
    },
    {
      ...request,
      credentials: [...request.credentials, ...request.credentials],
    },
    {
      ...request,
      parameters: {
        action: "set",
        value: { api_key: "not-an-ordinary-field" },
      },
    },
  ])
    expect(() => parseSourceSaveRequest(edit)).toThrow();
  expect(
    parseSourceSelectionSaveRequest({
      baseline: "a",
      domain: "pdf",
      selection: { mode: "custom", providers: [] },
    }).selection.providers,
  ).toEqual([]);
  expect(() =>
    parseSourceSelectionSaveRequest({
      baseline: "a",
      domain: "pdf",
      selection: { mode: "auto", providers: ["arxiv"] },
    }),
  ).toThrow();
});
it("rejects forged PDF validation, sensitive extras and inconsistent apply states", () => {
  const result = {
    test_id: "t",
    source: "arxiv",
    source_revision: "r",
    method_version: "v1",
    started_at: "2026-10-28T00:00:00.000Z",
    finished_at: "2026-10-28T00:00:01.000Z",
    elapsed_ms: 1000,
    status: "available",
    checks: [
      {
        purpose: "pdf",
        result: "ok",
        requested: true,
        pdf_validated: true,
        authentication: "not-required",
        fixture_entitlement: "granted",
        technical_details: { diagnostics: [] },
      },
    ],
    requests_started: 1,
    received_bytes: 1234,
    browser_launched: false,
    library_written: false,
    assets_published: false,
    technical_details: { diagnostics: [] },
  };
  expect(parseSourceTestResult(result)).toEqual(result);
  expect(() =>
    parseSourceTestResult({
      ...result,
      headers: { authorization: "forbidden" },
    }),
  ).toThrow();
  expect(() =>
    parseSourceTestResult({
      ...result,
      checks: [{ ...result.checks[0], requested: false }],
    }),
  ).toThrow();
  expect(() =>
    parseSourceTestResult({
      ...result,
      technical_details: {
        diagnostics: [
          { code: "https://not-a-code.test/?secret=x", scope: "test" },
        ],
      },
    }),
  ).toThrow();
  const state = {
    managed: false,
    runtime_id: null,
    generation: null,
    state: "unmanaged",
    request_id: null,
    target_binding_revision: null,
    current_binding_revision: null,
    can_cancel: false,
    blockers: {
      queued: 0,
      running: 0,
      foreground: 0,
      probes: 0,
      browser_transfers: 0,
    },
    updated_at: result.finished_at,
    problem: null,
  };
  expect(parseConfigurationApplyState(state).state).toBe("unmanaged");
  expect(() =>
    parseConfigurationApplyState({ ...state, can_cancel: true }),
  ).toThrow();
  expect(() =>
    parseConfigurationApplyState({ ...state, state: "applied" }),
  ).toThrow();
});
