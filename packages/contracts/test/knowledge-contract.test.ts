import { describe, expect, it } from "vitest";
import {
  createInputManifest,
  knowledgeComparisonSha256,
  knowledgeContentBytes,
  parseDocumentMaterialRef,
  parseDocumentReadingRef,
  parseKnowledgeContent,
  parseKnowledgeAnalysisReceipt,
  parseKnowledgeLongAnalysisRequest,
  parseKnowledgeArtifact,
  parseKnowledgeDefaultResult,
  parseKnowledgeDefaultSelection,
  parseKnowledgeListResult,
  parseKnowledgeListSelection,
  parseKnowledgeReadResult,
  parseKnowledgeReadSelection,
  sha256,
} from "../src/index.js";

const uuid = (n: number) =>
  `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const h = (digit: string) => digit.repeat(64);
const literature = uuid(1);
const material = parseDocumentMaterialRef({
  literature_id: literature,
  asset_id: uuid(2),
  asset_sha256: h("a"),
  media_type: "application/pdf",
  byte_size: 12,
  artifact: { sha256: h("a"), byte_size: 12, media_type: "application/pdf" },
});
const document = parseDocumentReadingRef({
  document_id: uuid(3),
  document_version_id: uuid(4),
  representation_sha256: h("b"),
  source_material_ref: material,
  locator_scheme: "utf8-segment-v1" as const,
});
async function fixture() {
  const input = await createInputManifest([
    {
      input_id: "one",
      literature_id: literature,
      material,
      document,
      capabilities: [
        "material-file-v1",
        "document-segment-v1",
        "document-text-v1",
      ],
      gaps: [],
    },
  ]);
  const content = {
    schema_version: 1,
    title: "Synthetic finding",
    statements: [
      {
        statement_id: "s1",
        category: "result",
        epistemic: "reported",
        text: "A result",
        conditions: [],
        quantity: null,
        evidence: [
          {
            schema_version: 1,
            target_kind: "document",
            locator_scheme: "utf8-segment-v1",
            document_version_id: document.document_version_id,
            representation_sha256: document.representation_sha256,
            locator: { kind: "segment", segment_id: "segment-1" },
            content_sha256: h("c"),
          },
        ],
      },
    ],
  };
  const bytes = knowledgeContentBytes(parseKnowledgeContent(content));
  const method = {
    id: "single-document-knowledge",
    version: "1",
    parameters_sha256: h("d"),
    model_binding_sha256: h("e"),
  };
  const comparison_sha256 = await knowledgeComparisonSha256({
    manifest_sha256: input.manifest_sha256,
    purpose: "overview",
    question: null,
    method,
  });
  const artifact = {
    schema_version: 1,
    artifact_id: `${comparison_sha256.slice(0, 8)}-${comparison_sha256.slice(8, 12)}-${comparison_sha256.slice(12, 16)}-${comparison_sha256.slice(16, 20)}-${comparison_sha256.slice(20, 32)}`,
    comparison_sha256,
    purpose: "overview",
    question: null,
    input,
    method,
    content_ref: {
      sha256: await sha256(bytes),
      byte_size: bytes.length,
      media_type: "application/vnd.sciretriever.knowledge+json",
    },
    content,
    coverage: {
      status: "complete",
      input_id: "one",
      document_version_id: document.document_version_id,
      total_segments: 1,
      covered_segments: 1,
      total_utf8_bytes: 8,
      covered_utf8_bytes: 8,
      capability_gaps: [],
    },
    provenance: {
      provider: "fixture",
      model: "synthetic",
      generated_at: "2026-09-29T00:00:00.000Z",
      input_tokens: 1,
      output_tokens: 1,
    },
  };
  return artifact;
}

describe("single-document knowledge contracts", () => {
  it("binds comparison, UUID, evidence and canonical time to one complete input", async () => {
    const artifact = await fixture();
    expect(await parseKnowledgeArtifact(artifact)).toMatchObject({
      artifact_id: artifact.artifact_id,
    });
    await expect(
      parseKnowledgeArtifact({ ...artifact, purpose: "synthesis" }),
    ).rejects.toThrow();
    await expect(
      parseKnowledgeArtifact({ ...artifact, comparison_sha256: h("f") }),
    ).rejects.toThrow();
    await expect(
      parseKnowledgeArtifact({ ...artifact, artifact_id: uuid(9) }),
    ).rejects.toThrow();
    await expect(
      parseKnowledgeArtifact({
        ...artifact,
        provenance: {
          ...artifact.provenance,
          generated_at: "2026-02-31T00:00:00.000Z",
        },
      }),
    ).rejects.toThrow();
    const changedContent = structuredClone(artifact.content);
    changedContent.statements[0]!.evidence[0]!.document_version_id = uuid(9);
    const bytes = knowledgeContentBytes(parseKnowledgeContent(changedContent));
    await expect(
      parseKnowledgeArtifact({
        ...artifact,
        content: changedContent,
        content_ref: {
          ...artifact.content_ref,
          sha256: await sha256(bytes),
          byte_size: bytes.length,
        },
      }),
    ).rejects.toThrow();
    const multi = await createInputManifest([
      ...artifact.input.items,
      { ...artifact.input.items[0]!, input_id: "two" },
    ]);
    await expect(
      parseKnowledgeArtifact({ ...artifact, input: multi }),
    ).rejects.toThrow();
  });

  it("rejects selector and result misbinding, including default and receipt", async () => {
    const artifact = await fixture();
    const read = parseKnowledgeReadSelection({
      artifact_id: artifact.artifact_id,
    });
    expect(await parseKnowledgeReadResult(artifact, read)).toMatchObject({
      artifact_id: read.artifact_id,
    });
    await expect(
      parseKnowledgeReadResult(artifact, { artifact_id: uuid(9) }),
    ).rejects.toThrow();
    const list = parseKnowledgeListSelection({
      literature_id: literature,
      limit: 1,
    });
    expect(await parseKnowledgeListResult([artifact], list)).toHaveLength(1);
    await expect(
      parseKnowledgeListResult([artifact, artifact], list),
    ).rejects.toThrow();
    await expect(
      parseKnowledgeListResult([artifact], {
        literature_id: uuid(9),
        limit: 1,
      }),
    ).rejects.toThrow();
    const selection = parseKnowledgeDefaultSelection({
      literature_id: literature,
      purpose: "overview",
      question: null,
    });
    await expect(
      parseKnowledgeDefaultResult(
        { revision: 1, artifact },
        { ...selection, literature_id: uuid(9) },
      ),
    ).rejects.toThrow();
    const receipt = {
      schema_version: 1,
      artifact,
      published: true,
      default_updated: false,
      default_revision: null,
      default_update_outcome: "not-requested",
      default_update_failure: null,
    };
    await expect(
      parseKnowledgeAnalysisReceipt(receipt, {
        schema_version: 1,
        input: artifact.input,
        purpose: "overview",
        question: null,
        default_update: { expected_revision: null },
        budget: { max_input_bytes: 1, max_output_tokens: 1 },
      }),
    ).rejects.toThrow();
    await expect(
      parseKnowledgeAnalysisReceipt({
        ...receipt,
        default_update_outcome: "failed",
      }),
    ).rejects.toThrow();
  });
  it("keeps v2 long budgets separate while reading method-neutral v1 artifacts", async () => {
    const original = await fixture();
    const request = await parseKnowledgeLongAnalysisRequest({
      schema_version: 2,
      input: original.input,
      purpose: "overview",
      question: null,
      default_update: null,
      budget: {
        max_source_bytes: 8 * 1024 * 1024,
        max_call_bytes: 256 * 1024,
        max_total_call_bytes: 32 * 1024 * 1024,
        max_calls: 256,
        max_output_tokens_per_call: 2048,
        max_total_output_tokens: 524288,
      },
    });
    expect(request.budget.max_source_bytes).toBe(8 * 1024 * 1024);
    await expect(
      parseKnowledgeLongAnalysisRequest({ ...request, schema_version: 1 }),
    ).rejects.toThrow();
    await expect(
      parseKnowledgeLongAnalysisRequest({
        ...request,
        budget: { ...request.budget, max_input_bytes: 200000 },
      }),
    ).rejects.toThrow();
    const method = {
      ...original.method,
      id: "single-document-knowledge-long",
      version: "2",
    };
    const comparison = await knowledgeComparisonSha256({
      manifest_sha256: original.input.manifest_sha256,
      purpose: "overview",
      question: null,
      method,
    });
    const artifact = {
      ...original,
      method,
      comparison_sha256: comparison,
      artifact_id: `${comparison.slice(0, 8)}-${comparison.slice(8, 12)}-${comparison.slice(12, 16)}-${comparison.slice(16, 20)}-${comparison.slice(20, 32)}`,
    };
    expect(await parseKnowledgeArtifact(artifact)).toMatchObject({ method });
    const receipt = {
      schema_version: 1,
      artifact,
      published: true,
      default_updated: false,
      default_revision: null,
      default_update_outcome: "not-requested",
      default_update_failure: null,
    };
    expect(await parseKnowledgeAnalysisReceipt(receipt, request)).toMatchObject(
      { artifact: { method } },
    );
    expect(await parseKnowledgeArtifact(original)).toMatchObject({
      method: original.method,
    });
  });
});
