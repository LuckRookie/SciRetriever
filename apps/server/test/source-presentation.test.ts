import { expect, it } from "vitest";
import {
  parseWorkbenchView,
  parseAcquisitionAttempt,
} from "@sciretriever/contracts";
import { WorkbenchSession } from "../src/workbench/session.js";
import { BrowserActivityLog } from "../src/browser/activity.js";
import { presentAcquisitionAttempt } from "../src/providers/shared/source-problem.js";
import { presentWorkbenchSources } from "../src/workbench/source-presentation.js";
it("exposes platform failures as errors with only technical reason codes, while retaining Agent explanations and internal facts", () => {
  const session = new WorkbenchSession(
    "article",
    {
      id: "page",
      close: async () => {},
      title: async () => "Synthetic",
      url: () => "http://127.0.0.1/",
      apply: async () => {},
      snapshot: async () => {
        throw Error("not needed");
      },
    },
    {
      max_actions: 1,
      max_model_calls: 1,
      max_retries: 1,
      max_bytes: 1,
      deadline_ms: 1000,
    },
    undefined,
    "session",
  );
  const log = session.activityLog();
  log.navigationFailed("browser-navigation-failed");
  log.close({ kind: "retained", code: "browser-runtime-lost" });
  const view = parseWorkbenchView(session.view());
  expect(view.sessions?.[0]).toMatchObject({
    stop: {
      reason: "error",
      problem: {
        display: "error",
        technical_details: {
          diagnostics: [{ code: "browser-runtime-lost", scope: "runtime" }],
        },
      },
    },
    outcome: { kind: "retained", code: "error" },
  });
  expect(view.actions).toMatchObject([
    {
      kind: "navigation-failed",
      label: "错误",
      technical_details: {
        diagnostics: [{ code: "browser-navigation-failed", scope: "runtime" }],
      },
    },
    { kind: "flow-stopped", label: "错误" },
  ]);
  expect(log.stop!.reason).toBe("browser-runtime-lost"); // presentation never changes control state
  expect(log.snapshot()[0]!.label).toContain("browser-navigation-failed");
  const agent = new BrowserActivityLog();
  agent.stopped(
    { reason: "no-viable-path", explanation: "已尝试可见的下载路线。" },
    "agent",
  );
  const agentView = presentWorkbenchSources({
    ...view,
    sessions: [{ ...view.sessions![0]!, stop: agent.stop! }],
    actions: agent.snapshot(),
  });
  expect(agentView.sessions![0]!.stop).toEqual(agent.stop);
  expect(agentView.actions![0]!.label).toBe("已尝试可见的下载路线。");
  expect(presentWorkbenchSources(view)).toEqual(view);
});
it("keeps old attempt payloads readable and moves their codes into technical details in the display projection", () => {
  const at = "2026-10-28T00:00:00Z";
  const legacy = parseAcquisitionAttempt({
    source: "wiley",
    stage: "publisher-api",
    started_at: at,
    finished_at: at,
    result: "unavailable",
    requested: false,
    code: "missing-credential",
  });
  const value = presentAcquisitionAttempt(legacy);
  expect(value.code).toBeUndefined();
  expect(value.problem?.display).toBe("not-configured");
  expect(value.technical_details?.diagnostics).toEqual([
    { code: "missing-credential", scope: "pdf" },
  ]);
  expect(parseAcquisitionAttempt(value)).toEqual(value);
});

it("retains cancellation in technical history without presenting it as a source request error", () => {
  const value = presentAcquisitionAttempt(
    parseAcquisitionAttempt({
      source: "browser",
      stage: "browser",
      started_at: "2026-10-28T00:00:00Z",
      finished_at: "2026-10-28T00:00:00Z",
      requested: true,
      result: "failed",
      code: "browser-flow-cancelled",
      problem: {
        display: "error",
        technical_details: {
          diagnostics: [{ code: "browser-flow-cancelled", scope: "pdf" }],
        },
      },
    }),
  );
  expect(value.problem).toBeUndefined();
  expect(value.technical_details?.diagnostics).toEqual([
    { code: "browser-flow-cancelled", scope: "pdf" },
  ]);
});
