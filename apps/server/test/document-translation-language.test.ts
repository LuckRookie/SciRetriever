import { expect, it } from "vitest";
import type { ArchiveStepReceipt } from "@sciretriever/contracts";
import { createQueryApplication } from "../src/bootstrap/application.js";
import { startQueryOnlyWorkbench } from "../src/bootstrap/workbench.js";
import { executeMaintenance } from "../src/entry/maintenance-operations.js";
import { executeQuery } from "../src/entry/query-operations.js";
import { MAINTENANCE_TOOLS } from "../src/mcp/tools.js";
import { archiveFixture } from "./archive-fixture.js";

// Spec 9.6.1 (ADR 0072): reads name a language; one paper is translated into
// another on request. The fake model only.
const sentences = (topic: string, from: number) =>
  Array.from(
    { length: 5 },
    (_, i) =>
      `The ${topic} sample ${from + i} showed a stable synthetic spectrum near ${400 + from + i} nm in water.`,
  ).join(" ");
/** Long enough for reading layers, whose translation part is the default language. */
const TEXT =
  "# Abstract\n\n" +
  sentences("abstract", 1) +
  "\n\n" +
  ["Introduction", "Methods", "Results", "Conclusion"]
    .map(
      (title, s) =>
        `# ${title}\n\n${sentences(title.toLowerCase(), 10 * s + 10)}\n\n${sentences(`${title.toLowerCase()} second`, 10 * s + 15)}`,
    )
    .join("\n\n") +
  "\n\n# References\n\n[1] Example synthetic reference.\n";
type Fixture = Awaited<ReturnType<typeof archiveFixture>>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = Record<string, any>;

async function fixture() {
  const e = await archiveFixture({ offline: true });
  // No real source or model can be reached: the provider is a closed loopback port.
  expect(e.app.configuration.providers.fixture?.base_url).toBe(
    "http://127.0.0.1:9/v1",
  );
  expect(e.app.configuration.translation.target_language).toBe("zh-Hans");
  e.setText(TEXT);
  return e;
}
/** The fake translator writes this prefix; switched before each language. */
const prefix = (e: Fixture, mark: string) =>
  e.setTranslation((input) => ({
    translations: input.units.map((u) => ({
      id: u.id,
      translation: `${mark}${u.text}`,
    })),
  }));
const main = async (e: Fixture) =>
  (await e.app.archive.status(e.id)).parts.find((p) => p.part === "main")!;
async function query(e: Fixture, operation: string, request: unknown) {
  const q = await createQueryApplication(e.home);
  try {
    return (await executeQuery(q, operation as never, request)) as Loose;
  } catch (error) {
    return error as Loose;
  } finally {
    await q.close();
  }
}
const translate = (e: Fixture, target_language: string) =>
  executeMaintenance(e.app, "document-translate", {
    literature_id: e.id,
    target_language,
  }) as Promise<Loose>;
const estimate = (e: Fixture, target_language: string) =>
  query(e, "usage-estimate", {
    kind: "document-translate",
    request: { literature_id: e.id, target_language },
  });

it("refuses a paper without a proofread full text, with the reason, and estimates nothing for it", async () => {
  const e = await fixture();
  try {
    await expect(translate(e, "ja")).rejects.toMatchObject({
      code: "translation-needs-proofread",
    });
    expect(await estimate(e, "ja")).toMatchObject({
      kind: "document-translate",
      refusal: "translation-needs-proofread",
      components: [{ step: "translate", units: 0 }],
    });
    // Only a known language is accepted.
    await expect(translate(e, "xx")).rejects.toMatchObject({
      name: "ContractValidationError",
    });
    expect(MAINTENANCE_TOOLS.map((t) => t.name)).toContain(
      "translate_document",
    );
  } finally {
    await e.close();
  }
}, 0);

it("reads the language asked for, translates a paper into another on request, then skips it", async () => {
  const e = await fixture();
  try {
    prefix(e, "译文：");
    await e.submit("archive-default");
    expect((await e.app.archive.status(e.id)).status).toBe("READY");
    const part = await main(e),
      document_version_id = part.document_version_id!;
    // Without a language the reads use the library default.
    expect(
      await query(e, "document-describe", { document_version_id }),
    ).toMatchObject({
      translation: { target_language: "zh-Hans", state: "complete" },
      translation_languages: ["zh-Hans"],
    });
    // Another language: nothing stored yet.
    const ja = await query(e, "document-describe", {
      document_version_id,
      target_language: "ja",
    });
    expect(ja.translation).toEqual({
      target_language: "ja",
      state: "none",
      units: 0,
      translated: 0,
    });
    expect(ja.translation_languages).toEqual(["zh-Hans"]);
    const units = (language?: string) =>
      query(e, "document-translation", {
        document_version_id,
        section_id: null,
        limit: 200,
        cursor: null,
        ...(language ? { target_language: language } : {}),
      });
    expect(await units("ja")).toMatchObject({
      target_language: "ja",
      state: "none",
      units: [],
    });
    const whole = async (text: string, language?: string) => {
      const segments = await query(e, "document-segments", {
        document_version_id,
        section_id: null,
        limit: 200,
        cursor: null,
      });
      const end = Math.max(
        ...(segments.segments as { end_utf8: number }[]).map((s) => s.end_utf8),
      );
      return query(e, "document-slice", {
        document_version_id,
        selector: { kind: "range", start_utf8: 0, end_utf8: end },
        max_bytes: 65536,
        continuation: null,
        text,
        ...(language ? { target_language: language } : {}),
      });
    };
    expect(await whole("translation", "ja")).toMatchObject({
      code: "translation-unavailable",
    });
    // Reading layers: the translation part is the default language only.
    const layers = (language?: string) =>
      query(e, "document-layers", {
        document_version_id,
        part: "overview",
        text: "translation",
        ...(language ? { target_language: language } : {}),
      });
    expect(await layers()).toMatchObject({
      machine_translation: true,
      target_language: "zh-Hans",
    });
    expect(await layers("zh-Hans")).toMatchObject({
      target_language: "zh-Hans",
    });
    expect(await layers("ja")).toMatchObject({
      code: "translation-unavailable",
    });
    expect(
      await query(e, "document-layers", {
        document_version_id,
        part: "overview",
        target_language: "ja",
      }),
    ).toMatchObject({ text: "original" });
    const web = await startQueryOnlyWorkbench({
      home: e.home,
      assets: new Map(),
    });
    try {
      const response = await fetch(
        web.origin + "/api/v1/query/document-layers",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-SciRetriever-Protocol-Version": "1",
          },
          body: JSON.stringify({
            protocol_version: 1,
            request: {
              document_version_id,
              part: "overview",
              text: "bilingual",
              target_language: "ja",
            },
          }),
        },
      );
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        code: "translation-unavailable",
      });
    } finally {
      await web.close();
    }
    // The estimate: the translate step alone, by pages and the same history;
    // nothing for the language this content already has.
    const before = await estimate(e, "ja");
    expect(before).toMatchObject({
      kind: "document-translate",
      target_language: "ja",
      refusal: null,
      state: null,
      reused_count: 0,
      available: true,
    });
    expect(before.components).toHaveLength(1);
    expect(before.components[0]).toMatchObject({
      step: "translate",
      unit: "page",
      basis: "matching-history",
    });
    expect(before.components[0].units).toBeGreaterThan(0);
    expect(before.total.input_tokens.median).toBeGreaterThan(0);
    expect(await estimate(e, "zh-Hans")).toMatchObject({
      state: "complete",
      reused_count: 1,
      components: [{ units: 0, input_tokens: { median: 0, p90: 0 } }],
    });
    // Translate into Japanese on request: a task running the translate step only.
    prefix(e, "訳：");
    const calls = e.modelCalls;
    const queued = await translate(e, "ja");
    expect(queued).toMatchObject({
      literature_id: e.id,
      target_language: "ja",
      outcome: "queued",
      state: null,
    });
    await e.app.processingTasks!.run(queued.job.job_id);
    const job = (await e.app.processingTasks!.read(queued.job.job_id)) as Loose;
    expect(job.failures).toEqual([]);
    expect(JSON.stringify(job)).toContain('"outcome":"translated"');
    // One request for the units; no other step called the model.
    expect(e.modelCalls - calls).toBe(1);
    const state = await e.app.archive.status(e.id);
    expect(state.status).toBe("READY");
    const receipt = state.parts
      .find((p) => p.part === "main")!
      .steps.find((s) => s.step === "translate") as ArchiveStepReceipt;
    expect(receipt).toMatchObject({ status: "done", reason: null });
    expect(receipt.output).toMatchObject({
      target_language: "ja",
      translation: { status: "complete", missing: 0 },
    });
    expect(receipt.calls).toBe(1);
    // Now readable in Japanese; the default is unchanged.
    expect(
      await query(e, "document-describe", {
        document_version_id,
        target_language: "ja",
      }),
    ).toMatchObject({
      translation: { target_language: "ja", state: "complete" },
      translation_languages: ["ja", "zh-Hans"],
    });
    const japanese = await units("ja");
    expect(japanese.state).toBe("complete");
    expect(
      japanese.units.every((u: Loose) => u.translation.startsWith("訳：")),
    ).toBe(true);
    expect(
      (await units()).units.every((u: Loose) =>
        u.translation.startsWith("译文："),
      ),
    ).toBe(true);
    const sliced = await whole("bilingual", "ja");
    expect(sliced).toMatchObject({
      machine_translation: true,
      target_language: "ja",
      untranslated_units: 0,
    });
    expect(sliced.text).toContain("訳：The abstract sample 1");
    expect(sliced.text).not.toContain("译文：");
    // The PDF view reads either language; no language is the default.
    expect(await e.app.fullTextTranslation.summary(e.id, null)).toMatchObject({
      target_language: "zh-Hans",
      state: "complete",
    });
    const page = (target_language?: string) =>
      e.app.fullTextTranslation.page({
        literature_id: e.id,
        page_index: 0,
        model: null,
        force: false,
        ...(target_language ? { target_language } : {}),
      });
    expect(await page()).toMatchObject({
      target_language: "zh-Hans",
      saved: true,
    });
    const pdf = await page("ja");
    expect(pdf).toMatchObject({ target_language: "ja", state: "complete" });
    expect(pdf.blocks.some((b) => b.translation?.startsWith("訳："))).toBe(
      true,
    );
    // Reading layers still have only the default language's translation part.
    expect(await layers("ja")).toMatchObject({
      code: "translation-unavailable",
    });
    // A complete translation in the language is skipped without a task.
    expect(await translate(e, "ja")).toEqual({
      literature_id: e.id,
      target_language: "ja",
      outcome: "skipped",
      state: "complete",
      job: null,
    });
    expect(await estimate(e, "ja")).toMatchObject({
      state: "complete",
      reused_count: 1,
    });
    expect(e.modelCalls - calls).toBe(1);
  } finally {
    await e.close();
  }
}, 0);
