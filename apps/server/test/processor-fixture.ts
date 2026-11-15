import { expect } from "vitest";
import {
  canonicalJsonBytes,
  sha256,
  type RawParseProfile,
} from "@sciretriever/contracts";
import { ArchiveOrchestrator } from "../src/archive/orchestrator.js";
import {
  coreProcessingFixture,
  type ModelInput,
} from "./core-processing-fixture.js";
import { archiveModel } from "./archive-fixture.js";
const selections = new Map<string, string>();
export function processorSelection(documentVersionId: string) {
  const literature_id = selections.get(documentVersionId);
  if (!literature_id) throw new Error("Unknown fixture document");
  return { kind: "literature" as const, literature_id };
}
/** Real raw -> proofread -> document -> archive path, with only model/parser transport faked. */
export async function processorFixture(
  options: Parameters<typeof coreProcessingFixture>[0] = {},
  profiles: readonly RawParseProfile[] = ["pipeline", "vlm-engine"],
) {
  const e = await coreProcessingFixture(options);
  let setupCalls = 0;
  let reply: (
    input: ModelInput,
    signal?: AbortSignal,
  ) => unknown | Promise<unknown> = (input) => ({
    outcome: "completed",
    title: "Synthetic finding",
    statements: [
      {
        statement_id: "s1",
        category: "finding",
        epistemic: "reported",
        text: "A synthetic finding.",
        conditions: [],
        quantity: null,
        evidence_segment_ids: [
          (
            input.segments!.find((s) =>
              s.text.includes("A synthetic finding."),
            ) ?? input.segments![0]!
          ).segment_id,
        ],
      },
    ],
  });
  e.setModel((input, signal) =>
    input.method === "section-role-dsh-v1"
      ? { role: "body" }
      : input.method === "archive-metadata-dsh-v2" ||
          ["topics", "select", "consolidate"].includes(String(input.task))
        ? archiveModel(input)
        : reply(input, signal),
  );
  const setText = (text: string) =>
    e.setText(
      `${text}\n\n# Abstract\n\nFixture Author studies spectroscopy.\n\n# Introduction\n\nA synthetic study.\n\n# Conclusion\n\nA synthetic conclusion.\n\n# References\n\n[1] Synthetic reference.\n`,
    );
  setText("A synthetic finding.");
  const build = async (request: {
    literature_id: string;
    asset_id: string;
    asset_sha256: string;
  }) => {
    const before = e.modelCalls;
    try {
      // These processor tests require corrected evidence only. Prepare raw
      // facts directly; automatic drafts and their reader rollout have their
      // own integration tests.
      await e.app.rawParsing!.parseAsset(
        request.asset_id,
        profiles,
        undefined,
        {
          expected_sha256: request.asset_sha256,
          force: true,
        },
      );
      // Prepare real archive facts without inserting unrelated setup jobs into
      // processor/UI job assertions. Durable archive jobs have their own tests.
      const archive = new ArchiveOrchestrator(e.app.database, {
        text: e.app.archiveText!,
        proofread: e.app.proofreading!,
        documents: e.app.proofreadDocuments,
        structure: e.app.structureAnnotations!,
        metadata: e.app.archiveMetadata,
        references: e.app.archiveReferences,
        tags: e.app.tags,
        metadataFields: e.app.metadataFields,
        method_sha256: await sha256(
          canonicalJsonBytes({
            method: "archive-arrange-v2",
            proofread: { model: e.app.configuration.proofread.model },
            models: e.app.configuration.models,
            analyze: e.app.configuration.analyze,
            tags: e.app.configuration.tags,
          }),
        ),
      });
      await archive.build({
        schema_version: 2,
        literature_id: request.literature_id,
        mode: "full",
        from_step: null,
      });
      const status = await e.app.archive.status(request.literature_id);
      expect(status.status, JSON.stringify(status)).toBe("READY");
      const current = await e.app.documentRead.default({
        literature_id: request.literature_id,
        asset_id: request.asset_id,
        asset_sha256: request.asset_sha256,
      });
      const document = (
        await e.app.documentRead.describe({
          document_version_id: current.default!.document_version_id,
        })
      ).document;
      selections.set(document.document_version_id, request.literature_id);
      return {
        document,
        default_updated: true,
        default_revision: current.default!.revision,
      };
    } finally {
      setupCalls += e.modelCalls - before;
    }
  };
  return {
    ...e,
    get app() {
      return e.app;
    },
    get modelCalls() {
      return e.modelCalls - setupCalls;
    },
    get parseCalls() {
      return e.parseCalls;
    },
    setText,
    setModel: (value: typeof reply) => {
      reply = value;
    },
    build,
  };
}
