import { expect, it, vi } from "vitest";
import { coreProcessingFixture } from "./core-processing-fixture.js";
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
it("reads each default's grade with its version without opening document bytes, and never makes a draft READY", async () => {
  const f = await coreProcessingFixture({ offline: true });
  try {
    const before = await f.app.archive.status(f.rawParseRequest.literature_id);
    expect(before).toMatchObject({
      text_level: null,
      parts: [{ text_level: null, document_version_id: null }],
    });
    const receipt = await f.app.documentProcessing.parseDocuments({
      ...f.rawParseRequest,
      profiles: ["vlm-engine"],
    });
    if (receipt.draft.status !== "formed")
      throw new Error("Synthetic draft missing");
    const read = vi
      .spyOn(f.app.files, "withVerified")
      .mockRejectedValue(new Error("Status must not read document bytes"));
    const draft = await f.app.archive.status(f.rawParseRequest.literature_id);
    expect(draft).toMatchObject({
      text_level: "draft",
      parts: [
        {
          document_version_id: receipt.draft.document_version_id,
          text_level: "draft",
        },
      ],
    });
    expect(deriveCurrentState(draft).status).not.toBe("READY");
    expect(read).not.toHaveBeenCalled();
    read.mockRestore();
    const proofread = await f.app.proofreading!.build({
      asset_id: f.asset.asset_id,
    });
    const published = await f.app.proofreadDocuments.publish({
      literature_id: f.rawParseRequest.literature_id,
      asset_id: f.asset.asset_id,
      proofread_id: proofread.version.proofread_id,
      expected_default_revision: 1,
    });
    const corrected = await f.app.archive.status(
      f.rawParseRequest.literature_id,
    );
    expect(corrected).toMatchObject({
      text_level: "proofread",
      parts: [
        {
          document_version_id: published.document.document_version_id,
          text_level: "proofread",
        },
      ],
    });
  } finally {
    vi.restoreAllMocks();
    await f.close();
  }
}, 30_000);
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
