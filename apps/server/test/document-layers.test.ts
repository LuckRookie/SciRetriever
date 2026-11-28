import { createHash } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { canonicalJsonBytes, parseArtifactRef } from "@sciretriever/contracts";
import { DocumentLayersStore } from "../src/layers/document.js";
import {
  archiveLayersKeyBeforeTranslateLast,
  archiveStepKey,
} from "../src/archive/input-key.js";
import { artifactReference } from "../src/storage/artifact-layout.js";
import type { ArchiveStepReceipt } from "@sciretriever/contracts";
import { createQueryApplication } from "../src/bootstrap/application.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { startQueryOnlyWorkbench } from "../src/bootstrap/workbench.js";
import { runCli } from "../src/cli/main.js";
import { createMcpServer } from "../src/mcp/server.js";
import { executeQuery } from "../src/entry/query-operations.js";
import { SqliteArchiveTextStorage } from "../src/storage/archive-text.js";
import { archiveFixture } from "./archive-fixture.js";
import {
  defaultLayersReply,
  defaultLayersTranslationReply,
  type LayersCall,
} from "./core-processing-fixture.js";

// Spec 10.8: the layers step written paragraph by paragraph and its reads, with the fake model only.
const sentences = (topic: string, from: number) =>
  Array.from(
    { length: 5 },
    (_, i) =>
      `The ${topic} sample ${from + i} showed a stable synthetic spectrum near ${400 + from + i} nm in water.`,
  ).join(" ");
const SECTIONS = ["Introduction", "Methods", "Results", "Conclusion"];
/**
 * About 3,400 code points of body text: enough for reading layers. Nine
 * paragraphs p1 to p9 (the abstract, then two per section); headings s1
 * (Abstract) to s5 (Conclusion), s6 the references.
 */
export const LONG_TEXT =
  "# Abstract\n\n" +
  sentences("abstract", 1) +
  "\n\n" +
  SECTIONS.map(
    (title, s) =>
      `# ${title}\n\n${sentences(title.toLowerCase(), 10 * s + 10)}\n\n${sentences(`${title.toLowerCase()} second`, 10 * s + 15)}`,
  ).join("\n\n") +
  "\n\n# References\n\n[1] Example synthetic reference.\n";

type Fixture = Awaited<ReturnType<typeof archiveFixture>>;
type Reply = (call: LayersCall) => unknown;
/** Calls of the layers step, recorded; `answer` overrides some, the rest get the default. */
async function fixture(
  options: Parameters<typeof archiveFixture>[0] = {},
  text = LONG_TEXT,
): Promise<
  Fixture & {
    calls: LayersCall[];
    answer: (reply: (call: LayersCall) => unknown) => void;
    count: (kind: LayersCall["kind"], section?: string) => number;
  }
> {
  const e = await archiveFixture({ offline: true, ...options });
  // No real source or model can be reached: the provider is a closed loopback port.
  expect(e.app.configuration.providers.fixture?.base_url).toBe(
    "http://127.0.0.1:9/v1",
  );
  e.setText(text);
  const calls: LayersCall[] = [];
  let override: Reply = () => undefined;
  const reply = (fallback: Reply) => (call: LayersCall) => {
    calls.push(call);
    return override(call) ?? fallback(call);
  };
  e.setLayers(reply(defaultLayersReply));
  e.setLayersTranslation(reply(defaultLayersTranslationReply));
  return Object.assign(e, {
    calls,
    answer: (r: Reply) => {
      override = r;
    },
    count: (kind: LayersCall["kind"], section?: string) =>
      calls.filter(
        (c) =>
          c.kind === kind && (section === undefined || inSection(c, section)),
      ).length,
  });
}
/** Whether a call is about the section of that heading. */
const inSection = (call: LayersCall, heading: string) =>
  typeof call.input === "string"
    ? new RegExp(`^This section: (?:\\[s\\d+\\] )?${heading}$`, "mu").test(
        call.input,
      )
    : "section" in call.input && call.input.section === `译文：${heading}`;
const main = async (e: Fixture) =>
  (await e.app.archive.status(e.id)).parts.find((p) => p.part === "main")!;
const step = async (e: Fixture) =>
  (await main(e)).steps.find((s) => s.step === "layers") as
    | (ArchiveStepReceipt & { output: { layers: Record<string, unknown> } })
    | undefined;
/** The translate step: its `output.layers` is the layers' translation part (ADR 0074 section 5). */
const translateStep = async (e: Fixture) =>
  (await main(e)).steps.find((s) => s.step === "translate") as
    | (ArchiveStepReceipt & {
        output: {
          layers: Record<string, unknown>;
          translation: Record<string, unknown>;
        };
      })
    | undefined;
const layersRow = async (e: Fixture) => {
  const part = await main(e);
  return new DocumentLayersStore(e.app.database, e.app.files).row({
    literature_id: e.id,
    asset_id: part.asset_id,
    document_version_id: part.document_version_id!,
    content_version: part.content_version!,
  });
};
async function read<T = Record<string, unknown>>(
  e: Fixture,
  operation: string,
  request: Record<string, unknown>,
): Promise<T> {
  const q = await createQueryApplication(e.home);
  try {
    return (await executeQuery(q, operation as never, request)) as T;
  } finally {
    await q.close();
  }
}
// Results are checked by shape in each test; loose typing keeps them short.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = Record<string, any>;
const layers = (e: Fixture, request: Record<string, unknown>) =>
  read<Loose>(e, "document-layers", request).catch(
    (error: unknown) => error as Loose,
  );
const describe = async (e: Fixture, document_version_id: string) =>
  (
    await read<{ layers?: Record<string, unknown> }>(e, "document-describe", {
      document_version_id,
    })
  ).layers;
const numbers = (points: { number: number }[]) => points.map((p) => p.number);

it("writes a note per paragraph, a line per section and the digest once; reads overview, outline, three texts and Markdown", async () => {
  const e = await fixture();
  try {
    await e.submit("layers-all");
    expect((await e.app.archive.status(e.id)).status).toBe("READY");
    const receipt = (await step(e))!;
    expect(receipt).toMatchObject({ status: "done", reason: null });
    expect(receipt.output.layers).toMatchObject({
      status: "complete",
      redone: "all",
      annotatable: 9,
      points: 9,
      sections: 5,
      primary: 3,
    });
    // The layers step writes the original only; the translate step writes
    // the translation part and its receipt (ADR 0074 section 5).
    expect(receipt.output.layers).not.toHaveProperty("translation");
    const translated_receipt = (await translateStep(e))!;
    expect(translated_receipt).toMatchObject({ status: "done", reason: null });
    expect(translated_receipt.output.translation).toMatchObject({
      status: "complete",
    });
    expect(translated_receipt.output.layers).toMatchObject({
      status: "done",
      target_language: "zh-Hans",
      translated_points: 9,
      translated_sections: 5,
      aligned: 9,
    });
    // One call per section, one for the whole document, the same for the translation part.
    expect(
      [
        "section",
        "line",
        "document",
        "translation-section",
        "translation-document",
      ].map((k) => e.count(k as LayersCall["kind"])),
    ).toEqual([5, 0, 1, 5, 1]);
    expect(receipt.calls).toBe(6);
    // The full text in one batch, then the six calls of the translation part.
    expect(translated_receipt.calls).toBe(1 + 6);
    // A section call: title, abstract, outline with this section marked, its paragraphs as their text.
    const methods = e.calls.find(
      (c) => c.kind === "section" && inSection(c, "Methods"),
    )!.input as string;
    expect(methods).toContain(
      "Abstract, for context:\nThe abstract sample 1 showed",
    );
    expect(methods).toContain("▶ [s3] Methods");
    expect(methods).toContain("\n[s2] Introduction\n");
    expect(methods).toMatch(
      /^\[p4\] paragraph\nThe methods sample 20 showed a stable synthetic spectrum near 420 nm in water\. The methods sample 21 .* 424 nm in water\.$/mu,
    );
    expect(methods).not.toContain("<1>");
    expect(methods).not.toContain("[p2]");
    expect(methods).not.toContain("Example synthetic reference");
    // The whole-document call sees titles, lines and notes, never the full text.
    const whole = e.calls.find((c) => c.kind === "document")!.input as string;
    expect(whole).toContain(
      "[s3] Methods: The Methods section establishes stable spectra.",
    );
    expect(whole).toContain(
      "[p4] result: The methods sample 20 showed a stable synthetic spectrum near 420 nm in water.",
    );
    expect(whole).not.toContain("methods sample 21");
    // The translation part is written from the stored translation, with the original evidence.
    const translated = e.calls.find(
      (c) => c.kind === "translation-section" && inSection(c, "Methods"),
    )!;
    expect(translated.input).toMatchObject({
      section: "译文：Methods",
      part: null,
      paragraphs: [
        {
          id: "p4",
          kind: "result",
          // The stored translation unsplit.
          text: expect.stringMatching(
            /^译文：The methods sample 20 showed a stable synthetic spectrum near 420 nm in water\. .*424 nm in water\.$/u,
          ),
          evidence: [
            {
              id: "e1",
              original:
                "The methods sample 20 showed a stable synthetic spectrum near 420 nm in water.",
            },
          ],
        },
        expect.objectContaining({ id: "p5" }),
      ],
    });
    const document_version_id = (await main(e)).document_version_id!;
    expect(await describe(e, document_version_id)).toEqual({
      state: "complete",
      points: 9,
      target_language: "zh-Hans",
      reason: null,
    });
    const overview = await layers(e, { document_version_id, part: "overview" });
    expect(overview).toMatchObject({
      part: "overview",
      format: "json",
      text: "original",
      state: "complete",
      machine_written: true,
      prompt_version: "reading-layers-v3",
    });
    expect(overview).not.toHaveProperty("machine_translation");
    expect(overview.summary).toEqual({
      text: "A synthetic study of spectra measured in water. It records each sample and concludes that the spectra are stable.",
      key_terms: ["synthetic study"],
      units: [{ unit_id: expect.any(String), paragraph: 2 }],
    });
    expect(overview.limits).toEqual([
      {
        text: "Only water was used as the medium.",
        units: [{ unit_id: expect.any(String), paragraph: 2 }],
      },
    ]);
    expect(overview.advice).toMatchObject({
      text: "Read Results for the spectra.",
      places: [
        {
          text: "Results",
          target: { kind: "section", title: "Results", paragraph: 9 },
        },
      ],
    });
    expect(overview.data).toEqual([
      {
        quantity: "Spectrum of the first sample",
        value: "401 nm",
        source: { kind: "unit", unit_id: expect.any(String), paragraph: 2 },
      },
    ]);
    // The trunk marks three notes; the basis is each one's first evidence.
    expect(numbers(overview.primary)).toEqual([1, 2, 3]);
    expect(overview.primary[1].basis).toMatchObject({
      kind: "sentence",
      text: "The introduction sample 10 showed a stable synthetic spectrum near 410 nm in water.",
      paragraph: 4,
      sentences: [1],
      fallback: false,
    });
    // Every section with its line and all its notes, in the author's order.
    expect(
      overview.sections.map((s: Loose) => [
        s.title,
        s.statement,
        s.label,
        s.points.length,
      ]),
    ).toEqual([
      [
        "Abstract",
        "The Abstract section establishes stable spectra.",
        "stable spectra",
        1,
      ],
      [
        "Introduction",
        "The Introduction section establishes stable spectra.",
        "stable spectra",
        2,
      ],
      [
        "Methods",
        "The Methods section establishes stable spectra.",
        "stable spectra",
        2,
      ],
      [
        "Results",
        "The Results section establishes stable spectra.",
        "stable spectra",
        2,
      ],
      [
        "Conclusion",
        "The Conclusion section establishes stable spectra.",
        "stable spectra",
        2,
      ],
    ]);
    expect(overview.sections[1].points[0]).toEqual({
      number: 2,
      unit_id: expect.any(String),
      paragraph: 4,
      statement:
        "The introduction sample 10 showed a stable synthetic spectrum near 410 nm in water.",
      reason:
        "The introduction sample 11 showed a stable synthetic spectrum near 411 nm in water.",
      key_terms: ["introduction"],
      section_id: overview.sections[1].section_id,
      section_title: "Introduction",
      primary: true,
      label: "introduction sample 10",
      kind: "result",
      relations: [
        {
          word: "follows",
          targets: [{ kind: "point", number: 1, paragraph: 2 }],
        },
      ],
    });
    // The outline pages by notes, each page with its sections' lines.
    const first = await layers(e, {
      document_version_id,
      part: "outline",
      limit: 4,
    });
    expect(numbers(first.points)).toEqual([1, 2, 3, 4]);
    expect(first.total).toBe(9);
    expect(first.sections.map((s: Loose) => s.title)).toEqual([
      "Abstract",
      "Introduction",
      "Methods",
    ]);
    const evidence = first.points[1].evidence[0];
    expect(evidence).toMatchObject({
      kind: "sentence",
      paragraph: 4,
      sentences: [1],
      text: "The introduction sample 10 showed a stable synthetic spectrum near 410 nm in water.",
    });
    expect(evidence.end_utf8 - evidence.start_utf8).toBe(
      Buffer.byteLength(evidence.text),
    );
    const second = await layers(e, {
      document_version_id,
      part: "outline",
      limit: 4,
      cursor: first.next_cursor,
    });
    expect(numbers(second.points)).toEqual([5, 6, 7, 8]);
    const third = await layers(e, {
      document_version_id,
      part: "outline",
      limit: 4,
      cursor: second.next_cursor,
    });
    expect(numbers(third.points)).toEqual([9]);
    expect(third.next_cursor).toBeNull();
    // Each evidence reference resolves to the original text like a slice's.
    const ref = first.evidence.find(
      (r: { locator: { segment_id: string } }) =>
        r.locator.segment_id === evidence.segment_ids[0],
    );
    const resolved = await read<{ text: string }>(e, "document-evidence", {
      evidence: ref,
      max_bytes: 65536,
      continuation: null,
    });
    expect(resolved.text).toContain(evidence.text);
    // Translation: notes, reasons, labels, lines and evidence of the version in the target language.
    const outline = await layers(e, {
      document_version_id,
      part: "outline",
      text: "translation",
      limit: 2,
    });
    expect(outline).toMatchObject({
      machine_translation: true,
      target_language: "zh-Hans",
      untranslated: 0,
    });
    expect(outline.points[1]).toMatchObject({
      statement:
        "译文：The introduction sample 10 showed a stable synthetic spectrum near 410 nm in water.",
      reason:
        "The introduction sample 11 showed a stable synthetic spectrum near 411 nm in water.",
      label: "译文：The introduction sample",
      key_terms: ["introduction"],
      kind: "result",
      translated: true,
    });
    expect(outline.sections[1]).toMatchObject({
      title: "Introduction",
      statement: "译文：译文：Introduction一节确立了稳定的光谱。",
      label: "稳定的光谱",
      translated: true,
    });
    // The stored translation is the unit's whole text prefixed: its sentence 1.
    expect(outline.points[1].evidence[0]).toMatchObject({
      start_utf8: evidence.start_utf8,
      translated: true,
      aligned: true,
      text: "译文：The introduction sample 10 showed a stable synthetic spectrum near 410 nm in water.",
    });
    const both = await layers(e, {
      document_version_id,
      part: "overview",
      text: "bilingual",
    });
    expect(both.summary.translation).toEqual({
      text: "译文：A synthetic study of spectra measured in water. It records each sample and concludes that the spectra are stable.",
      key_terms: ["synthetic study"],
    });
    expect(both.limits[0].translation).toEqual({
      text: "译文：Only water was used as the medium.",
    });
    expect(both.advice.translation).toEqual({
      text: "译文：Read Results for the spectra.",
      key_terms: ["spectra"],
      places: ["Results"],
    });
    // The quantity has a version; the value never has.
    expect(both.data[0]).toMatchObject({
      value: "401 nm",
      translation: { quantity: "译文：Spectrum of the first sample" },
    });
    expect(both.sections[0].translation).toEqual({
      statement: "译文：译文：Abstract一节确立了稳定的光谱。",
      label: "稳定的光谱",
    });
    expect(both.sections[0].points[0].translation).toMatchObject({
      statement:
        "译文：The abstract sample 1 showed a stable synthetic spectrum near 401 nm in water.",
      reason:
        "The abstract sample 2 showed a stable synthetic spectrum near 402 nm in water.",
    });
    // Markdown: the machine note first, the digest, then each section's line and each note by its paragraph.
    const markdown = await layers(e, {
      document_version_id,
      part: "outline",
      format: "markdown",
      limit: 50,
    });
    expect(markdown.format).toBe("markdown");
    expect(markdown.markdown.split("\n")[0]).toBe(
      "> 批语与提要由机器写成，不是证据；依据是原文里的句子与图表。",
    );
    for (const heading of ["## 提要", "## 数据", "## 局限", "## 精读建议"])
      expect(markdown.markdown).toContain(heading);
    expect(markdown.markdown).toContain(
      "| Spectrum of the first sample | 401 nm | ¶2 |",
    );
    expect(markdown.markdown).toContain(
      "- Only water was used as the medium.（¶2）",
    );
    expect(markdown.markdown).toContain("去处：Results → ¶9");
    expect(markdown.markdown).toContain(
      "## Introduction\n\n*节旨：The Introduction section establishes stable spectra.*\n\n**¶4** ● 〔结果〕The introduction sample 10 showed a stable synthetic spectrum near 410 nm in water. The introduction sample 11 showed",
    );
    expect(markdown.markdown).toContain("（承接 ¶2）");
    expect(markdown.markdown).toContain(
      "> The introduction sample 10 showed a stable synthetic spectrum near 410 nm in water.\n> — ¶4·1",
    );
    // A note outside the trunk has no mark.
    expect(markdown.markdown).toContain("**¶7** 〔结果〕");
    const bilingual = await layers(e, {
      document_version_id,
      part: "outline",
      format: "markdown",
      text: "bilingual",
    });
    expect(bilingual.markdown.split("\n")[0]).toContain("译文为机器翻译。");
    expect(bilingual.markdown).toContain(
      "\n>\n> 译文：The introduction sample 10 showed",
    );
    const overviewMarkdown = await layers(e, {
      document_version_id,
      part: "overview",
      format: "markdown",
    });
    expect(overviewMarkdown.markdown).toContain(
      "*节旨：The Results section establishes stable spectra.*",
    );
    expect(overviewMarkdown.markdown).not.toContain("> — ¶");
    // The same contract through the CLI.
    let out = "";
    const cli = await runCli(["document", "layers", "--request", "-"], {
      home: e.home,
      stdin: (async function* () {
        yield Buffer.from(
          JSON.stringify({ document_version_id, part: "outline", limit: 1 }),
        );
      })(),
      stdout: (s) => {
        out += s;
      },
    });
    expect(cli.code).toBe(0);
    expect(JSON.parse(out).result).toMatchObject({
      total: 9,
      points: [first.points[0]],
    });
    // Archiving again with the same input skips the step: no model call.
    const calls = e.modelCalls;
    await e.submit("layers-again");
    expect(e.modelCalls).toBe(calls);
    expect((await step(e))!.output.usage).toMatchObject({ calls: 0 });
  } finally {
    await e.close();
  }
}, 0);

it("drops what fails the checks and counts it; a note without evidence is no note", async () => {
  const e = await fixture();
  try {
    e.answer((call) => {
      if (call.kind !== "section" || !inSection(call, "Methods")) return;
      const base = defaultLayersReply(call) as Loose;
      const [p4, p5] = base.units;
      return {
        ...base,
        units: [
          {
            ...p4,
            // The first and third sentences are two evidence; a third quote is dropped.
            evidence: [
              "The methods sample 22 showed a stable synthetic spectrum near 422 nm in water.",
              "The methods sample 20 showed a stable synthetic spectrum",
              "The methods sample 21 showed",
            ],
            key_terms: ["absent term", "methods"],
            label: "not in the note",
            kind: "bogus",
            reason: "x ".repeat(40).trim(),
            see: ["f9"],
          },
          // Not in the paragraph, and too long: no evidence, no note.
          {
            ...p5,
            evidence: [
              "The methods sample 99 showed nothing at all.",
              "x".repeat(301),
            ],
          },
        ],
      };
    });
    await e.submit("layers-drops");
    const receipt = (await step(e))!;
    expect(receipt).toMatchObject({ status: "done" });
    expect(receipt.output.layers).toMatchObject({
      points: 8,
      dropped: {
        points: 1,
        evidence: 3,
        key_terms: 1,
        labels: 1,
        kinds: 1,
        reasons: 1,
        see: 1,
        unanswered: 0,
      },
    });
    const document_version_id = (await main(e)).document_version_id!;
    const outline = await layers(e, { document_version_id, part: "outline" });
    const p4 = outline.points.find((p: Loose) => p.paragraph === 7);
    expect(p4).toMatchObject({
      kind: null,
      label: null,
      reason: null,
      key_terms: ["methods"],
      relations: [{ word: "follows" }],
    });
    // Sorted by position, shown with their display sentence numbers; apart, they are two evidence.
    expect(p4.evidence.map((x: Loose) => x.sentences)).toEqual([[1], [3]]);
    expect(p4.evidence[0].text).toBe(
      "The methods sample 20 showed a stable synthetic spectrum",
    );
    // The Methods section's second paragraph has no note.
    expect(outline.points.some((p: Loose) => p.paragraph === 8)).toBe(false);
    expect(numbers(outline.points)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  } finally {
    await e.close();
  }
}, 0);

it("leaves a section answered badly twice without notes and keeps the others", async () => {
  const e = await fixture();
  try {
    e.answer((call) =>
      call.kind === "section" && inSection(call, "Results")
        ? { section: { statement: "", label: "" }, units: "nothing" }
        : undefined,
    );
    await e.submit("layers-bad-section");
    const receipt = (await step(e))!;
    expect(receipt).toMatchObject({ status: "done" });
    expect(e.count("section", "Results")).toBe(2);
    // Seven of nine paragraphs have notes: at least two thirds.
    expect(receipt.output.layers).toMatchObject({
      annotatable: 9,
      points: 7,
      sections: 4,
      dropped: { unanswered: 2 },
    });
    const document_version_id = (await main(e)).document_version_id!;
    const overview = await layers(e, { document_version_id, part: "overview" });
    expect(overview.sections.map((s: Loose) => s.title)).toEqual([
      "Abstract",
      "Introduction",
      "Methods",
      "Conclusion",
    ]);
  } finally {
    await e.close();
  }
}, 0);

it("fails below two thirds of the paragraphs, keeps the full text ready, and redoes the step on resume", async () => {
  const e = await fixture();
  try {
    e.answer((call) =>
      call.kind === "section" &&
      ["Methods", "Results", "Conclusion"].some((s) => inSection(call, s))
        ? { section: { statement: "", label: "" }, units: [] }
        : undefined,
    );
    await e.submit("layers-too-few");
    const state = await e.app.archive.status(e.id);
    expect(state.status).toBe("READY");
    const failed = (await step(e))!;
    expect(failed).toMatchObject({
      status: "failed",
      reason: "layers-incomplete",
    });
    expect(failed.output.layers).toMatchObject({
      annotatable: 9,
      annotated: 3,
      primary: 0,
      summary_missing: true,
    });
    // The whole-document call is not made for notes that cover too little.
    expect(e.count("document")).toBe(0);
    expect(state.issues).toContainEqual(
      expect.objectContaining({
        step: "layers",
        reason: "layers-incomplete",
        affects_readiness: false,
        resolution: null,
      }),
    );
    // The steps after it still ran; nothing was published.
    for (const name of ["metadata", "references", "tags"])
      expect((await main(e)).steps.find((s) => s.step === name)?.status).toBe(
        "done",
      );
    const document_version_id = (await main(e)).document_version_id!;
    expect(await describe(e, document_version_id)).toEqual({
      state: "none",
      points: 0,
      target_language: null,
      reason: null,
    });
    expect(
      await layers(e, { document_version_id, part: "overview" }),
    ).toMatchObject({
      code: "layers-unavailable",
      details: { state: "none", reason: null },
    });
    // Resume: the step runs again.
    e.answer(() => undefined);
    await e.submit("layers-resume");
    expect(await step(e)).toMatchObject({ status: "done" });
    expect(
      (await e.app.archive.status(e.id)).issues.find((i) => i.step === "layers")
        ?.resolution,
    ).toBe("continue");
  } finally {
    await e.close();
  }
}, 0);

it("splits a cut-off section in halves and writes its line from their notes; a cut-off digest is asked again", async () => {
  const e = await fixture();
  try {
    let digest = 0;
    e.answer((call) => {
      if (
        call.kind === "section" &&
        inSection(call, "Introduction") &&
        !/^This is part /mu.test(call.input as string)
      )
        return { truncated: true };
      if (call.kind === "document" && !digest++) return { truncated: true };
      return undefined;
    });
    await e.submit("layers-truncated");
    const receipt = (await step(e))!;
    expect(receipt).toMatchObject({ status: "done" });
    // The whole section, then each half with one paragraph; then its line.
    const intro = e.calls.filter(
      (c) => c.kind === "section" && inSection(c, "Introduction"),
    );
    expect(intro).toHaveLength(3);
    expect(
      intro
        .slice(1)
        .map(
          (c) =>
            /^This is part \d of 2 of this section: paragraphs (p\d+) to \1\.$/mu.exec(
              c.input as string,
            )?.[1],
        )
        .sort(),
    ).toEqual(["p2", "p3"]);
    expect(e.count("line")).toBe(1);
    expect(e.calls.find((c) => c.kind === "line")!.input).toContain(
      "Notes of its paragraphs:\n[p2] The introduction sample 10",
    );
    expect(e.count("document")).toBe(2);
    expect(receipt.output.layers).toMatchObject({ points: 9, sections: 5 });
    const document_version_id = (await main(e)).document_version_id!;
    const overview = await layers(e, { document_version_id, part: "overview" });
    expect(overview.sections[1]).toMatchObject({
      title: "Introduction",
      statement: "The section establishes stable spectra.",
    });
  } finally {
    await e.close();
  }
}, 0);

it("fails when the digest is invalid twice or the trunk has fewer than three notes", async () => {
  const e = await fixture();
  try {
    e.answer((call) =>
      call.kind === "document" ? { digest: "nothing" } : undefined,
    );
    await e.submit("layers-bad-digest");
    expect((await e.app.archive.status(e.id)).status).toBe("READY");
    expect(e.count("document")).toBe(2);
    expect(await step(e)).toMatchObject({
      status: "failed",
      reason: "layers-incomplete",
      output: { layers: { annotated: 9, summary_missing: true } },
    });
    e.answer((call) =>
      call.kind === "document"
        ? { ...(defaultLayersReply(call) as Loose), primary: ["p1", "p99"] }
        : undefined,
    );
    await e.submit("layers-few-primary");
    expect(await step(e)).toMatchObject({
      status: "failed",
      reason: "layers-incomplete",
      output: {
        layers: { primary: 1, summary_missing: false, dropped: { primary: 1 } },
      },
    });
  } finally {
    await e.close();
  }
}, 0);

it("writes no note for a table note: it goes with its table and is still translated", async () => {
  const NOTE =
    "$^{a}$ Measured in water at room temperature after drying every salt for twelve hours under vacuum, three times for each sample.";
  const table = `Table 1. Peaks of the samples.\n\n| sample | peak |\n| --- | --- |\n| 1 | 401 nm |\n\n${NOTE}`;
  const e = await fixture(
    // MinerU takes a note under a table as a footnote from that table.
    {
      rawBlock: (b) =>
        b.text.startsWith("$^{a}$")
          ? { type: "footnote", source_type: "table" }
          : b.text.startsWith("Table 1.")
            ? { type: "caption", source_type: "table" }
            : undefined,
    },
    LONG_TEXT.replace("\n\n# Conclusion", `\n\n${table}\n\n# Conclusion`),
  );
  const translated: string[] = [];
  e.setTranslation((input) => {
    translated.push(...input.units.map((u) => u.text));
    return {
      translations: input.units.map((u) => ({
        id: u.id,
        translation: `译文：${u.text}`,
      })),
    };
  });
  try {
    await e.submit("layers-table-note");
    const receipt = (await step(e))!;
    expect(receipt).toMatchObject({ status: "done" });
    // The section has its table; the note under it is no paragraph and is
    // sent to no call.
    const results = e.calls.find(
      (c) => c.kind === "section" && inSection(c, "Results"),
    )!.input as string;
    expect(results).toMatch(/^\[f1\] table: /mu);
    expect(
      [...results.matchAll(/^\[p\d+\] (.+)$/gmu)].map((m) => m[1]),
    ).toEqual(["paragraph", "paragraph", "caption"]);
    expect(
      e.calls.some((c) =>
        JSON.stringify(c.input).includes("Measured in water"),
      ),
    ).toBe(false);
    expect(receipt.output.layers).toMatchObject({ annotatable: 9, points: 10 });
    // The translation still translates it.
    expect(translated.some((t) => t.includes("Measured in water"))).toBe(true);
  } finally {
    await e.close();
  }
}, 0);

it("records a short paper as not applicable without asking the model", async () => {
  const e = await fixture(
    {},
    "# Abstract\n\nFixture Author studies spectroscopy.\n\n# Introduction\n\nA short synthetic study.\n\n# References\n\n[1] Example synthetic reference.\n",
  );
  try {
    await e.submit("layers-short");
    expect(await step(e)).toMatchObject({ status: "done", calls: 0 });
    expect((await step(e))!.output.layers).toMatchObject({
      status: "not-applicable",
      reason: "too-short",
    });
    expect(e.calls).toEqual([]);
    const document_version_id = (await main(e)).document_version_id!;
    expect(await describe(e, document_version_id)).toEqual({
      state: "not-applicable",
      points: 0,
      target_language: null,
      reason: "too-short",
    });
    expect(
      await layers(e, { document_version_id, part: "outline" }),
    ).toMatchObject({
      code: "layers-unavailable",
      details: { state: "not-applicable", reason: "too-short" },
    });
    // The same refusal over HTTP (409, with state and reason) and MCP.
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
            request: { document_version_id, part: "overview" },
          }),
        },
      );
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({
        protocol_version: 1,
        code: "layers-unavailable",
        state: "not-applicable",
        reason: "too-short",
      });
    } finally {
      await web.close();
    }
    const server = createMcpServer({ home: e.home }),
      client = new Client({ name: "layers", version: "1" }),
      [a, b] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(a);
      await client.connect(b);
      const result = await client.callTool({
        name: "document_read",
        arguments: {
          operation: "layers",
          request: { document_version_id, part: "overview" },
        },
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        result: {
          failure: {
            code: "layers-unavailable",
            state: "not-applicable",
            reason: "too-short",
          },
        },
      });
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    await e.close();
  }
}, 0);

it("records a long document as not applicable", async () => {
  const e = await fixture({
    pageCount: 51,
    sourcePdf: pagesPdf(51),
    pageText: (page) =>
      page === 0
        ? `# Introduction\n\n${sentences("long", 1)}`
        : sentences(`page ${page}`, page),
  });
  try {
    await e.submit("layers-long");
    expect((await main(e)).long_document).not.toBeNull();
    expect((await step(e))!.output.layers).toMatchObject({
      status: "not-applicable",
      reason: "long-document",
    });
    expect(e.calls).toEqual([]);
  } finally {
    await e.close();
  }
}, 0);

it("writes the translation part per section; a paragraph missing in the translation has no version; only a changed translation is redone", async () => {
  const e = await fixture();
  try {
    // First the translation misses the second Methods paragraph.
    e.setTranslation((input) => ({
      translations: input.units
        .filter((u) => !u.text.includes("methods second sample"))
        .map((u) => ({ id: u.id, translation: `译文：${u.text}` })),
    }));
    await e.submit("layers-partial-translation");
    // A partial full text is the translate step's problem; its layers part
    // is still written from the units translated.
    const before = (await translateStep(e))!;
    expect(before).toMatchObject({
      status: "failed",
      reason: "translation-incomplete",
    });
    expect(before.output.layers).toMatchObject({
      status: "done",
      translated_points: 8,
    });
    expect(await step(e)).toMatchObject({ status: "done" });
    const beforeSha = (await layersRow(e))!.sha256;
    // The Methods call was asked for the translated paragraph only.
    const methods = e.calls.find(
      (c) => c.kind === "translation-section" && inSection(c, "Methods"),
    )!.input as Loose;
    expect(methods.paragraphs.map((p: Loose) => p.id)).toEqual(["p4"]);
    const document_version_id = (await main(e)).document_version_id!;
    const partial = await layers(e, {
      document_version_id,
      part: "outline",
      text: "translation",
    });
    // The note keeps the original; its evidence too.
    expect(partial.points[4]).toMatchObject({
      paragraph: 8,
      translated: false,
      statement: expect.stringContaining("The methods second sample 25"),
    });
    expect(partial.untranslated).toBe(1);
    expect(partial.points[4].evidence[0]).toMatchObject({
      translated: false,
      aligned: false,
    });
    const asked = e.calls.length;
    e.setTranslation((input) => ({
      translations: input.units.map((u) => ({
        id: u.id,
        translation: `译文：${u.text}`,
      })),
    }));
    await e.submit("layers-full-translation");
    const after = (await translateStep(e))!;
    expect(after).toMatchObject({ status: "done", reason: null });
    expect(after.output.translation).toMatchObject({
      status: "complete",
      requested: 1,
    });
    expect(after.output.layers).toMatchObject({
      status: "done",
      translated_points: 9,
    });
    expect((await layersRow(e))!.sha256).not.toBe(beforeSha);
    // The layers step is kept; only the translation part's calls: one per
    // section and one for the digest, after the missing unit's batch.
    expect(await step(e)).toMatchObject({ status: "done", calls: 0 });
    expect(e.calls.slice(asked).map((c) => c.kind)).toEqual([
      ...Array(5).fill("translation-section"),
      "translation-document",
    ]);
    expect(after.calls).toBe(1 + 6);
    const full = await layers(e, {
      document_version_id,
      part: "outline",
      text: "translation",
    });
    expect(full.points[4]).toMatchObject({ translated: true });
    expect(full.points[4].evidence[0]).toMatchObject({
      translated: true,
      aligned: true,
    });
  } finally {
    await e.close();
  }
}, 0);

it("leaves unconfirmed translated evidence without a position and drops what fails the checks", async () => {
  const e = await fixture();
  try {
    e.answer((call) => {
      if (call.kind !== "translation-section" || !inSection(call, "Abstract"))
        return;
      const base = defaultLayersTranslationReply(call) as Loose;
      return {
        ...base,
        units: base.units.map((u: Loose) => ({
          ...u,
          evidence: [
            { id: "e1", quote: "这一段不在译文里，也找不到相近的地方。" },
          ],
          key_terms: ["不存在的词"],
          label: "不在批语里",
        })),
      };
    });
    await e.submit("layers-translation-checks");
    const receipt = (await translateStep(e))!;
    expect(receipt.output.layers).toMatchObject({
      status: "done",
      evidence: 9,
      aligned: 8,
      dropped: { evidence: 1, key_terms: 1, labels: 1 },
    });
    const document_version_id = (await main(e)).document_version_id!;
    const outline = await layers(e, {
      document_version_id,
      part: "outline",
      text: "translation",
    });
    expect(outline.points[0]).toMatchObject({
      translated: true,
      key_terms: [],
      // The original label stands in for a dropped one.
      label: "abstract sample 1",
    });
    // Without a confirmed position the whole unit's translation is given.
    expect(outline.points[0].evidence[0]).toMatchObject({
      translated: true,
      aligned: false,
      text: expect.stringMatching(
        /^译文：The abstract sample 1 .* sample 5 .*water\.$/u,
      ),
    });
    expect(outline.points[1].evidence[0]).toMatchObject({ aligned: true });
  } finally {
    await e.close();
  }
}, 0);

it("has no translation part for a paper already in the target language", async () => {
  const e = await fixture({
    configurationText: '[translation]\ntarget_language="en"\n',
  });
  try {
    await e.submit("layers-same-language");
    expect((await step(e))!.output.layers).toMatchObject({
      status: "complete",
    });
    expect((await translateStep(e))!.output).toMatchObject({
      translation: { status: "same-language" },
      layers: { status: "not-needed" },
    });
    expect(e.count("translation-section")).toBe(0);
    expect(e.count("translation-document")).toBe(0);
    const document_version_id = (await main(e)).document_version_id!;
    expect(await describe(e, document_version_id)).toMatchObject({
      state: "complete",
      target_language: null,
    });
    expect(
      await layers(e, {
        document_version_id,
        part: "overview",
        text: "bilingual",
      }),
    ).toMatchObject({ code: "translation-unavailable" });
  } finally {
    await e.close();
  }
}, 0);

it("has none for a draft, reads stale after the text changes, and redoes everything from the layers step", async () => {
  const e = await fixture();
  try {
    await e.app.documentProcessing.parseDocuments(e.rawParseRequest);
    const draft = await main(e);
    expect(draft.text_level).toBe("draft");
    expect(await describe(e, draft.document_version_id!)).toEqual({
      state: "none",
      points: 0,
      target_language: null,
      reason: null,
    });
    await e.submit("layers-before-edit");
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
          "sample 10 showed",
          "sample 10 clearly showed",
        ),
        actor: "fixture-user",
      },
      "fixture-user",
    );
    const edited = await main(e);
    expect(edited.document_version_id).not.toBe(before.document_version_id);
    expect(await describe(e, edited.document_version_id!)).toEqual({
      state: "stale",
      points: 0,
      target_language: null,
      reason: null,
    });
    expect(
      await layers(e, {
        document_version_id: edited.document_version_id,
        part: "overview",
      }),
    ).toMatchObject({
      code: "layers-unavailable",
      details: { state: "stale", reason: null },
    });
    // The old version keeps its own layers.
    expect(await describe(e, before.document_version_id!)).toMatchObject({
      state: "complete",
    });
    // A new content version redoes the layers as a whole.
    await e.submit("layers-after-edit");
    expect(e.count("document")).toBe(2);
    expect((await step(e))!.output.layers).toMatchObject({ redone: "all" });
    // from_step layers redoes them although nothing changed.
    await e.submit("layers-from-step", undefined, "layers");
    expect(e.count("document")).toBe(3);
    expect((await step(e))!.output.layers).toMatchObject({ redone: "all" });
  } finally {
    await e.close();
  }
}, 0);

/** A PDF of `count` text pages; the parser and page inspections stay synthetic ports. */
function pagesPdf(count: number) {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${Array.from({ length: count }, (_, i) => `${4 + 2 * i} 0 R`).join(" ")}] /Count ${count} >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  for (let i = 0; i < count; i++) {
    const stream = `BT /F1 12 Tf 40 740 Td (Synthetic page ${i + 1}) Tj ET`;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + 2 * i} 0 R >>`,
      `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    );
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

it("reads a version 3 file as stale and redoes the layers on the next archive", async () => {
  const e = await fixture();
  try {
    await e.submit("layers-current");
    const part = await main(e);
    const store = new DocumentLayersStore(e.app.database, e.app.files);
    const key = {
      literature_id: e.id,
      asset_id: part.asset_id,
      document_version_id: part.document_version_id!,
      content_version: part.content_version!,
    };
    const row = (await store.row(key))!;
    // A file as the earlier release wrote it: only its version differs here.
    const old = { ...(await store.load(row)), schema_version: 3 };
    const bytes = canonicalJsonBytes(old);
    const ref = parseArtifactRef({
      sha256: createHash("sha256").update(bytes).digest("hex"),
      byte_size: bytes.length,
      media_type: "application/json",
    });
    await e.app.files.withWrite(async () => {
      const reference = artifactReference("document-layers", ref);
      const stage = await e.app.files.stage({ maxBytes: bytes.length });
      try {
        await stage.write(bytes);
        await e.app.files.publish(stage, reference);
      } finally {
        await stage.discard();
      }
      await e.app.database.archive("layers-publish", {
        row: {
          ...row,
          artifact_reference: reference,
          sha256: ref.sha256,
          byte_size: ref.byte_size,
        },
      });
    });
    expect(await describe(e, key.document_version_id)).toEqual({
      state: "stale",
      points: 0,
      target_language: null,
      reason: null,
    });
    expect(
      await layers(e, {
        document_version_id: key.document_version_id,
        part: "overview",
      }),
    ).toMatchObject({
      code: "layers-unavailable",
      details: { state: "stale" },
    });
    // A receipt of the earlier release has an input key of file version 3,
    // so archiving again redoes the layers as a whole.
    await e.app.close();
    const db = new DatabaseSync(join(e.home, "catalog.sqlite"));
    try {
      db.prepare(
        "UPDATE archive_steps SET input_sha256=? WHERE step='layers'",
      ).run("0".repeat(64));
    } finally {
      db.close();
    }
    await e.reopen();
    await e.submit("layers-after-upgrade");
    expect(e.count("document")).toBe(2);
    expect((await step(e))!.output.layers).toMatchObject({ redone: "all" });
    expect(await describe(e, key.document_version_id)).toMatchObject({
      state: "complete",
    });
  } finally {
    await e.close();
  }
}, 0);

/** Every model call in order: the layers calls by kind, the full text as `text`. */
function track(e: Awaited<ReturnType<typeof fixture>>) {
  const order: string[] = [];
  e.answer((call) => {
    order.push(call.kind);
    return undefined;
  });
  e.setTranslation((input) => {
    order.push("text");
    return {
      translations: input.units.map((u) => ({
        id: u.id,
        translation: `译文：${u.text}`,
      })),
    };
  });
  return order;
}
const ORIGINAL = ["section", "line", "document"];
const PART = ["translation-section", "translation-document"];

// ADR 0074 section 5: translation last, then the layers' translation part.
it("translates last: the full text after the original layers, then the layers' translation part", async () => {
  const e = await fixture();
  try {
    const order = track(e);
    const run = await e.submit("translate-last");
    const text = order.indexOf("text");
    expect(text).toBeGreaterThan(0);
    expect(order.slice(0, text).every((k) => ORIGINAL.includes(k))).toBe(true);
    expect(order.slice(text + 1).every((k) => PART.includes(k))).toBe(true);
    expect(order.filter((k) => PART.includes(k))).toHaveLength(6);
    // The steps completed in the order of ADR 0074.
    const events = await e.app.jobs!.listEvents(run.job.job_id, -1, 1000);
    expect(
      events
        .filter(
          (v) =>
            v.kind === "archive-progress" &&
            (v.payload as { phase: string }).phase === "completed",
        )
        .map((v) => (v.payload as { step: string }).step),
    ).toEqual([
      "parse",
      "arrange",
      "proofread",
      "render",
      "layers",
      "metadata",
      "references",
      "tags",
      "translate",
    ]);
  } finally {
    await e.close();
  }
}, 0);

it("from_step layers redoes the layers and their translation part only; the full text and the later steps are kept", async () => {
  const e = await fixture();
  try {
    await e.submit("layers-first");
    const first = (await translateStep(e))!;
    const order = track(e);
    await e.submit("layers-again-from-step", undefined, "layers");
    expect(order.filter((k) => k === "text")).toEqual([]);
    expect(order.filter((k) => ORIGINAL.includes(k))).toHaveLength(6);
    expect(order.filter((k) => PART.includes(k))).toHaveLength(6);
    const after = (await translateStep(e))!;
    expect(after).toMatchObject({ status: "done", calls: 6 });
    // The full text is reused untouched: the same file, nothing asked.
    expect(after.output.translation).toMatchObject({
      status: "complete",
      requested: 0,
      sha256: first.output.translation.sha256,
    });
    expect(after.output.layers).toMatchObject({
      status: "done",
      translated_points: 9,
    });
    for (const name of ["metadata", "references", "tags"])
      expect((await main(e)).steps.find((s) => s.step === name)).toMatchObject({
        status: "done",
        calls: 0,
      });
  } finally {
    await e.close();
  }
}, 0);

it("when only the original layers changed, keeps the full-text translation and redoes only the translation part", async () => {
  const e = await fixture();
  try {
    await e.submit("layers-before-change");
    const first = (await translateStep(e))!;
    // New original-language layers of the same content version, without a
    // translation part, as a redone layers step leaves them.
    const store = new DocumentLayersStore(e.app.database, e.app.files);
    const file = await store.load((await layersRow(e))!);
    await store.publish({
      ...file,
      digest: {
        ...file.digest,
        summary: { ...file.digest.summary, text: "A changed summary." },
      },
      translation: null,
    });
    const order = track(e);
    await e.submit("layers-after-change");
    expect(order).toEqual([
      ...Array(5).fill("translation-section"),
      "translation-document",
    ]);
    expect(await step(e)).toMatchObject({ status: "done", calls: 0 });
    const after = (await translateStep(e))!;
    expect(after.output.translation).toMatchObject({
      requested: 0,
      sha256: first.output.translation.sha256,
    });
    expect(after.output.layers).toMatchObject({ status: "done" });
    expect((await layersRow(e))!.translation_sha256).toBe(
      first.output.translation.sha256,
    );
  } finally {
    await e.close();
  }
}, 0);

it("resumes a complete document without asking any model, also under the input keys written before translation came last", async () => {
  const e = await fixture();
  try {
    await e.submit("complete");
    const calls = e.modelCalls;
    await e.submit("resume");
    expect(e.modelCalls).toBe(calls);
    // A document completed before ADR 0074 section 5: the layers key named
    // the language and the translation file, the translate key no layers.
    const part = await main(e);
    const translation = String(
      (await translateStep(e))!.output.translation.sha256,
    );
    const layersSha = (await layersRow(e))!.sha256;
    const legacyLayers = await archiveLayersKeyBeforeTranslateLast(
      part,
      "zh-Hans",
      translation,
    );
    const legacyTranslate = await archiveStepKey(
      "",
      "full",
      part,
      "translate",
      null,
      null,
      "zh-Hans",
    );
    await e.app.close();
    const db = new DatabaseSync(join(e.home, "catalog.sqlite"));
    try {
      const set = db.prepare(
        "UPDATE archive_steps SET input_sha256=? WHERE step=?",
      );
      set.run(legacyLayers, "layers");
      set.run(legacyTranslate, "translate");
    } finally {
      db.close();
    }
    await e.reopen();
    await e.submit("resume-after-reorder");
    expect(e.modelCalls).toBe(calls);
    // Both steps were skipped, not run again: they keep their first output.
    expect((await step(e))!.output.layers).toMatchObject({ redone: "all" });
    expect((await translateStep(e))!.output.translation).toMatchObject({
      requested: expect.any(Number),
      reused: 0,
    });
    expect(
      Number((await translateStep(e))!.output.translation.requested),
    ).toBeGreaterThan(0);
    // Nothing was written again; the receipts now carry the current keys.
    expect((await layersRow(e))!.sha256).toBe(layersSha);
    const store = new DocumentLayersStore(e.app.database, e.app.files);
    const now = await main(e);
    expect(now.steps.find((s) => s.step === "layers")).toMatchObject({
      status: "done",
      calls: 0,
      input_sha256: await archiveStepKey("", "full", now, "layers", null, null),
    });
    expect(now.steps.find((s) => s.step === "translate")).toMatchObject({
      status: "done",
      calls: 0,
      input_sha256: await archiveStepKey(
        "",
        "full",
        now,
        "translate",
        null,
        null,
        "zh-Hans",
        await store.originalSha256({
          literature_id: e.id,
          asset_id: now.asset_id,
          document_version_id: now.document_version_id!,
          content_version: now.content_version!,
        }),
      ),
    });
  } finally {
    await e.close();
  }
}, 0);
