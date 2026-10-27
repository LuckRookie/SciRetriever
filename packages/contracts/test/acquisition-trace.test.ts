import { expect, it } from "vitest";
import {
  parseAcquisitionAttempt,
  parseAcquisitionAttempts,
  parseAcquisitionRouteState,
  parseWorkbenchArticleSession,
} from "../src/index.js";
const attempt = {
  stage: "publisher-api",
  source: "wiley",
  started_at: "2026-10-26T00:00:00Z",
  finished_at: "2026-10-26T00:00:01Z",
  requested: true,
  result: "miss",
  candidates: 1,
};
it("accepts safe attempts and optional Browser history without changing old payloads", () => {
  expect(parseAcquisitionAttempt(attempt)).toEqual(attempt);
  const old = {
    session_id: "fixture",
    article_id: "article",
    generation: 0,
    phase: "ready",
  };
  expect(parseWorkbenchArticleSession(old)).toEqual(old);
  expect(
    parseWorkbenchArticleSession({ ...old, prior_attempts: [attempt] })
      .prior_attempts,
  ).toEqual([attempt]);
  expect(() =>
    parseWorkbenchArticleSession({
      ...old,
      prior_attempts: Array(17).fill(attempt),
    }),
  ).toThrow();
  expect(() => parseAcquisitionAttempts(Array(65).fill(attempt))).toThrow();
});
it.each([
  { url: "https://example.test/?token=synthetic" },
  { headers: {} },
  { source: "wiley\nsecret" },
  { code: "https://example.test" },
  { code: "x".repeat(97) },
  { started_at: "2026-02-30T00:00:00Z" },
  { finished_at: "2025-01-01T00:00:00Z" },
  { result: "unknown" },
  { requested: "true" },
  { result: "cooldown" },
  { result: "escalated" },
  { candidates: 1001 },
])("rejects unsafe or inconsistent trace field %j", (patch) =>
  expect(() => parseAcquisitionAttempt({ ...attempt, ...patch })).toThrow(),
);
it("keeps runtime absence explicit and rejects unordered effective routes", () => {
  const direct = {
    source: "direct",
    stage: "direct",
    mode_reason: "builtin",
    ready: true,
  };
  const api = {
    source: "wiley",
    stage: "publisher-api",
    mode_reason: "auto-configured",
    ready: true,
  };
  expect(
    parseAcquisitionRouteState({
      effective: null,
      pending: [direct, api],
      changed: null,
      restart_required: null,
    }).effective,
  ).toBeNull();
  expect(() =>
    parseAcquisitionRouteState({
      effective: [api, direct],
      pending: [],
      changed: true,
      restart_required: true,
    }),
  ).toThrow();
  expect(() =>
    parseAcquisitionRouteState({
      effective: null,
      pending: [],
      changed: false,
      restart_required: false,
    }),
  ).toThrow();
});
