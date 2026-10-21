import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  parseAsset,
  sha256,
  type ArchiveVersionEvent,
} from "@sciretriever/contracts";
import { archiveFixture } from "./archive-fixture.js";
import { SqliteAnnotationStorage } from "../src/storage/structure-annotations.js";
import { workbenchPdf } from "../src/workbench/synthetic-fixture.js";

it("retains earlier publications, surfaces each step failure and resumes after correction", async () => {
  const e = await archiveFixture();
  try {
    await e.app.documentProcessing.parseDocuments(e.rawParseRequest);
    const stages = [
      { owner: e.app.proofreading!, method: "build", step: "proofread" },
      { owner: e.app.proofreadDocuments, method: "publish", step: "document" },
      {
        owner: e.app.structureAnnotations!,
        method: "build",
        step: "structure",
      },
      { owner: e.app.archiveMetadata, method: "build", step: "metadata" },
      { owner: e.app.tags, method: "build", step: "tags" },
      { owner: e.app.archiveReferences, method: "build", step: "references" },
    ] as const;
    for (const stage of stages) {
      const spy = vi
        .spyOn(
          stage.owner as unknown as {
            build: (value: unknown) => Promise<unknown>;
            publish: (value: unknown) => Promise<unknown>;
          },
          stage.method,
        )
        .mockRejectedValueOnce(
          Object.assign(new Error("synthetic failure"), {
            code: `${stage.step}-failed`,
          }),
        );
      await e.submit(`fail-${stage.step}`, undefined, stage.step);
      spy.mockRestore();
      const failed = await e.app.archive.status(e.id);
      expect(failed.status, stage.step).toBe(
        stage.step === "references" ? "READY" : "ARCHIVE_FAILED",
      );
      expect(
        failed.issues.some(
          (i) => i.step === stage.step && i.resolution === null,
        ),
      ).toBe(true);
      const issue = failed.issues.find((i) => i.step === stage.step)!;
      await e.app.archive.resolve({
        issue_ids: [issue.issue_id],
        resolution: "skip",
      });
      expect((await e.app.archive.status(e.id)).status).toBe(
        stage.step === "references" ? "READY" : "ARCHIVE_FAILED",
      );
      // Stop the next step so every failure is reached without re-running successful model work.
    }
    await e.submit("recover-final");
    expect((await e.app.archive.status(e.id)).status).toBe("READY");
  } finally {
    vi.restoreAllMocks();
    await e.close();
  }
}, 20000); // Six injected failures plus recovery are a lifecycle check, not a 5-second benchmark.
describe("supplement and human revision lifecycle", () => {
  let e: Awaited<ReturnType<typeof archiveFixture>>;
  beforeAll(async () => {
    e = await archiveFixture();
    await e.app.documentProcessing.parseDocuments(e.rawParseRequest);
    await e.submit("base");
  });
  afterAll(async () => {
    await e?.close();
  });
  it("keeps an unparsed supplement non-blocking and publishes content/description changes on human edits", async () => {
    try {
      const before = await e.app.archive.status(e.id),
        bytes = workbenchPdf("10.1000/supplement"),
        stage = await e.app.files.stage({ maxBytes: bytes.length });
      await stage.write(bytes);
      await e.app.files.publish(stage, "objects/supplement.pdf");
      await stage.discard();
      const asset = parseAsset({
        asset_id: randomUUID(),
        sha256: await sha256(bytes),
        size_bytes: bytes.length,
        media_type: "application/pdf",
        path: "objects/supplement.pdf",
      });
      await e.app.database.putLiteratureAsset({
        literature_asset_id: randomUUID(),
        literature_id: e.id,
        asset,
        role: "supplementary-pdf",
        source_url: null,
        provenance: {
          provenance_id: randomUUID(),
          source_kind: "user",
          source_name: "fixture",
          source_record_id: null,
          observed_at: "2026-10-20T00:00:00Z",
          input_sha256: asset.sha256,
          parameters_sha256: null,
        },
      });
      expect((await e.app.archive.status(e.id)).status).toBe("READY");
      await e.submit("with-supplement");
      const unparsed = await e.app.archive.status(e.id);
      expect(unparsed.status).toBe("READY");
      expect(unparsed.issues).toContainEqual(
        expect.objectContaining({
          part: "supplementary",
          affects_readiness: false,
          reason: "needs-parse",
        }),
      );
      e.setText("# Methods\n\nSupplemental measurements.\n");
      await e.app.documentProcessing.parseDocuments({
        ...e.rawParseRequest,
        asset_id: asset.asset_id,
        asset_sha256: asset.sha256,
      });
      const original = e.app.proofreading!.build.bind(e.app.proofreading!);
      const failSupplement = vi
        .spyOn(e.app.proofreading!, "build")
        .mockImplementation((value, signal) =>
          (value as { asset_id: string }).asset_id === asset.asset_id
            ? Promise.reject(
                Object.assign(new Error("synthetic SI failure"), {
                  code: "proofread-failed",
                }),
              )
            : original(value, signal),
        );
      await e.submit("failed-supplement");
      failSupplement.mockRestore();
      expect((await e.app.archive.status(e.id)).status).toBe("READY");
      await e.submit("recovered-supplement");
      const supplemental = (await e.app.archive.status(e.id)).parts.find(
        (p) => p.part === "supplementary",
      )!;
      expect(supplemental.content_version).toMatch(/^[a-f0-9]{64}$/);
      const meta = await e.app.metadataFields.read(e.id);
      await e.app.metadataFields.edit({
        literature_id: e.id,
        expected_revision: meta.metadata_revision,
        set: [{ field: "article_kind", value: "correction-or-editorial" }],
        unlock: [],
      });
      expect((await e.app.archive.status(e.id)).status).toBe("EXCLUDED");
      const meta2 = await e.app.metadataFields.read(e.id);
      await e.app.metadataFields.edit({
        literature_id: e.id,
        expected_revision: meta2.metadata_revision,
        set: [{ field: "article_kind", value: "research-article" }],
        unlock: [],
      });
      expect((await e.app.archive.status(e.id)).status).toBe("READY");
      const doc = before.parts.find(
          (part) => part.part === "main",
        )!.document_version_id!,
        store = new SqliteAnnotationStorage(e.app.database, e.app.files),
        annotation = (await store.current(doc))!;
      const section = annotation.sections.find(
        (s) => s.role === "introduction",
      )!;
      await e.app.structureAnnotations!.setRole({
        document_version_id: doc,
        section_id: section.section_id,
        role: "methods",
        expected_manual_revision: 0,
        actor: "fixture-user",
      });
      expect(
        (await e.app.archive.status(e.id)).parts.find(
          (part) => part.part === "main",
        )!.content_version,
      ).not.toBe(
        before.parts.find((part) => part.part === "main")!.content_version,
      );
      const events = (await e.app.archive.query({
        operation: "events",
        request: { after: 0, limit: 100 },
      })) as ArchiveVersionEvent[];
      expect(
        events.filter(
          (x) => x.kind === "content-version-changed" && x.old_version !== null,
        ),
      ).not.toHaveLength(0);
      const inspected = await e.app.proofreading!.inspect({
        asset_id: e.asset.asset_id,
        unresolved_only: false,
      });
      const c = inspected.items[0]!.draft;
      await e.app.proofreading!.decide({
        asset_id: e.asset.asset_id,
        proofread_id: before.parts.find((part) => part.part === "main")!
          .proofread_id,
        block_id: c.block_id,
        draft_sha256: c.draft_sha256,
        expected_manual_revision: 0,
        action: "replace",
        reason: "Checked original PDF",
        text: "Corrected transcription.",
        actor: "fixture-user",
      });
      const changed = await e.app.archive.status(e.id);
      expect(
        changed.parts.find((part) => part.part === "main")!.content_version,
      ).toBeNull();
      expect(
        changed.parts.find((part) => part.part === "supplementary")!
          .content_version,
      ).toBe(supplemental.content_version);
      expect(changed.status).not.toBe("READY");
    } finally {
      vi.restoreAllMocks();
    }
  });
});
it("preserves completed steps across cancellation and an application restart", async () => {
  const e = await archiveFixture();
  try {
    await e.app.documentProcessing.parseDocuments(e.rawParseRequest);
    const stop = new AbortController(),
      original = e.app.archiveMetadata.build.bind(e.app.archiveMetadata);
    const cancel = vi
      .spyOn(e.app.archiveMetadata, "build")
      .mockImplementationOnce(async (value, signal) => {
        const result = await original(value, signal);
        stop.abort();
        return result;
      });
    await e.submit("cancel-at-metadata", stop.signal);
    cancel.mockRestore();
    const interrupted = await e.app.archive.status(e.id);
    expect(interrupted.running).toBe(false);
    expect(
      interrupted.parts[0]!.steps.find((s) => s.step === "metadata")?.status,
    ).toBe("done");
    expect(
      interrupted.parts[0]!.steps.find((s) => s.step === "structure")?.status,
    ).toBe("done");
    await e.reopen();
    const completed = await e.submit("resume-after-restart");
    expect(completed.failures).toEqual([]);
    expect((await e.app.archive.status(e.id)).status).toBe("READY");
    const calls = e.modelCalls;
    await e.submit("reuse-after-restart");
    expect(e.modelCalls).toBe(calls);
  } finally {
    vi.restoreAllMocks();
    await e.close();
  }
});
