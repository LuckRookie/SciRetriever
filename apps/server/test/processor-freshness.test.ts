import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import {
  canonicalJsonBytes,
  parseAsset,
  sha256,
} from "@sciretriever/contracts";
import {
  archiveFixture,
  moveIntroductionToMethods,
} from "./archive-fixture.js";
import { workbenchPdf } from "../src/workbench/synthetic-fixture.js";
it("marks only read content stale, including newly present supplementary material, and never recomputes on read", async () => {
  const e = await archiveFixture();
  try {
    const parsed = await e.app.documentProcessing.parseDocuments(
      e.rawParseRequest,
    );
    if (parsed.draft.status !== "formed" && parsed.draft.status !== "reused")
      throw new Error("Synthetic draft missing");
    const draftContent = await sha256(
      canonicalJsonBytes({
        text_level: "draft",
        document_version_id: parsed.draft.document_version_id,
      }),
    );
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
    const raw = new DatabaseSync(join(e.home, "catalog.sqlite"));
    try {
      const saved = raw
        .prepare(
          "SELECT method_revision FROM processor_result_summaries WHERE result_id=?",
        )
        .get(main)!;
      raw
        .prepare(
          "UPDATE processor_result_summaries SET method_revision=NULL WHERE result_id=?",
        )
        .run(main);
      expect((await e.app.processorRead!.byId(main))!.freshness).toMatchObject({
        state: "stale",
        reasons: [expect.objectContaining({ kind: "method-changed" })],
      });
      expect((await e.app.processorRead!.byId(main))!.outcomes).toBeNull();
      expect(
        (
          await e.app.processorRead!.list(50, "", undefined, null, true)
        ).items.map((i) => i.result_id),
      ).toContain(main);
      expect(e.modelCalls).toBe(calls);
      const related = await e.app.database.review<{
        items: { result_id: string; outcomes: unknown; freshness: string }[];
      }>("literature-results", { literature_id: e.id });
      expect(related.items.find((r) => r.result_id === main)).toMatchObject({
        freshness: "stale",
        outcomes: null,
      });
      const runs = await e.app.database.review<{
        items: { stale: boolean; outcomes: unknown }[];
      }>("processor-runs", {});
      expect(runs.items.filter((r) => r.stale)).toHaveLength(1);
      expect(runs.items.find((r) => r.stale)!.outcomes).toBeNull();
      raw
        .prepare(
          "UPDATE processor_result_summaries SET method_revision=? WHERE result_id=?",
        )
        .run(saved.method_revision!, main);
    } finally {
      raw.close();
    }
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
    // Flow X (06ca0af) derives section roles from the arrangement; the v1
    // annotation role edit is retired, so move the introduction text there.
    const oldContent = (await e.app.archive.status(e.id)).parts.find(
      (part) => part.asset_id === e.asset.asset_id,
    )!.content_version;
    expect(oldContent).not.toBeNull();
    await moveIntroductionToMethods(e, "fixture");
    const newContent = (await e.app.archive.status(e.id)).parts.find(
      (part) => part.asset_id === e.asset.asset_id,
    )!.content_version;
    expect(newContent).not.toBeNull();
    const stale = await e.app.processorRead!.byId(main);
    expect(stale!.freshness?.state).toBe("stale");
    // With schema 17 the manual publication falls back to the valid draft,
    // before render publishes the new corrected version and its annotation.
    // Keep one reason for each exact transition, including both null windows.
    expect(stale!.freshness?.reasons).toEqual([
      expect.objectContaining({
        kind: "content-version-changed",
        asset_id: e.asset.asset_id,
        old_version: oldContent,
        new_version: null,
      }),
      expect.objectContaining({
        kind: "content-version-changed",
        asset_id: e.asset.asset_id,
        old_version: null,
        new_version: draftContent,
      }),
      expect.objectContaining({
        kind: "content-version-changed",
        asset_id: e.asset.asset_id,
        old_version: draftContent,
        new_version: null,
      }),
      expect.objectContaining({
        kind: "content-version-changed",
        asset_id: e.asset.asset_id,
        old_version: null,
        new_version: newContent,
      }),
    ]);
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
}, 0);
