import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import type { ArchiveStepReceipt } from "@sciretriever/contracts";
import { createQueryApplication } from "../src/bootstrap/application.js";
import { runCli } from "../src/cli/main.js";
import { executeQuery } from "../src/entry/query-operations.js";
import { SqliteArchiveTextStorage } from "../src/storage/archive-text.js";
import { alreadyInLanguage } from "../src/translation/document.js";
import { splitTranslation } from "../src/translation/fulltext.js";
import { archiveFixture } from "./archive-fixture.js";

// Spec 9.8: the translate step and its reads, with the fake model only.
const TEXT =
  "# Abstract\n\nFixture Author studies synthetic spectroscopy where $E_{1}=h\\nu$ holds.\n\n# Introduction\n\nA complete synthetic study.\n\n# Conclusion\n\nSpectroscopy is the main theme.\n\n# References\n\n[1] Example synthetic reference.\n";
type Fixture = Awaited<ReturnType<typeof archiveFixture>>;
type Units = readonly { id: string; text: string }[];

async function fixture(
  options: Parameters<typeof archiveFixture>[0] = {},
): Promise<Fixture & { requests: string[][] }> {
  const e = await archiveFixture({ offline: true, ...options });
  // No real source or model can be reached: the provider is a closed loopback port.
  expect(e.app.configuration.providers.fixture?.base_url).toBe(
    "http://127.0.0.1:9/v1",
  );
  expect(Object.keys(e.app.configuration.models)).toEqual(["fixture/model"]);
  e.setText(TEXT);
  const requests: string[][] = [];
  e.setTranslation((input) => {
    requests.push(input.units.map((u) => u.text));
    return reply(input.units);
  });
  return Object.assign(e, { requests });
}
const reply = (
  units: Units,
  skip: (text: string) => boolean = () => false,
) => ({
  translations: units
    .filter((u) => !skip(u.text))
    .map((u) => ({ id: u.id, translation: `译文：${u.text}` })),
});
const main = async (e: Fixture) =>
  (await e.app.archive.status(e.id)).parts.find((p) => p.part === "main")!;
const step = async (e: Fixture) =>
  (await main(e)).steps.find((s) => s.step === "translate") as
    | ArchiveStepReceipt
    | undefined;
async function whole(e: Fixture, document_version_id: string) {
  const q = await createQueryApplication(e.home);
  try {
    const segments = (await executeQuery(q, "document-segments", {
      document_version_id,
      section_id: null,
      limit: 200,
      cursor: null,
    })) as { segments: { end_utf8: number }[] };
    const end = Math.max(...segments.segments.map((s) => s.end_utf8));
    const read = (text?: string) =>
      executeQuery(q, "document-slice", {
        document_version_id,
        selector: { kind: "range", start_utf8: 0, end_utf8: end },
        max_bytes: 65536,
        continuation: null,
        ...(text ? { text } : {}),
      }) as Promise<Record<string, unknown> & { text: string }>;
    return {
      original: await read(),
      translation: await read("translation").catch((e: unknown) => e),
      bilingual: await read("bilingual").catch((e: unknown) => e),
      describe: (await executeQuery(q, "document-describe", {
        document_version_id,
      })) as { translation?: Record<string, unknown> },
      units: (await executeQuery(q, "document-translation", {
        document_version_id,
        section_id: null,
        limit: 200,
        cursor: null,
      })) as {
        state: string;
        units: {
          unit_id: string;
          segment_ids: string[];
          translation: string | null;
        }[];
      },
    };
  } finally {
    await q.close();
  }
}

it("translates every unit, reads the original, the translation and both, and never translates again", async () => {
  const e = await fixture();
  try {
    await e.submit("translate-all");
    const state = await e.app.archive.status(e.id);
    expect(state.status).toBe("READY");
    const receipt = (await step(e))!;
    expect(receipt).toMatchObject({ status: "done", reason: null });
    expect(receipt.output.translation).toMatchObject({
      status: "complete",
      missing: 0,
      reused: 0,
    });
    expect(receipt.calls).toBe(1);
    expect(receipt.input_tokens).toBe(100);
    const part = await main(e),
      read = await whole(e, part.document_version_id!);
    const total = (receipt.output.translation as { units: number }).units;
    expect(read.describe.translation).toEqual({
      target_language: "zh-Hans",
      state: "complete",
      units: total,
      translated: total,
    });
    // References and their heading keep the print; a merged paragraph is one unit.
    expect(read.units.state).toBe("complete");
    expect(read.units.units).toHaveLength(total);
    expect(
      read.units.units.every((u) => u.translation?.startsWith("译文：")),
    ).toBe(true);
    expect(
      read.units.units.some((u) => /Reference/u.test(u.translation!)),
    ).toBe(false);
    expect(read.original.text).toContain("A complete synthetic study.");
    expect(read.original).not.toHaveProperty("machine_translation");
    const translated = read.translation as typeof read.original;
    expect(translated).toMatchObject({
      machine_translation: true,
      target_language: "zh-Hans",
      untranslated_units: 0,
      evidence: [],
      actual_range: read.original.actual_range,
    });
    expect(translated.text).toContain("译文：A complete synthetic study.");
    expect(translated.text).not.toContain("\nA complete synthetic study.");
    expect(translated.text).toContain("$E_{1}=h\\nu$");
    expect(translated.text).toContain("[1] Example synthetic reference.");
    // Structure marks are those of the original: the same heading levels.
    expect(translated.text.match(/^#+ /gmu)).toEqual(
      read.original.text.match(/^#+ /gmu),
    );
    const both = (read.bilingual as typeof read.original).text;
    expect(both).toContain(
      "A complete synthetic study.\n\n译文：A complete synthetic study.",
    );
    expect(both.match(/\[1\] Example synthetic reference\./gu)).toHaveLength(1);
    // A heading keeps its one original heading line; its translation follows
    // as plain text, so the outline is not doubled.
    expect(both).toContain(
      "## Introduction\n\n译文：Introduction\n\nA complete synthetic study.",
    );
    expect(both.match(/^#+ /gmu)).toEqual(read.original.text.match(/^#+ /gmu));
    // The same contract through the CLI.
    let out = "";
    const cli = await runCli(["document", "translation", "--request", "-"], {
      home: e.home,
      stdin: (async function* () {
        yield Buffer.from(
          JSON.stringify({
            document_version_id: part.document_version_id,
            section_id: null,
            limit: 1,
            cursor: null,
          }),
        );
      })(),
      stdout: (s) => {
        out += s;
      },
    });
    expect(cli.code).toBe(0);
    expect(JSON.parse(out).result).toMatchObject({
      machine_translation: true,
      total,
      units: [read.units.units[0]],
    });
    // Archiving again reuses every step: no model call at all.
    const calls = e.modelCalls;
    await e.submit("translate-again");
    expect(e.modelCalls).toBe(calls);
    expect((await step(e))!.output.usage).toMatchObject({ calls: 0 });
  } finally {
    await e.close();
  }
}, 0);

it("keeps the full text ready when a unit is missing and resumes with that unit only", async () => {
  const e = await fixture();
  try {
    e.setTranslation((input) => {
      e.requests.push(input.units.map((u) => u.text));
      return reply(input.units, (t) => t.includes("complete synthetic study"));
    });
    await e.submit("translate-partial");
    const state = await e.app.archive.status(e.id);
    expect(state.status).toBe("READY");
    // The missing unit was asked a second time, alone.
    expect(e.requests.at(-1)).toEqual(["A complete synthetic study."]);
    const failed = (await step(e))!;
    expect(failed).toMatchObject({
      status: "failed",
      reason: "translation-incomplete",
    });
    expect(failed.output.translation).toMatchObject({
      status: "partial",
      missing: 1,
    });
    expect(state.issues).toContainEqual(
      expect.objectContaining({
        step: "translate",
        reason: "translation-incomplete",
        affects_readiness: false,
        resolution: null,
      }),
    );
    // The steps after it still ran.
    for (const name of ["metadata", "references", "tags"])
      expect((await main(e)).steps.find((s) => s.step === name)?.status).toBe(
        "done",
      );
    const part = await main(e),
      read = await whole(e, part.document_version_id!);
    expect(read.describe.translation).toMatchObject({ state: "partial" });
    const partial = read.translation as {
      text: string;
      untranslated_units: number;
    };
    expect(partial.untranslated_units).toBe(1);
    expect(partial.text).toContain("\nA complete synthetic study.");
    expect(read.units.units.filter((u) => u.translation === null)).toHaveLength(
      1,
    );
    // Resume: only the missing unit is asked; earlier steps call no model.
    e.setTranslation((input) => {
      e.requests.push(input.units.map((u) => u.text));
      return reply(input.units);
    });
    const calls = e.modelCalls,
      asked = e.requests.length;
    await e.submit("translate-resume");
    expect(e.modelCalls - calls).toBe(1);
    expect(e.requests.slice(asked)).toEqual([["A complete synthetic study."]]);
    expect((await step(e))!.output.translation).toMatchObject({
      status: "complete",
      requested: 1,
    });
    expect(
      (await e.app.archive.status(e.id)).issues.find(
        (i) => i.step === "translate",
      )?.resolution,
    ).toBe("continue");
  } finally {
    await e.close();
  }
}, 0);

it("counts a unit whose formula came back changed as not translated", async () => {
  const e = await fixture();
  try {
    e.setTranslation((input) => {
      e.requests.push(input.units.map((u) => u.text));
      return {
        translations: input.units.map((u) => ({
          id: u.id,
          translation: `译文：${u.text.replace("h\\nu", "h\\mu")}`,
        })),
      };
    });
    await e.submit("translate-formula");
    expect(await step(e)).toMatchObject({
      status: "failed",
      reason: "translation-incomplete",
    });
    const asked = e.requests.flat().filter((t) => t.includes("$E_{1}=h\\nu$"));
    expect(asked).toHaveLength(2);
    expect((await e.app.archive.status(e.id)).status).toBe("READY");
  } finally {
    await e.close();
  }
}, 0);

it("reads stale after the text changes, then translates only the changed unit", async () => {
  const e = await fixture();
  try {
    await e.submit("translate-before-edit");
    const before = await main(e);
    const current = (await new SqliteArchiveTextStorage(
      e.app.database,
      e.app.files,
    ).load(before.proofread_id!))!;
    const text = await e.app.proofreading!.editor({
      asset_id: before.asset_id,
    });
    await e.app.archiveArrangement.save(
      {
        schema_version: 2,
        literature_id: e.id,
        asset_id: before.asset_id,
        proofread_id: before.proofread_id,
        expected_arrangement_id: current.version.arrangement_id,
        expected_manual_revision: 0,
        markdown: text.text.replace(
          "A complete synthetic study.",
          "A checked synthetic study.",
        ),
        actor: "fixture-user",
      },
      "fixture-user",
    );
    const edited = await main(e);
    expect(edited.document_version_id).not.toBe(before.document_version_id);
    const stale = await whole(e, edited.document_version_id!);
    expect(stale.describe.translation).toEqual({
      target_language: "zh-Hans",
      state: "stale",
      units: 0,
      translated: 0,
    });
    expect(stale.units).toMatchObject({ state: "stale", units: [] });
    expect(stale.translation).toMatchObject({
      code: "translation-unavailable",
    });
    expect(stale.bilingual).toMatchObject({ code: "translation-unavailable" });
    // The old version keeps its own translation.
    expect(
      (await whole(e, before.document_version_id!)).describe.translation,
    ).toMatchObject({ state: "complete" });
    const asked = e.requests.length;
    await e.submit("translate-after-edit");
    expect(e.requests.slice(asked)).toEqual([["A checked synthetic study."]]);
    const output = (await step(e))!.output.translation as {
      reused: number;
      units: number;
    };
    expect(output.reused).toBe(output.units - 1);
    expect(
      (await whole(e, edited.document_version_id!)).describe.translation,
    ).toMatchObject({ state: "complete" });
  } finally {
    await e.close();
  }
}, 0);

it("does not translate a paper already in the target language", async () => {
  const e = await fixture({
    configurationText: '[translation]\ntarget_language="en"\n',
  });
  try {
    await e.submit("translate-same-language");
    expect(e.requests).toEqual([]);
    const receipt = (await step(e))!;
    expect(receipt).toMatchObject({ status: "done", calls: 0 });
    expect(receipt.output.translation).toMatchObject({
      status: "same-language",
    });
    const read = await whole(e, (await main(e)).document_version_id!);
    expect(read.describe.translation).toMatchObject({
      target_language: "en",
      state: "same-language",
      translated: 0,
    });
    expect(read.translation).toMatchObject({
      machine_translation: false,
      text: read.original.text,
    });
  } finally {
    await e.close();
  }
  // Without a bibliographic language, the majority writing system decides.
  expect(alreadyInLanguage("zh-Hans", null, ["这是一篇中文论文。"])).toBe(true);
  expect(alreadyInLanguage("zh-Hans", null, ["An English paper."])).toBe(false);
  expect(alreadyInLanguage("en", null, ["Eine deutsche Arbeit."])).toBe(true);
  expect(alreadyInLanguage("ja", null, ["これは日本語の論文です。"])).toBe(
    true,
  );
  expect(alreadyInLanguage("ja", null, ["这是中文。"])).toBe(false);
  expect(alreadyInLanguage("zh-Hans", "zh-CN", ["An English abstract."])).toBe(
    true,
  );
  expect(alreadyInLanguage("en", "German", ["An English abstract."])).toBe(
    false,
  );
});

it("has no translation for a draft and never resolves evidence from translated text", async () => {
  const e = await fixture();
  try {
    await e.app.documentProcessing.parseDocuments(e.rawParseRequest);
    const draft = await main(e);
    expect(draft.text_level).toBe("draft");
    const none = await whole(e, draft.document_version_id!);
    expect(none.describe.translation).toEqual({
      target_language: "zh-Hans",
      state: "none",
      units: 0,
      translated: 0,
    });
    expect(none.units).toMatchObject({ state: "none", units: [] });
    expect(none.translation).toMatchObject({ code: "translation-unavailable" });
    await e.submit("translate-evidence");
    const part = await main(e),
      read = await whole(e, part.document_version_id!);
    const unit = read.units.units.find((u) =>
      u.translation!.includes("complete synthetic"),
    )!;
    const q = await createQueryApplication(e.home);
    try {
      const original = (await executeQuery(q, "document-slice", {
        document_version_id: part.document_version_id,
        selector: { kind: "segment", segment_id: unit.unit_id },
        max_bytes: 65536,
        continuation: null,
      })) as { evidence: Record<string, unknown>[] };
      const translated = (await executeQuery(q, "document-slice", {
        document_version_id: part.document_version_id,
        selector: { kind: "segment", segment_id: unit.unit_id },
        max_bytes: 65536,
        continuation: null,
        text: "translation",
      })) as { text: string; evidence: unknown[] };
      expect(translated.evidence).toEqual([]);
      // A reference made from the translated text does not resolve.
      await expect(
        executeQuery(q, "document-evidence", {
          evidence: {
            ...original.evidence[0],
            content_sha256: createHash("sha256")
              .update(translated.text)
              .digest("hex"),
          },
          max_bytes: 65536,
          continuation: null,
        }),
      ).rejects.toBeTruthy();
      await expect(
        executeQuery(q, "document-evidence", {
          evidence: original.evidence[0],
          max_bytes: 65536,
          continuation: null,
        }),
      ).resolves.toMatchObject({ text: "A complete synthetic study." });
    } finally {
      await q.close();
    }
  } finally {
    await e.close();
  }
}, 0);

it("splits a unit's translation over its regions by share, at the nearest punctuation", () => {
  expect(splitTranslation("第一句话很长，第二句话。", [6, 6])).toEqual([
    "第一句话很长，",
    "第二句话。",
  ]);
  expect(splitTranslation("abc", [1])).toEqual(["abc"]);
  expect(splitTranslation("一二三四五六七八", [1, 1]).join("")).toBe(
    "一二三四五六七八",
  );
});

it("translates a paragraph merged across pages as one unit and places it back on both pages", async () => {
  const e = await fixture({
    sourcePdf: twoPagePdf(),
    pageCount: 2,
    pageText: (page) =>
      page === 0
        ? "# Introduction\n\nThe synthetic study of spectra continues"
        : "into the second page, and it ends here.\n\n# References\n\n[1] Example synthetic reference.",
  });
  try {
    e.setText("unused");
    await e.submit("translate-merged");
    expect(await step(e)).toMatchObject({ status: "done" });
    const read = await whole(e, (await main(e)).document_version_id!);
    const merged = read.units.units.find((u) => u.segment_ids.length > 1)!;
    expect(merged.segment_ids).toHaveLength(2);
    expect(merged.translation).toBe(
      "译文：The synthetic study of spectra continues into the second page, and it ends here.",
    );
    const pages = await Promise.all(
      [0, 1].map((page_index) =>
        e.app.fullTextTranslation.page({
          literature_id: e.id,
          page_index,
          target_language: "zh-Hans",
          model: null,
          force: true,
        }),
      ),
    );
    const pieces = merged.segment_ids.map(
      (id) =>
        pages.flatMap((p) => p.blocks).find((b) => b.leaf_id === id)!
          .translation,
    );
    expect(pieces.every((p) => p && p.length > 0)).toBe(true);
    expect(pieces.join("")).toBe(merged.translation);
    expect(pages[0]).toMatchObject({ saved: true, state: "complete" });
    // The page view reads the stored file: no model request.
    expect(e.requests).toHaveLength(1);
    expect(
      await e.app.fullTextTranslation.summary(e.id, "zh-Hans"),
    ).toMatchObject({ state: "complete", page_count: 2 });
  } finally {
    await e.close();
  }
}, 0);

/** Two accepted PDF pages; the parser and page inspections remain synthetic ports. */
function twoPagePdf() {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 7 0 R >> >> /Contents 4 0 R >>",
    "",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 7 0 R >> >> /Contents 6 0 R >>",
    "",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  for (const [index, text] of [
    [3, "The synthetic study of spectra continues"],
    [5, "into the second page, and it ends here."],
  ] as const) {
    const stream = `BT /F1 12 Tf 40 740 Td (${text}) Tj ET`;
    objects[index] =
      `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`;
  }
  let body = "%PDF-1.4\n";
  const offsets = objects.map((object, i) => {
    const offset = Buffer.byteLength(body);
    body += `${i + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const xref = Buffer.byteLength(body);
  return Buffer.from(
    body +
      `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` +
      offsets
        .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
        .join("") +
      `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`,
  );
}
