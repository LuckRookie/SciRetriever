import { describe, expect, it } from "vitest";
import { knowledgeStatementSha256 } from "../src/knowledge.js";
import {
  parseSynthesisContent,
  synthesisStatementSha256,
} from "../src/synthesis.js";
import {
  parseKnowledgeContextRequest,
  parseKnowledgeContextBundle,
} from "../src/knowledge-context.js";

const lit = "00000000-0000-0000-0000-000000000001";
const artifact = "00000000-0000-0000-0000-000000000002";
const generation = "00000000-0000-0000-0000-000000000003";
const hash = "a".repeat(64);
const request = {
  schema_version: 2,
  query: "catalyst",
  scope: { kind: "literatures", literature_ids: [lit] },
  kinds: ["metadata", "document", "knowledge"],
  versions: { kind: "default" },
  knowledge: {
    purposes: ["overview"],
    question: null,
    selection: "all",
    artifact_ids: [],
  },
  budget: { max_items: 5, max_bytes: 4096, token_limit: null },
  continuation: null,
} as const;
function counted<T extends { usage: { bytes: number } }>(value: T): T {
  let result = value;
  for (let i = 0; i < 10; i++) {
    const bytes = Buffer.byteLength(JSON.stringify(result));
    if (bytes === result.usage.bytes) return result;
    result = { ...result, usage: { ...result.usage, bytes } };
  }
  throw new Error("byte count did not converge");
}
describe("Knowledge Context v2 wire", () => {
  it("checks document fragment byte ranges and fixed evidence identity", async () => {
    const selection = parseKnowledgeContextRequest({
      ...request,
      kinds: ["document"],
      knowledge: null,
    });
    const source = {
      kind: "source-text",
      literature_id: lit,
      meta_literature_id: lit,
      reference: {
        kind: "document",
        literature_id: lit,
        document_version_id: generation,
        representation_sha256: hash,
        asset_id: artifact,
        asset_sha256: hash,
        start_utf8: 0,
        end_utf8: 8,
      },
      section_title: null,
      text: "catalyst",
      evidence: [
        {
          schema_version: 1,
          target_kind: "document",
          locator_scheme: "utf8-segment-v1",
          document_version_id: generation,
          representation_sha256: hash,
          locator: { kind: "segment", segment_id: "p1" },
          content_sha256: hash,
        },
      ],
      rank: 1,
      score: -1,
      gap: null,
    };
    const value = counted({
      schema_version: 2,
      score_rule: "weighted-term-frequency-v1",
      items: [source],
      coverage: "complete",
      generations: {
        material: { generation_id: generation, source_revision: 0 },
        knowledge: null,
      },
      gaps: [],
      usage: { bytes: 0, items: 1, tokens: null, tokenizer: null },
      truncated: false,
      continuation: null,
    });
    expect(
      (await parseKnowledgeContextBundle(value, selection)).items,
    ).toHaveLength(1);
    for (const broken of [
      { ...source, reference: { ...source.reference, end_utf8: 7 } },
      {
        ...source,
        evidence: [{ ...source.evidence[0]!, document_version_id: artifact }],
      },
      {
        ...source,
        evidence: [{ ...source.evidence[0]!, content_sha256: null }],
      },
      { ...source, evidence: [source.evidence[0]!, source.evidence[0]!] },
    ])
      await expect(
        parseKnowledgeContextBundle(
          counted({ ...value, items: [broken] }),
          selection,
        ),
      ).rejects.toThrow();
  });
  it("keeps old material request separate and rejects scope expansion or unsupported token counts", () => {
    expect(parseKnowledgeContextRequest(request)).toMatchObject({
      schema_version: 2,
      kinds: ["metadata", "document", "knowledge"],
    });
    expect(() =>
      parseKnowledgeContextRequest({
        ...request,
        scope: { kind: "literatures", literature_ids: [] },
      }),
    ).toThrow();
    expect(() =>
      parseKnowledgeContextRequest({
        ...request,
        budget: {
          ...request.budget,
          token_limit: { tokenizer: "fake", max_tokens: 100 },
        },
      }),
    ).not.toThrow();
    expect(() =>
      parseKnowledgeContextRequest({
        ...request,
        scope: { kind: "artifacts", artifact_ids: [artifact] },
      }),
    ).toThrow();
    expect(
      parseKnowledgeContextRequest({
        ...request,
        scope: { kind: "artifacts", artifact_ids: [artifact] },
        kinds: ["knowledge"],
        knowledge: {
          purposes: ["overview"],
          question: null,
          selection: "explicit",
          artifact_ids: [artifact],
        },
      }),
    ).toMatchObject({ scope: { kind: "artifacts" } });
    expect(() =>
      parseKnowledgeContextRequest({
        ...request,
        knowledge: { ...request.knowledge, question: "another question" },
      }),
    ).toThrow();
    const questionRequest = {
      ...request,
      kinds: ["knowledge"],
      knowledge: {
        purposes: ["question"],
        question: ` e\u0301${"x".repeat(4092)} `,
        selection: "all",
        artifact_ids: [],
      },
    };
    expect(
      parseKnowledgeContextRequest(questionRequest).knowledge?.question,
    ).toBe(`é${"x".repeat(4092)}`);
    expect(() =>
      parseKnowledgeContextRequest({
        ...questionRequest,
        knowledge: {
          ...questionRequest.knowledge,
          question: "x".repeat(4097),
        },
      }),
    ).toThrow();
    expect(
      parseKnowledgeContextRequest({
        ...request,
        continuation: "a".repeat(2048),
      }).continuation,
    ).toHaveLength(2048);
    expect(() =>
      parseKnowledgeContextRequest({
        ...request,
        continuation: "a".repeat(2049),
      }),
    ).toThrow();
  });
  it("counts the whole mixed bundle and preserves generated/source-only identity", async () => {
    const parsed = parseKnowledgeContextRequest(request);
    const value = counted({
      schema_version: 2,
      score_rule: "weighted-term-frequency-v1",
      items: [
        {
          kind: "metadata",
          literature_id: lit,
          meta_literature_id: lit,
          reference: {
            kind: "metadata",
            literature_id: lit,
            metadata_revision: 1,
            metadata_sha256: hash,
          },
          section_title: null,
          text: "catalyst",
          evidence: [],
          rank: 1,
          score: -4,
          gap: null,
        },
        {
          kind: "generated-knowledge",
          reference: {
            kind: "knowledge",
            artifact_id: artifact,
            content_sha256: hash,
            manifest_sha256: hash,
            statement_id: "s1",
            statement_sha256: hash,
          },
          purpose: "overview",
          question: null,
          scope_kind: "literature",
          source_literature_ids: [lit],
          independent_literature_ids: [lit],
          source_state: "source-only",
          source_layers: [
            {
              input_id: "source",
              kind: "document",
              state: "source-only",
              compression_depth: 0,
              source_artifact_id: null,
            },
          ],
          compression_depth: 1,
          coverage_status: "complete",
          statement: null,
          rank: 2,
          score: -1,
          gap: "context-too-large",
        },
      ],
      coverage: "partial",
      generations: {
        material: { generation_id: generation, source_revision: 0 },
        knowledge: { generation_id: generation, source_revision: 0 },
      },
      gaps: [
        { code: "source-only", literature_id: lit, artifact_id: artifact },
        {
          code: "context-too-large",
          literature_id: null,
          artifact_id: artifact,
        },
      ],
      usage: { bytes: 0, items: 2, tokens: null, tokenizer: null },
      truncated: false,
      continuation: null,
    });
    expect((await parseKnowledgeContextBundle(value, parsed)).usage.bytes).toBe(
      Buffer.byteLength(JSON.stringify(value)),
    );
    await expect(
      parseKnowledgeContextBundle(
        { ...value, usage: { ...value.usage, bytes: value.usage.bytes - 1 } },
        parsed,
      ),
    ).rejects.toThrow();
    const offscope = parseKnowledgeContextRequest({
      ...request,
      scope: {
        kind: "literatures",
        literature_ids: ["00000000-0000-0000-0000-000000000009"],
      },
    });
    await expect(
      parseKnowledgeContextBundle(value, offscope),
    ).rejects.toThrow();
    const degraded = counted({
      ...value,
      items: [value.items[0]!],
      generations: { ...value.generations, knowledge: null },
      gaps: [
        {
          code: "knowledge-index-unavailable",
          literature_id: null,
          artifact_id: null,
        },
      ],
      usage: { ...value.usage, bytes: 0, items: 1 },
    });
    expect(
      (await parseKnowledgeContextBundle(degraded, parsed)).items,
    ).toHaveLength(1);
    await expect(
      parseKnowledgeContextBundle(
        counted({
          ...degraded,
          items: value.items,
          usage: { ...degraded.usage, items: 2 },
        }),
        parsed,
      ),
    ).rejects.toThrow();
    const materialDegraded = counted({
      ...value,
      items: [{ ...value.items[1]!, rank: 1 }],
      generations: { material: null, knowledge: value.generations.knowledge },
      gaps: [
        {
          code: "material-index-unavailable",
          literature_id: null,
          artifact_id: null,
        },
        ...value.gaps,
      ],
      usage: { ...value.usage, bytes: 0, items: 1 },
    });
    expect(
      (await parseKnowledgeContextBundle(materialDegraded, parsed)).items,
    ).toHaveLength(1);
    await expect(
      parseKnowledgeContextBundle(
        counted({
          ...materialDegraded,
          items: value.items,
          usage: { ...materialDegraded.usage, items: 2 },
        }),
        parsed,
      ),
    ).rejects.toThrow();
    await expect(
      parseKnowledgeContextBundle(
        counted({ ...value, coverage: "complete", gaps: [] }),
        parsed,
      ),
    ).rejects.toThrow();
  });
  it("validates an expanded generated statement and its complete canonical hash", async () => {
    const selection = parseKnowledgeContextRequest({
      ...request,
      scope: { kind: "artifacts", artifact_ids: [artifact] },
      kinds: ["knowledge"],
      knowledge: {
        purposes: ["overview"],
        question: null,
        selection: "explicit",
        artifact_ids: [artifact],
      },
    });
    const statement = {
      statement_id: "s1",
      category: "result",
      epistemic: "reported",
      text: "Catalyst remains stable at 10 K",
      conditions: ["10 K"],
      quantity: null,
      evidence: [
        {
          schema_version: 1,
          target_kind: "document",
          locator_scheme: "utf8-segment-v1",
          document_version_id: generation,
          representation_sha256: hash,
          locator: { kind: "segment", segment_id: "segment-1" },
          content_sha256: hash,
        },
      ],
    };
    const statementHash = await knowledgeStatementSha256(statement);
    const value = counted({
      schema_version: 2,
      score_rule: "weighted-term-frequency-v1",
      items: [
        {
          kind: "generated-knowledge",
          reference: {
            kind: "knowledge",
            artifact_id: artifact,
            content_sha256: hash,
            manifest_sha256: hash,
            statement_id: "s1",
            statement_sha256: statementHash,
          },
          purpose: "overview",
          question: null,
          scope_kind: "literature",
          source_literature_ids: [lit],
          independent_literature_ids: [lit],
          source_state: "verified",
          source_layers: [
            {
              input_id: "source",
              kind: "document",
              state: "verified",
              compression_depth: 0,
              source_artifact_id: null,
            },
          ],
          compression_depth: 1,
          coverage_status: "complete",
          statement,
          rank: 1,
          score: -2,
          gap: null,
        },
      ],
      coverage: "complete",
      generations: {
        material: null,
        knowledge: { generation_id: generation, source_revision: 0 },
      },
      gaps: [],
      usage: { bytes: 0, items: 1, tokens: null, tokenizer: null },
      truncated: false,
      continuation: null,
    });
    expect(
      (await parseKnowledgeContextBundle(value, selection)).items[0]?.kind,
    ).toBe("generated-knowledge");
    await expect(
      parseKnowledgeContextBundle(
        counted({
          ...value,
          items: [
            {
              ...value.items[0]!,
              reference: {
                ...value.items[0]!.reference,
                statement_sha256: hash,
              },
            },
          ],
        }),
        selection,
      ),
    ).rejects.toThrow();
    for (const changed of [
      { ...statement, conditions: ["20 K"] },
      {
        ...statement,
        quantity: { value: "10", unit: "K", comparison_basis: null },
      },
      {
        ...statement,
        evidence: [
          { ...statement.evidence[0]!, content_sha256: "b".repeat(64) },
        ],
      },
    ])
      await expect(
        parseKnowledgeContextBundle(
          counted({
            ...value,
            items: [{ ...value.items[0]!, statement: changed }],
          }),
          selection,
        ),
      ).rejects.toThrow();
    const disagreement = {
      ...statement,
      relation: "disagreement",
      conflict_group_id: "group-1",
      evidence: [
        {
          input_id: "source",
          target_kind: "document",
          evidence: statement.evidence[0]!,
        },
      ],
    };
    const full = parseSynthesisContent({
      schema_version: 2,
      title: "Contradiction",
      statements: [
        disagreement,
        { ...disagreement, statement_id: "s2", text: "It degrades" },
      ],
    });
    const synthesisSelection = parseKnowledgeContextRequest({
      ...request,
      scope: { kind: "artifacts", artifact_ids: [artifact] },
      kinds: ["knowledge"],
      knowledge: {
        purposes: ["synthesis"],
        question: "How stable?",
        selection: "explicit",
        artifact_ids: [artifact],
      },
    });
    const synthesisValue = counted({
      ...value,
      items: [
        {
          ...value.items[0]!,
          purpose: "synthesis",
          question: "How stable?",
          scope_kind: "manifest",
          statement: full.statements[0]!,
          reference: {
            ...value.items[0]!.reference,
            statement_sha256: await synthesisStatementSha256(
              full.statements[0]!,
            ),
          },
        },
      ],
    });
    expect(
      (await parseKnowledgeContextBundle(synthesisValue, synthesisSelection))
        .items[0]?.kind,
    ).toBe("generated-knowledge");
    const partialDegradedOnly = counted({
      ...synthesisValue,
      coverage: "partial",
      items: [
        {
          ...synthesisValue.items[0]!,
          source_state: "source-only",
          coverage_status: "partial",
          source_layers: [
            {
              ...synthesisValue.items[0]!.source_layers[0]!,
              state: "source-only",
            },
          ],
        },
      ],
      gaps: [
        {
          code: "coverage-partial",
          literature_id: null,
          artifact_id: artifact,
        },
        { code: "source-only", literature_id: lit, artifact_id: artifact },
      ],
    });
    expect(
      (
        await parseKnowledgeContextBundle(
          partialDegradedOnly,
          synthesisSelection,
        )
      ).items,
    ).toHaveLength(1);
    const historicallyExcluded = counted({
      ...synthesisValue,
      coverage: "partial",
      items: [{ ...synthesisValue.items[0]!, coverage_status: "partial" }],
      gaps: [
        {
          code: "coverage-partial",
          literature_id: null,
          artifact_id: artifact,
        },
      ],
    });
    expect(
      (
        await parseKnowledgeContextBundle(
          historicallyExcluded,
          synthesisSelection,
        )
      ).items,
    ).toHaveLength(1);
    const lostOriginalAfterPublication = counted({
      ...synthesisValue,
      coverage: "partial",
      items: [
        {
          ...synthesisValue.items[0]!,
          source_state: "source-only",
          source_layers: [
            {
              ...synthesisValue.items[0]!.source_layers[0]!,
              state: "missing",
            },
          ],
        },
      ],
      gaps: [
        { code: "source-only", literature_id: lit, artifact_id: artifact },
      ],
    });
    expect(
      (
        await parseKnowledgeContextBundle(
          lostOriginalAfterPublication,
          synthesisSelection,
        )
      ).items,
    ).toHaveLength(1);
    await expect(
      parseKnowledgeContextBundle(
        counted({ ...historicallyExcluded, gaps: [] }),
        synthesisSelection,
      ),
    ).rejects.toThrow();
    await expect(
      parseKnowledgeContextBundle(
        counted({
          ...lostOriginalAfterPublication,
          coverage: "complete",
          gaps: [],
        }),
        synthesisSelection,
      ),
    ).rejects.toThrow();
    const largeSelection = parseKnowledgeContextRequest({
      ...synthesisSelection,
      budget: { max_items: 5, max_bytes: 262144, token_limit: null },
    });
    const largeClosure = Array.from(
      { length: 1024 },
      (_, index) =>
        `00000000-0000-0000-0000-${(index + 1).toString(16).padStart(12, "0")}`,
    );
    const largeValue = counted({
      ...synthesisValue,
      items: [
        {
          ...synthesisValue.items[0]!,
          source_literature_ids: largeClosure,
        },
      ],
    });
    expect(
      (await parseKnowledgeContextBundle(largeValue, largeSelection)).items,
    ).toHaveLength(1);
    await expect(
      parseKnowledgeContextBundle(
        counted({
          ...largeValue,
          items: [
            {
              ...largeValue.items[0]!,
              source_literature_ids: [
                ...largeClosure,
                "00000000-0000-0000-0000-000000000401",
              ],
            },
          ],
        }),
        largeSelection,
      ),
    ).rejects.toThrow();
  });
});
