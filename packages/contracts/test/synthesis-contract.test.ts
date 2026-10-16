import { describe, expect, it } from "vitest";
import {
  createSynthesisInputManifest,
  parseSynthesisInputManifest,
  parseKnowledgeSynthesisRequest,
  parseSynthesisArtifact,
  parseSynthesisCoverage,
  synthesisComparisonSha256,
  synthesisContentBytes,
  synthesisStatementSha256,
  sha256,
} from "../src/index.js";

const id = (n: number) =>
  `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const h = (char: string) => char.repeat(64);
const budget = {
  max_source_bytes: 8 * 1024 * 1024,
  max_verification_bytes: 64 * 1024 * 1024,
  max_call_bytes: 256 * 1024,
  max_total_call_bytes: 64 * 1024 * 1024,
  max_calls: 256,
  max_output_tokens_per_call: 16384,
  max_total_output_tokens: 1024 * 1024,
};
describe("synthesis contracts", () => {
  it("preserves v2 input order and accepts a source-only partial with 128-character input IDs", async () => {
    const first = `a${"x".repeat(127)}`;
    const manifest = await createSynthesisInputManifest([
      {
        kind: "knowledge",
        input_id: first,
        source_artifact_id: id(1),
        source_content_sha256: h("a"),
        source_manifest_sha256: h("b"),
        compression_depth: 1,
        state: "source-only",
      },
      {
        kind: "knowledge",
        input_id: "later",
        source_artifact_id: id(2),
        source_content_sha256: null,
        source_manifest_sha256: null,
        compression_depth: null,
        state: "missing",
      },
    ]);
    expect(
      (await parseSynthesisInputManifest(manifest)).items.map(
        (item) => item.input_id,
      ),
    ).toEqual([first, "later"]);
    const reversed = await createSynthesisInputManifest(
      [...manifest.items].reverse(),
    );
    expect(reversed.manifest_sha256).not.toBe(manifest.manifest_sha256);
    const request = await parseKnowledgeSynthesisRequest({
      schema_version: 3,
      input: manifest,
      purpose: "synthesis",
      question: "  Conditions?  ",
      policy: "allow-partial",
      budget,
    });
    expect(request.question).toBe("Conditions?");
    expect(
      parseSynthesisCoverage(
        {
          schema_version: 2,
          status: "partial",
          policy: "allow-partial",
          unique_literature_count: 1,
          items: [
            {
              input_id: first,
              status: "degraded",
              reason: "original-unavailable",
            },
            {
              input_id: "later",
              status: "excluded",
              reason: "knowledge-missing",
            },
          ],
        },
        manifest,
      ).items[0]?.status,
    ).toBe("degraded");
    expect(() =>
      parseSynthesisCoverage(
        {
          schema_version: 2,
          status: "partial",
          policy: "require-all",
          unique_literature_count: 1,
          items: [
            {
              input_id: first,
              status: "degraded",
              reason: "original-unavailable",
            },
            {
              input_id: "later",
              status: "excluded",
              reason: "knowledge-missing",
            },
          ],
        },
        manifest,
      ),
    ).toThrow();
    const wrongReason = {
      schema_version: 2,
      status: "partial",
      policy: "allow-partial",
      unique_literature_count: 1,
      items: [
        { input_id: first, status: "degraded", reason: "original-unavailable" },
        { input_id: "later", status: "excluded", reason: "material-missing" },
      ],
    };
    expect(() => parseSynthesisCoverage(wrongReason, manifest)).toThrow();
    const documentManifest = await createSynthesisInputManifest([
      {
        kind: "document",
        input_id: "doc",
        literature_id: id(5),
        material: null,
        document: null,
        capabilities: [],
        gaps: ["material-missing", "document-missing"],
      },
      manifest.items[0]!,
    ]);
    expect(() =>
      parseSynthesisCoverage(
        {
          ...wrongReason,
          items: [
            {
              input_id: "doc",
              status: "excluded",
              reason: "knowledge-missing",
            },
            {
              input_id: first,
              status: "degraded",
              reason: "original-unavailable",
            },
          ],
        },
        documentManifest,
      ),
    ).toThrow();
  });
  it("hashes a valid statement above 64 KiB with the shared statement limit", async () => {
    const statement = {
      statement_id: "s1",
      category: "finding" as const,
      epistemic: "inference" as const,
      relation: "consensus" as const,
      conflict_group_id: null,
      text: "x".repeat(4096),
      conditions: Array(8).fill("q".repeat(1024)) as string[],
      quantity: null,
      evidence: Array.from({ length: 128 }, (_, n) => ({
        input_id: `i${String(n).padStart(3, "0")}${"a".repeat(123)}`,
        target_kind: "knowledge" as const,
        source_artifact_id: id(1),
        source_content_sha256: h("a"),
        statement_id: `s${"b".repeat(126)}`,
        statement_sha256: h("c"),
      })),
    };
    expect(
      new TextEncoder().encode(JSON.stringify(statement)).length,
    ).toBeGreaterThan(64 * 1024);
    expect(await synthesisStatementSha256(statement)).toMatch(/^[a-f0-9]{64}$/);
  });
  it("parses a large input envelope without an arbitrary support-count cutoff", async () => {
    const items = Array.from({ length: 128 }, (_, n) => ({
      kind: "knowledge" as const,
      input_id: `paper-${n}-${"q".repeat(100)}`,
      source_artifact_id: id(n + 1),
      source_content_sha256: h("a"),
      source_manifest_sha256: h("b"),
      compression_depth: 1,
      state: "verified" as const,
    }));
    const manifest = await createSynthesisInputManifest(items);
    const evidence = items.map((item) => ({
      input_id: item.input_id,
      target_kind: "knowledge" as const,
      source_artifact_id: item.source_artifact_id,
      source_content_sha256: h("a"),
      statement_id: "s1",
      statement_sha256: h("c"),
    }));
    const statements = Array.from({ length: 4 }, (_, n) => ({
      statement_id: `s${n}`,
      category: "finding",
      epistemic: "inference",
      relation: "consensus",
      conflict_group_id: null,
      text: `Claim ${n}`,
      conditions: [],
      quantity: null,
      evidence,
    }));
    const content = {
      schema_version: 2 as const,
      title: "Synthetic comparison",
      statements,
    };
    const bytes = synthesisContentBytes(
      content as Parameters<typeof synthesisContentBytes>[0],
    );
    const method = {
      id: "synthetic",
      version: "1",
      parameters_sha256: h("d"),
      model_binding_sha256: h("e"),
    };
    const comparison = await synthesisComparisonSha256({
      manifest_sha256: manifest.manifest_sha256,
      question: "Conditions?",
      policy: "allow-partial",
      method,
    });
    const artifact = {
      schema_version: 2,
      artifact_id: `${comparison.slice(0, 8)}-${comparison.slice(8, 12)}-${comparison.slice(12, 16)}-${comparison.slice(16, 20)}-${comparison.slice(20, 32)}`,
      comparison_sha256: comparison,
      purpose: "synthesis",
      question: "Conditions?",
      input: manifest,
      method,
      content_ref: {
        sha256: await sha256(bytes),
        byte_size: bytes.length,
        media_type: "application/vnd.sciretriever.knowledge+json",
      },
      content,
      coverage: {
        schema_version: 2,
        status: "complete",
        policy: "allow-partial",
        unique_literature_count: 128,
        items: items.map((item) => ({
          input_id: item.input_id,
          status: "included",
          reason: null,
        })),
      },
      provenance: {
        provider: "fake",
        model: "fake",
        generated_at: "2026-09-29T00:00:00.000Z",
        input_tokens: 1,
        output_tokens: 1,
      },
      compression_depth: 2,
    };
    expect(
      (await parseSynthesisArtifact(artifact)).content.statements,
    ).toHaveLength(4);
    expect(() =>
      synthesisContentBytes({
        ...content,
        statements: [
          ...statements,
          { ...statements[0], statement_id: "s5", evidence: [evidence[0]] },
        ],
      } as Parameters<typeof synthesisContentBytes>[0]),
    ).not.toThrow();
  });
});
