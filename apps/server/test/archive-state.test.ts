import { expect, it } from "vitest";
import type { ArchiveState, ArchiveStepReceipt } from "@sciretriever/contracts";
import { deriveCurrentState } from "../src/literature/state.js";
const ready = (): ArchiveState => ({
  literature_id: "fixture",
  mode: "full",
  started: true,
  running: false,
  article_kind: "research-article",
  metadata_missing: [],
  tag_count: 1,
  description_version: "description",
  issues: [],
  parts: [
    {
      asset_id: "main",
      asset_sha256: "pdf",
      part: "main",
      raw_profiles: ["vlm-engine"],
      proofread_id: "proof",
      proofread_complete: true,
      document_version_id: "doc",
      structure_annotation_id: "structure",
      structure_satisfied: true,
      content_version: "content",
      steps: [{ step: "references", status: "done" } as ArchiveStepReceipt],
    },
  ],
});
it("derives every readiness conjunction with explicit priority and no thresholds", () => {
  for (let bits = 0; bits < 64; bits++) {
    const s = ready(),
      p = s.parts[0]!;
    const facts = {
      ...s,
      started: !!(bits & 1),
      metadata_missing: bits & 16 ? [] : ["metadata-missing:title"],
      tag_count: bits & 32 ? 1 : 0,
      parts: [
        {
          ...p,
          proofread_complete: !!(bits & 2),
          document_version_id: bits & 4 ? "doc" : null,
          structure_satisfied: !!(bits & 8),
          steps: [],
        },
      ],
    };
    expect(deriveCurrentState(facts).status, bits.toString(2)).toBe(
      bits === 63 ? "READY" : "ASSET_READY",
    );
  }
  expect(deriveCurrentState({ ...ready(), parts: [], running: true })).toEqual({
    status: "UNREVIEWED",
    missing_step: "primary-pdf",
  });
  expect(
    deriveCurrentState({
      ...ready(),
      parts: [{ ...ready().parts[0]!, raw_profiles: ["pipeline"] }],
      running: true,
    }),
  ).toEqual({ status: "ASSET_READY", missing_step: "raw-parse" });
  expect(deriveCurrentState({ ...ready(), running: true }).status).toBe(
    "ARCHIVING",
  );
  expect(
    deriveCurrentState({ ...ready(), article_kind: "correction-or-editorial" })
      .status,
  ).toBe("EXCLUDED");
  expect(
    deriveCurrentState({
      ...ready(),
      article_kind: "perspective-or-commentary",
    }).status,
  ).toBe("EXCLUDED");
  expect(deriveCurrentState({ ...ready(), tag_count: 7 }).missing_step).toBe(
    "tags",
  );
  expect(deriveCurrentState({ ...ready(), tag_count: 7 }, 8).status).toBe(
    "READY",
  );
  const issue = {
    issue_id: "i",
    literature_id: "fixture",
    asset_id: "main",
    part: "main" as const,
    step: "tags" as const,
    reason: "tags-empty",
    detail: {},
    affects_readiness: true,
    resolution: null,
  };
  for (const resolution of [null, "skip", "cancel"] as const)
    expect(
      deriveCurrentState({ ...ready(), issues: [{ ...issue, resolution }] })
        .status,
    ).toBe("ARCHIVE_FAILED");
  expect(
    deriveCurrentState({
      ...ready(),
      issues: [{ ...issue, part: "supplementary", affects_readiness: false }],
    }).status,
  ).toBe("READY");
  expect(
    deriveCurrentState({
      ...ready(),
      mode: "legacy-vlm-markdown",
      parts: [
        {
          ...ready().parts[0]!,
          raw_profiles: ["vlm-engine-markdown-only"],
        },
      ],
    }).status,
  ).toBe("READY");
});
