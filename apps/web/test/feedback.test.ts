import { describe, expect, it } from "vitest";
import {
  parseLiteratureId,
  type WorkbenchCandidate,
  type WorkbenchView,
} from "@sciretriever/contracts";
import { candidateStatus } from "../src/feedback.js";

const candidate: WorkbenchCandidate = {
  transfer_id: "transfer-1",
  sha256: "a".repeat(64),
  size_bytes: 1024,
  page_count: 1,
  disposition: "accepted",
  publication: null,
};
const running: WorkbenchView = {
  mode: "production",
  session_id: "session-1",
  article_id: "00000000-0000-0000-0000-000000000001",
  state: "agent-running",
  control: {
    workspace_id: "workspace-1",
    viewers: 1,
    controller_id: null,
    epoch: 0,
  },
  observation: null,
  model_ready: false,
  error: null,
  candidates: [candidate],
  operation_feedback: {
    phase: "browser",
    targets: {
      total: 1,
      running: 1,
      completed: 0,
      failed: 0,
      skipped: 0,
      interrupted: 0,
      not_started: 0,
    },
    current_target: parseLiteratureId("00000000-0000-0000-0000-000000000001"),
    report: null,
    failure: null,
    primary_pdf_status: "unchecked",
    primary_pdf: null,
  },
};

describe("candidate feedback shown by the live workbench", () => {
  it("only describes an uncommitted production candidate as waiting while its operation runs", () => {
    expect(candidateStatus(running, candidate)).toContain("等待提交");
    for (const state of ["failed", "cancelled", "finished"] as const) {
      expect(
        candidateStatus(
          {
            ...running,
            state,
            operation_feedback: {
              ...running.operation_feedback!,
              phase: "ended",
            },
          },
          candidate,
        ),
      ).toBe("操作已结束，本次候选未确认提交；请查看最终报告");
    }
  });

  it("shows a verified committed PDF and preserves synthetic candidate wording", () => {
    expect(
      candidateStatus(
        {
          ...running,
          state: "finished",
          operation_feedback: {
            ...running.operation_feedback!,
            phase: "ended",
            primary_pdf_status: "verified",
            primary_pdf: { sha256: candidate.sha256, size_bytes: 1024 },
          },
        },
        candidate,
      ),
    ).toBe("已接纳并提交为当前主 PDF");
    expect(candidateStatus({ ...running, mode: "synthetic" }, candidate)).toBe(
      "身份与版本已核验",
    );
  });
});
