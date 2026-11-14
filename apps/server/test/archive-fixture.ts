import type { ArchiveStep } from "@sciretriever/contracts";
import { expect } from "vitest";
import { SqliteArchiveTextStorage } from "../src/storage/archive-text.js";
import { archiveModel } from "./archive-model-fixture.js";
import { coreProcessingFixture } from "./core-processing-fixture.js";
export { archiveModel } from "./archive-model-fixture.js";
export async function archiveFixture(
  options: Parameters<typeof coreProcessingFixture>[0] = {},
) {
  const e = await coreProcessingFixture(options);
  e.setText(
    "# Abstract\n\nFixture Author studies synthetic spectroscopy.\n\n# Introduction\n\nA complete synthetic study.\n\n# Conclusion\n\nSpectroscopy is the main theme.\n\n# References\n\n[1] Example synthetic reference.\n",
  );
  e.setModel(archiveModel);
  const id = e.rawParseRequest.literature_id;
  const submit = async (
    key: string,
    signal?: AbortSignal,
    from_step: ArchiveStep | null = null,
  ) => {
    const job = await e.app.processingTasks!.submit({
      schema_version: 1,
      idempotency_key: key,
      operations: [
        {
          operation: "build-archive",
          request: {
            schema_version: 2,
            literature_id: id,
            mode: "full",
            from_step,
          },
        },
      ],
    });
    await e.app.processingTasks!.run(job.job_id, signal);
    return e.app.processingTasks!.read(job.job_id);
  };
  return {
    ...e,
    get app() {
      return e.app;
    },
    get modelCalls() {
      return e.modelCalls;
    },
    get parseCalls() {
      return e.parseCalls;
    },
    id,
    submit,
  };
}

/** Move the arranged introduction to methods: the flow X role edit. */
export async function moveIntroductionToMethods(
  e: Awaited<ReturnType<typeof archiveFixture>>,
  actor: string,
) {
  const part = (await e.app.archive.status(e.id)).parts.find(
      (p) => p.part === "main",
    )!,
    old = (await new SqliteArchiveTextStorage(e.app.database, e.app.files).load(
      part.proofread_id!,
    ))!,
    leaves = old.bundle.leaves.filter(
      (l) =>
        l.destination.kind === "assigned" &&
        l.destination.target.role === "introduction",
    );
  expect(leaves.length).toBeGreaterThan(0);
  const edited = await e.app.archiveArrangement.edit(
    {
      schema_version: 2,
      literature_id: e.id,
      asset_id: e.asset.asset_id,
      expected_proofread_id: old.version.proofread_id,
      expected_arrangement_id: old.version.arrangement_id,
      expected_manual_revision: 0,
      changes: leaves.map((l) => ({
        kind: "assign",
        leaf_id: l.leaf.leaf_id,
        target: { role: "methods" },
        presentation:
          l.destination.kind === "assigned"
            ? l.destination.presentation
            : { kind: "content" },
      })),
    },
    actor,
  );
  // A role move keeps every page's retained text, so it renders at once.
  expect(edited.pending_page_indexes).toEqual([]);
}
