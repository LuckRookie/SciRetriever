import { expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import {
  parseEvidenceRef,
  sha256,
  parseProcessorValueChecks,
  type ProcessorCitation,
  type ProcessorJson,
  type ProcessorContent,
} from "@sciretriever/contracts";
import {
  ProcessorValueVerifier,
  valueInFragments,
} from "../src/analysis/value-check.js";
import { DocumentReadError } from "../src/document/read.js";
import { buildProofreadVersion } from "../src/proofread/engine.js";
import { SqliteProofreadStorage } from "../src/storage/proofread.js";
import { coreProcessingFixture } from "./core-processing-fixture.js";

async function fixture(imageOnly = false) {
  const e = await coreProcessingFixture();
  e.setText("The yield was 97%.");
  await e.app.documentProcessing.parseDocuments({
    ...e.rawParseRequest,
    profiles: ["vlm-engine"],
  });
  const raw = (await e.app.rawParseStorage!.current(e.asset.asset_id))[0]!
      .result!,
    source = await e.app.rawParseStorage!.loadSource(raw.raw_parse_id);
  const proof = await buildProofreadVersion({
    raw,
    page_method: "fixture",
    reader: {
      readArtifact: async (_id, kind) =>
        kind === "blocks" ? source.blocks!.bytes : source.markdown.bytes,
    },
    pages: [
      {
        page: 0,
        kind: imageOnly ? "image-only" : "text-layer",
        text: imageOnly ? "" : "The yield was 97%.",
        visible_glyphs: imageOnly ? 0 : 18,
        hidden_glyphs: 0,
        unmapped_glyphs: 0,
        has_graphics: imageOnly,
      },
    ],
    corrector: {
      method: "fixture-page-review",
      model_config_sha256: await sha256(Buffer.from("fixture")),
      max_calls: 2,
      correct: async () => ({
        submission: { edits: [], dispositions: [], no_body_reason: null },
        reason: null,
        calls: 1,
        input_tokens: 1,
        output_tokens: 1,
      }),
    },
  });
  await new SqliteProofreadStorage(e.app.database, e.app.files).publish(
    proof,
    0,
  );
  const published = await e.app.proofreadDocuments.publish({
    literature_id: e.rawParseRequest.literature_id,
    asset_id: e.asset.asset_id,
    proofread_id: proof.version.proofread_id,
    expected_default_revision: null,
  });
  const described = await e.app.documentRead.segments({
    document_version_id: published.document.document_version_id,
    cursor: null,
    limit: 10,
    section_id: null,
  });
  const segment = described.segments[0]!;
  const citation = {
    kind: "document" as const,
    evidence: parseEvidenceRef({
      schema_version: 1,
      target_kind: "document",
      locator_scheme: "utf8-segment-v1",
      document_version_id: published.document.document_version_id,
      representation_sha256: published.document.representation_sha256,
      locator: { kind: "segment", segment_id: segment.segment_id },
      content_sha256: null,
    }),
  };
  return {
    e,
    citation,
    verifier: new ProcessorValueVerifier(e.app.documentRead),
    close: () => e.close(),
  };
}

function content(
  value: ProcessorJson,
  sources: readonly ProcessorCitation[],
): ProcessorContent {
  return {
    kind: "records",
    schema: { type: "object" },
    records: [
      {
        record_id: "r1",
        payload: { value },
        evidence: [{ pointer: "/value", sources }],
        missing: {},
      },
    ],
  };
}
it.each([false, true])(
  "checks all text bases without vision calls and handles all six states (image-only=%s)",
  { timeout: 0 },
  async (imageOnly) => {
    const f = await fixture(imageOnly);
    const signal = new AbortController().signal;
    try {
      const cases: [ProcessorJson, readonly ProcessorCitation[], string][] = [
        [{ value: 97, raw: "97", unit: "%" }, [f.citation], "found"],
        [{ value: 98, raw: "98", unit: "%" }, [f.citation], "not-found"],
        ["yield", [f.citation], "found"],
        ["completely absent words", [f.citation], "not-found"],
        [null, [], "value-null"],
        ["nonempty", [], "no-citation"],
        [
          "nonempty",
          [
            {
              kind: "document",
              evidence: parseEvidenceRef({
                ...f.citation.evidence,
                document_version_id: randomUUID(),
              }),
            },
          ],
          "citation-unavailable",
        ],
        [
          "synthesis",
          [
            {
              kind: "result",
              result_id: randomUUID(),
              content_sha256: "a".repeat(64),
              record_id: "r0",
              pointer: "/value",
            },
          ],
          "derived",
        ],
      ];
      for (const [value, sources, status] of cases) {
        const c = content(value, sources),
          r = await f.verifier.check(c, [], signal);
        expect(r.checks[0]!.status).toBe(status);
        expect(r.usage).toEqual({
          calls: 0,
          input_tokens: 0,
          output_tokens: 0,
        });
        expect(parseProcessorValueChecks(r.checks, c)).toEqual(r.checks);
        if (status === "found")
          expect(r.checks[0]!.sources[0]!.basis).toBe(
            imageOnly ? "image-only" : "text-layer",
          );
      }
      const c = content("yield", [f.citation]),
        r = await f.verifier.check(c, [], signal);
      expect(() =>
        parseProcessorValueChecks([{ ...r.checks[0], sources: [] }], c),
      ).toThrow();
      vi.spyOn(f.e.app.documentRead, "resolveEvidence").mockRejectedValueOnce(
        new DocumentReadError("document-integrity"),
      );
      await expect(f.verifier.check(c, [], signal)).rejects.toMatchObject({
        code: "document-integrity",
      });
    } finally {
      await f.close();
    }
  },
);
it("does not confuse missing text, different units, or numeric substrings with a found value", () => {
  expect(valueInFragments("absent words", ["present words"])).toBe(false);
  expect(valueInFragments("", ["text"])).toBe(false);
  expect(valueInFragments({ value: 97, raw: "97", unit: "%" }, ["197%"])).toBe(
    false,
  );
  expect(valueInFragments({ value: 97, raw: "97", unit: "°C" }, ["97%"])).toBe(
    false,
  );
  expect(valueInFragments({ value: 97, raw: "97", unit: "°C" }, ["97 ℃"])).toBe(
    true,
  );
  expect(
    valueInFragments({ value: 97, raw: "97", unit: "m" }, ["97 samples"]),
  ).toBe(false);
  expect(valueInFragments({ value: 97, raw: "97", unit: "m" }, ["97 mm"])).toBe(
    false,
  );
  expect(valueInFragments({ value: 97, raw: "97", unit: "m" }, ["97m"])).toBe(
    true,
  );
});
