import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { parseAsset, sha256 } from "@sciretriever/contracts";
import { archiveFixture } from "./archive-fixture.js";
import { SqliteAnnotationStorage } from "../src/storage/structure-annotations.js";
import { workbenchPdf } from "../src/workbench/synthetic-fixture.js";
it("marks only read content stale, including newly present supplementary material, and never recomputes on read", async () => {
  const e = await archiveFixture();
  try {
    await e.app.documentProcessing.parseDocuments(e.rawParseRequest);
    await e.submit("ready");
    e.setModel((input) => ({
      answer: "reported",
      source_ids: [input.segments![0]!.segment_id],
      reason: null,
    }));
    const run = async (parts: string, key: string) => {
      const job = await e.app.processors!.submit({
        schema_version: 1,
        idempotency_key: key,
        name: key,
        processor: { id: "labels", version: "2" },
        spec: {
          question: "What is reported?",
          answer_type: "string",
          reads: { parts, roles: "all" },
        },
        inputs: [{ kind: "literature", literature_id: e.id }],
      });
      await e.app.processingTasks!.run(job.job_id);
      const state = await e.app.processingTasks!.read(job.job_id);
      expect(state.failures).toEqual([]);
      return (state.results[0] as { result: { result_id: string } }).result
        .result_id;
    };
    const main = await run("main", "main-result"),
      si = await run("supplementary", "absent-result"),
      calls = e.modelCalls;
    const meta = await e.app.metadataFields.read(e.id);
    await e.app.metadataFields.edit({
      literature_id: e.id,
      expected_revision: meta.metadata_revision,
      set: [{ field: "title", value: "A different display title" }],
      unlock: [],
    });
    expect((await e.app.processorRead!.byId(main))!.freshness?.state).toBe(
      "current",
    );
    const bytes = workbenchPdf("10.1000/new-supplement"),
      stage = await e.app.files.stage({ maxBytes: bytes.length });
    await stage.write(bytes);
    await e.app.files.publish(stage, "objects/new-supplement.pdf");
    await stage.discard();
    const asset = parseAsset({
      asset_id: randomUUID(),
      sha256: await sha256(bytes),
      size_bytes: bytes.length,
      media_type: "application/pdf",
      path: "objects/new-supplement.pdf",
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
    expect((await e.app.processorRead!.byId(main))!.freshness?.state).toBe(
      "current",
    );
    expect((await e.app.processorRead!.byId(si))!.freshness?.state).toBe(
      "stale",
    );
    const unavailable = await run("supplementary", "present-unavailable");
    expect(
      (await e.app.processorRead!.byId(unavailable))!.result.coverage[0]!.parts,
    ).toEqual([
      expect.objectContaining({
        outcome: "incomplete",
        gaps: ["part-unavailable"],
      }),
    ]);
    expect(e.modelCalls).toBe(calls);
    const state = await e.app.archive.status(e.id),
      doc = state.parts.find((p) => p.part === "main")!.document_version_id!,
      annotation = (await new SqliteAnnotationStorage(
        e.app.database,
        e.app.files,
      ).current(doc))!;
    await e.app.structureAnnotations!.setRole({
      document_version_id: doc,
      section_id: annotation.sections.find((s) => s.role === "introduction")!
        .section_id,
      role: "methods",
      expected_manual_revision: 0,
      actor: "fixture",
    });
    const stale = await e.app.processorRead!.byId(main);
    expect(stale!.freshness?.state).toBe("stale");
    expect(stale!.freshness?.reasons.length).toBe(1);
    expect((await e.app.processorRead!.byId(main))!.freshness).toEqual(
      stale!.freshness,
    );
    expect(e.modelCalls).toBe(calls);
    expect(
      (await e.app.processorRead!.list(50, "", undefined, null, true)).items,
    ).toHaveLength(2);
  } finally {
    await e.close();
  }
});
