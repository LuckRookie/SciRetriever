import { expect, it } from "vitest";
import { createInputManifest } from "@sciretriever/contracts";
import { coreProcessingFixture } from "./core-processing-fixture.js";
import { longRuntime } from "./dsh-long-fixture.js";
import { analyzeDocumentSession } from "../src/analysis/knowledge-session.js";
async function setup(
  text: string,
  options: Parameters<typeof longRuntime>[0] = {},
) {
  const env = await coreProcessingFixture(),
    fake = longRuntime(options);
  try {
    env.setText(text);
    await env.app.documentProcessing.parseDocuments(env.rawParseRequest);
    const corrected = await env.app.proofreading!.build({
      asset_id: env.asset.asset_id,
    });
    expect(corrected.version.status).toBe("complete");
    const published = await env.app.proofreadDocuments.publish({
      literature_id: env.rawParseRequest.literature_id,
      asset_id: env.asset.asset_id,
      proofread_id: corrected.version.proofread_id,
      expected_default_revision: null,
    });
    const document = (
      await env.app.documentRead.describe({
        document_version_id: published.document.document_version_id,
      })
    ).document;
    const input = await createInputManifest([
      {
        input_id: "paper",
        literature_id: env.rawParseRequest.literature_id,
        material: document.source_material_ref,
        document,
        capabilities: [
          "document-text-v1",
          "document-segment-v1",
          "document-resources-v1",
          "material-file-v1",
        ],
        gaps: [],
      },
    ]);
    const source = await env.app.documentRead.withVerifiedVersion(
      document.document_version_id,
      async (_version, bytes) => Buffer.from(bytes).toString(),
    );
    return {
      env,
      fake,
      source,
      run: (signal = new AbortController().signal) =>
        analyzeDocumentSession(
          { input, purpose: "detailed", question: null },
          env.app.documentRead,
          fake.agent,
          { provider: "fixture", model: "synthetic", max_output_tokens: 10000 },
          signal,
        ),
      async close() {
        await fake.agent.close();
        await env.close();
      },
    };
  } catch (error) {
    await fake.agent.close();
    await env.close();
    throw error;
  }
}
function pages(f: Awaited<ReturnType<typeof setup>>) {
  return f.fake.modelCalls
    .at(-1)!
    .messages.filter((m) => m.role === "tool" && m.name === "read_document")
    .flatMap(
      (m) =>
        (
          JSON.parse((m.parts[0] as { text: string }).text) as {
            segments: { text: string }[];
          }
        ).segments,
    )
    .map((s) => s.text)
    .join("");
}
it("reads the full corrected tail and preserves contradictory results and negation", async () => {
  const f = await setup(
    [
      `${"A".repeat(64000)} DRY_RESULT_4.2_eV.`,
      `${"B".repeat(64000)} NEGATED_IMPROVEMENT.`,
      `${"C".repeat(64000)} WET_CONTRADICTION_5.1_eV.`,
    ].join("\n\n"),
  );
  try {
    const result = await f.run();
    expect(pages(f)).toBe(f.source);
    expect(result.source_bytes).toBe(Buffer.byteLength(f.source));
    expect(result.content!.statements.map((s) => s.text)).toEqual([
      "4.2 eV under dry conditions",
      "The treatment did not improve yield",
      "5.1 eV under wet conditions contradicts dry result",
    ]);
    for (const s of result.content!.statements)
      for (const evidence of s.evidence)
        expect(
          (await f.env.app.documentRead.resolveEvidence(evidence)).evidence
            .content_sha256,
        ).toBe(evidence.content_sha256);
  } finally {
    await f.close();
  }
}, 20_000);
it.each([
  `${"中".repeat(30000)}DRY_RESULT_4.2_eV`,
  `${"a".repeat(23999)}😀${"😀".repeat(15000)}DRY_RESULT_4.2_eV`,
  `${"a".repeat(23999)}\n${"中".repeat(30000)}DRY_RESULT_4.2_eV`,
])(
  "preserves UTF-8 across corrected-source read pages %#",
  async (text) => {
    const f = await setup(text);
    try {
      await f.run();
      expect(pages(f)).toBe(f.source);
      expect(pages(f)).not.toContain("�");
    } finally {
      await f.close();
    }
  },
  15000,
);
it("reads more than 8192 corrected blocks without losing the final evidence", async () => {
  const f = await setup(`${"x.\n\n".repeat(8193)}DRY_RESULT_4.2_eV.\n`);
  try {
    const result = await f.run();
    expect(result.segment_count).toBe(8194);
    expect(pages(f)).toBe(f.source);
    const evidence = await f.env.app.documentRead.resolveEvidence(
      result.content!.statements[0]!.evidence[0]!,
    );
    expect("text" in evidence ? evidence.text : null).toContain(
      "DRY_RESULT_4.2_eV",
    );
  } finally {
    await f.close();
  }
}, 30000);
it("retains an unresolved segment declaration without rewriting the summary", async () => {
  const f = await setup("DRY_RESULT_4.2_eV.", { invalidEvidence: true });
  try {
    const result = await f.run();
    expect(result.content!.statements).toHaveLength(1);
    expect(result.content!.statements[0]!.evidence).toMatchObject([
      { locator: { segment_id: "forged" }, content_sha256: null },
    ]);
    expect(f.fake.calls).toHaveLength(1);
  } finally {
    await f.close();
  }
});
it.each([
  [{ invalidQuantity: true }, "knowledge-response"],
  [{ notApplicable: true }, "knowledge-not-applicable"],
  [{ outputTokens: Number.NaN }, "knowledge-response"],
] as const)(
  "rejects invalid DSH submissions and usage %#",
  async (options, code) => {
    const f = await setup("DRY_RESULT_4.2_eV.", options);
    try {
      await expect(f.run()).rejects.toMatchObject({ code });
      expect((await f.env.app.processorRead!.list()).items).toEqual([]);
    } finally {
      await f.close();
    }
  },
  15000,
);
it("cancels a continuing DSH read before any result is published", async () => {
  const stop = new AbortController(),
    f = await setup(`${"A".repeat(64000)}DRY_RESULT_4.2_eV.`, {
      onModel: (_request, index) => {
        if (index === 3) stop.abort();
      },
    });
  try {
    await expect(f.run(stop.signal)).rejects.toMatchObject({
      code: "knowledge-cancelled",
    });
    expect((await f.env.app.processorRead!.list()).items).toEqual([]);
  } finally {
    await f.close();
  }
}, 0);
it("binds distant conditions and preserves bilingual negation", async () => {
  const f = await setup(
    `CONDITION_DRY_ONLY${"A".repeat(65536)}.\n\nMEASURE_4.2_eV.\n\nCANNOT_REDUCE.\n\nCHINESE_NEGATION.\n\nAFFIRMATIVE_CONTROL.`,
  );
  try {
    const result = await f.run();
    expect(result.content!.statements.map((s) => s.text)).toEqual([
      "It cannot reduce energy",
      "结果未显著改善",
      "The control improved yield",
      "4.2 eV under dry-only conditions",
    ]);
    const measured = result.content!.statements.at(-1)!;
    expect(measured.conditions).toEqual(["dry only"]);
    expect(measured.evidence).toHaveLength(2);
  } finally {
    await f.close();
  }
}, 20_000);
