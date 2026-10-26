import { expect, it } from "vitest";
import {
  parseWorkbenchActionRecord,
  parseWorkbenchArticleSession,
  parseWorkbenchView,
} from "../src/index.js";
const legacy = {
  session_id: "s",
  article_id: "a",
  state: "watching",
  control: { workspace_id: "s", viewers: 1, controller_id: null, epoch: 0 },
  observation: null,
  model_ready: true,
  error: null,
  candidates: [],
};
const row = {
  session_id: "s",
  article_id: "a",
  generation: 0,
  phase: "closed",
  operation_id: "operation-a",
  title: "Frozen article title",
  queued_at: "2026-10-26T00:00:00.000Z",
  closed_at: "2026-10-26T00:00:01.000Z",
  outcome: { kind: "retained", code: "browser-agent-stopped" },
  stop: {
    reason: "no-viable-path",
    explanation: "No PDF link.\nNothing else to inspect.",
  },
};
const action = {
  seq: 1,
  at: "2026-10-26T00:00:00.000Z",
  actor: "agent",
  kind: "click-element",
  point: { x: 10.5, y: 20 },
  viewport: { width: 800, height: 600 },
  page_id: "p",
  document_generation: 1,
  frame_seq: 7,
  observation_revision: 7,
  label: "View PDF",
  url: "https://example.test/article",
};
it("accepts legacy views and round trips optional grouped sessions and frame-bound actions", () => {
  expect(parseWorkbenchView(legacy)).toEqual(legacy);
  expect(parseWorkbenchArticleSession(row)).toEqual(row);
  const view = { ...legacy, sessions: [row], actions: [action] };
  expect(parseWorkbenchView(JSON.parse(JSON.stringify(view)))).toEqual(view);
  expect(Object.isFrozen(parseWorkbenchActionRecord(action).point)).toBe(true);
  expect(
    parseWorkbenchArticleSession({
      ...row,
      outcome: { kind: "published", code: "published" },
    }).outcome?.kind,
  ).toBe("published");
});
it("rejects oversized fields, invalid times and lifecycle inversions", () => {
  for (const patch of [
    { title: "x".repeat(513) },
    { operation_id: "x".repeat(129) },
    { queued_at: "2026-02-30T00:00:00Z" },
    { closed_at: "2026-10-25T23:59:59Z" },
    { phase: "ready" },
    { stop: { reason: "no-viable-path", explanation: "x".repeat(2049) } },
    { outcome: { kind: "unknown", code: "unknown" } },
  ])
    expect(() => parseWorkbenchArticleSession({ ...row, ...patch })).toThrow();
  for (const patch of [
    { at: "tomorrow" },
    { at: "2026-02-30T00:00:00Z" },
    { label: "x".repeat(513) },
    { actor: "model" },
    { text: "private input" },
    { url: "https://example.test/?token=secret" },
    { url: "https://user:pass@example.test/" },
    { seq: 1.5 },
  ])
    expect(() => parseWorkbenchActionRecord({ ...action, ...patch })).toThrow();
});
it("bounds points by their execution viewport and requires exact frame binding", () => {
  for (const point of [
    { x: -1, y: 0 },
    { x: 800, y: 1 },
    { x: 1, y: 600 },
    { x: Infinity, y: 1 },
    { x: 1, y: NaN },
  ])
    expect(() => parseWorkbenchActionRecord({ ...action, point })).toThrow();
  for (const key of [
    "viewport",
    "frame_seq",
    "observation_revision",
    "page_id",
    "document_generation",
  ]) {
    const value: Record<string, unknown> = { ...action };
    delete value[key];
    expect(() => parseWorkbenchActionRecord(value)).toThrow();
  }
  expect(() =>
    parseWorkbenchActionRecord({ ...action, kind: "type-text" }),
  ).toThrow();
  const actions = Array.from({ length: 100 }, (_, i) => ({
    ...action,
    seq: i + 10,
  }));
  expect(parseWorkbenchView({ ...legacy, actions }).actions).toHaveLength(100);
  for (const invalid of [
    [action, action],
    [action, { ...action, seq: 2, at: "2026-10-25T00:00:00Z" }],
    [...actions, { ...action, seq: 111 }],
  ])
    expect(() => parseWorkbenchView({ ...legacy, actions: invalid })).toThrow();
});
