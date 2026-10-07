import { describe, expect, it } from "vitest";
import { parseWorkbenchView } from "../src/index.js";

const legacyView = {
  session_id: "session-a",
  article_id: "article-a",
  state: "watching",
  control: {
    workspace_id: "session-a",
    viewers: 1,
    controller_id: null,
    epoch: 0,
  },
  observation: null,
  model_ready: true,
  error: null,
  candidates: [],
};
const sessions = [
  {
    session_id: "session-a",
    article_id: "article-a",
    generation: 1,
    phase: "waiting",
  },
  {
    session_id: "session-b",
    article_id: "article-b",
    generation: 1,
    phase: "downloading",
  },
];

describe("parallel article Workbench view contracts", () => {
  it("retains the exact legacy single-session shape", () => {
    expect(parseWorkbenchView(legacyView)).toEqual(legacyView);
    expect(() =>
      parseWorkbenchView({ ...legacyView, selected_session: "session-a" }),
    ).toThrow();
  });

  it("parses independent article rows and preserves selected lifecycle outcomes", () => {
    for (const session_outcome of [
      null,
      { kind: "published", receipt_id: "receipt-a" },
      { kind: "retained", code: "publication-disk-full" },
      { kind: "cancelled" },
    ]) {
      const view = {
        ...legacyView,
        mode: "production",
        sessions,
        session_phase: "waiting",
        session_outcome,
      };
      const parsed = parseWorkbenchView(view);
      expect(parsed).toEqual(view);
      expect(Object.isFrozen(parsed.sessions)).toBe(true);
      expect(Object.isFrozen(parsed.sessions![0])).toBe(true);
    }
    const full = [
      sessions[0],
      ...Array.from({ length: 63 }, (_, index) => ({
        ...sessions[1],
        session_id: `cohort-session-${index}`,
      })),
    ];
    expect(
      parseWorkbenchView({
        ...legacyView,
        sessions: full,
        session_phase: "waiting",
      }).sessions,
    ).toHaveLength(64);
  });

  it("rejects duplicate identities, invalid generations and mismatched selected rows", () => {
    const view = { ...legacyView, sessions, session_phase: "waiting" };
    for (const invalid of [
      { ...view, sessions: [sessions[0], sessions[0]] },
      { ...view, sessions: [{ ...sessions[0], generation: -1 }] },
      { ...view, sessions: [{ ...sessions[0], generation: 0.5 }] },
      { ...view, sessions: [{ ...sessions[0], phase: "unknown" }] },
      { ...view, sessions: [{ ...sessions[0], article_id: "article-b" }] },
      { ...view, session_phase: "downloading" },
      {
        ...view,
        sessions: Array.from({ length: 65 }, (_, index) => ({
          ...sessions[0],
          session_id: `session-${index}`,
        })),
      },
    ])
      expect(() => parseWorkbenchView(invalid)).toThrow();
  });

  it("requires closed outcome shapes without leaking runtime payloads", () => {
    expect(
      parseWorkbenchView({
        ...legacyView,
        session_outcome: { kind: "published", receipt_id: "receipt-a" },
        session_cleanup_failure: "browser-network-drain-timeout",
      }),
    ).toMatchObject({
      session_outcome: { kind: "published", receipt_id: "receipt-a" },
      session_cleanup_failure: "browser-network-drain-timeout",
    });
    expect(() =>
      parseWorkbenchView({
        ...legacyView,
        session_cleanup_failure: "browser-network-drain-timeout",
      }),
    ).toThrow();
    for (const session_outcome of [
      { kind: "published" },
      { kind: "retained" },
      { kind: "cancelled", receipt_id: "receipt-a" },
      { kind: "published", receipt_id: "receipt-a", path: "/private/file" },
      { kind: "retained", code: "failed", cookie: "private" },
      { kind: "failed", code: "failure" },
    ])
      expect(() =>
        parseWorkbenchView({ ...legacyView, session_outcome }),
      ).toThrow();
  });
});
