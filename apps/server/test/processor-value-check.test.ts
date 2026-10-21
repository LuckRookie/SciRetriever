import { expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  parseEvidenceRef,
  sha256,
  type ProcessorContent,
} from "@sciretriever/contracts";
import { ProcessorValueVerifier } from "../src/analysis/value-check.js";
import { DshAgentRuntime } from "../src/agents/dsh/runtime.js";
import { buildProofreadVersion } from "../src/proofread/engine.js";
import { SqliteProofreadStorage } from "../src/storage/proofread.js";
import type { ProofreadCache, PdfPages } from "../src/proofread/contract.js";
import { coreProcessingFixture } from "./core-processing-fixture.js";

async function fixture(
  imageOnly = false,
  configured = false,
  confirmed = true,
  imageFailure?: string,
) {
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
  let calls = 0,
    images = 0;
  const runtime = new DshAgentRuntime(
    configured
      ? [
          {
            role: "value-checking",
            provider: "fixture",
            model: "vision",
            capabilities: ["structured_text", "tool_decision", "image_input"],
            reasoning: "default",
            stream: false,
            context_window_tokens: 100000,
            max_output_tokens: 4096,
            adapter: {
              provider: "fixture",
              model: "vision",
              execute: async () => {
                throw new Error("atomic model forbidden");
              },
              executeModel: async (request, _options, _signal, lifecycle) => {
                lifecycle?.onDispatched();
                calls++;
                const imageSeen = request.messages.some((m) =>
                  m.parts.some((p) => "data" in p),
                );
                return {
                  message: {
                    role: "assistant",
                    parts: [],
                    tool_calls: [
                      {
                        id: randomUUID(),
                        name: imageSeen ? "submit_result" : "view_evidence",
                        arguments: imageSeen
                          ? {
                              confirmed,
                              reason: confirmed
                                ? "The original region reports 97%."
                                : "The digits are unreadable.",
                            }
                          : {},
                      },
                    ],
                  },
                  stop_reason: "tool_calls",
                  provenance: {
                    provider: "fixture",
                    model: "vision",
                    usage: { input_tokens: 20, output_tokens: 5 },
                  },
                };
              },
            },
          },
        ]
      : [],
  );
  const entries = new Map<
    string,
    { id: string; bytes: Uint8Array; media_type: string }
  >();
  const cache: ProofreadCache = {
    read: async (key) => entries.get(key) ?? null,
    save: async (key, bytes, media_type) => {
      entries.set(key, { id: key, bytes, media_type });
      return key;
    },
  };
  const pages: PdfPages = {
    method: "fixture",
    inspect: async () => [],
    image: async () => {
      images++;
      if (imageFailure) throw new Error(imageFailure);
      return {
        media_type: "image/png",
        data: Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
          "base64",
        ),
        width: 1,
        height: 1,
      };
    },
  };
  const content = (value: number): ProcessorContent => ({
    kind: "records",
    schema: { type: "object" },
    records: [
      {
        record_id: "r1",
        payload: { yield: { value, raw: String(value), unit: "%" } },
        evidence: [{ pointer: "/yield", sources: [citation] }],
        missing: {},
      },
    ],
  });
  return {
    content,
    verifier: new ProcessorValueVerifier(
      e.app.documentRead,
      runtime,
      pages,
      cache,
      4,
    ),
    get calls() {
      return calls;
    },
    get images() {
      return images;
    },
    close: async () => {
      await runtime.close();
      await e.close();
    },
  };
}
it("checks every reported number in corrected text without a model call, preserving mismatches as uncertainty", async () => {
  const e = await fixture();
  try {
    const found = await e.verifier.check(
      e.content(97),
      [],
      new AbortController().signal,
    );
    expect(found.checks[0]).toMatchObject({
      pointer: "/yield",
      status: "text-layer",
    });
    const absent = await e.verifier.check(
      e.content(98),
      [],
      new AbortController().signal,
    );
    expect(absent.checks[0]!).toMatchObject({
      status: "uncertain",
      reason: "value-verification-uncertain",
      sources: [expect.objectContaining({ reason: "cited-value-missing" })],
    });
    expect(e.calls).toBe(0);
    expect(e.images).toBe(0);
  } finally {
    await e.close();
  }
});
it.each([true, false])(
  "views the fixed image region and caches the completed visual decision (%s)",
  async (confirmed) => {
    const e = await fixture(true, true, confirmed);
    try {
      const first = await e.verifier.check(
        e.content(97),
        [],
        new AbortController().signal,
      );
      expect(first.checks[0]!.status).toBe(
        confirmed ? "image-checked" : "uncertain",
      );
      expect(first.usage).toEqual({
        calls: 2,
        input_tokens: 40,
        output_tokens: 10,
      });
      const next = await e.verifier.check(
        e.content(97),
        [],
        new AbortController().signal,
      );
      expect(next.checks).toEqual(first.checks);
      expect(first.checks[0]!.sources[0]!.reason).toBe(
        confirmed ? "visual-value-confirmed" : "visual-value-uncertain",
      );
      expect(next.usage.calls).toBe(0);
      expect(e.calls).toBe(2);
    } finally {
      await e.close();
    }
  },
);
it("delivers an unconfigured image-only value as uncertain without a hidden model or render call", async () => {
  const e = await fixture(true);
  try {
    const result = await e.verifier.check(
      e.content(97),
      [],
      new AbortController().signal,
    );
    expect(result.checks[0]!.status).toBe("uncertain");
    expect(e.calls).toBe(0);
    expect(e.images).toBe(0);
  } finally {
    await e.close();
  }
});

it("preserves delivery as uncertain when the configured region renderer is unavailable", async () => {
  const e = await fixture(true, true, true, "proofread-renderer-unavailable");
  try {
    const result = await e.verifier.check(
      e.content(97),
      [],
      new AbortController().signal,
    );
    expect(result.checks[0]).toMatchObject({
      status: "uncertain",
      reason: "value-verification-uncertain",
      sources: [expect.objectContaining({ reason: "pdf-region-unavailable" })],
    });
    expect(e.calls).toBe(0);
  } finally {
    await e.close();
  }
});

it("refuses tampered original images rather than masking an integrity failure as uncertainty", async () => {
  const e = await fixture(true, true, true, "proofread-image-integrity");
  try {
    await expect(
      e.verifier.check(e.content(97), [], new AbortController().signal),
    ).rejects.toThrow("proofread-image-integrity");
    expect(e.calls).toBe(0);
  } finally {
    await e.close();
  }
});
