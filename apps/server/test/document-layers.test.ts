import { createHash } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { canonicalJsonBytes, parseArtifactRef } from "@sciretriever/contracts";
import { DocumentLayersStore } from "../src/layers/document.js";
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
  type LayersTranslationInput,
} from "./core-processing-fixture.js";

// Spec 10.8: the layers step and its reads, with the fake model only.
const sentences = (topic: string, from: number) =>
  Array.from(
    { length: 5 },
    (_, i) =>
      `The ${topic} sample ${from + i} showed a stable synthetic spectrum near ${400 + from + i} nm in water.`,
  ).join(" ");
const SECTIONS = ["Introduction", "Methods", "Results", "Conclusion"];
/** About 3,400 code points of body text: enough for reading layers. */
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
async function fixture(
  options: Parameters<typeof archiveFixture>[0] = {},
  text = LONG_TEXT,
): Promise<
  Fixture & {
    layersInputs: string[];
    translationInputs: LayersTranslationInput[];
  }
> {
  const e = await archiveFixture({ offline: true, ...options });
  // No real source or model can be reached: the provider is a closed loopback port.
  expect(e.app.configuration.providers.fixture?.base_url).toBe(
    "http://127.0.0.1:9/v1",
  );
  e.setText(text);
  const layersInputs: string[] = [],
    translationInputs: LayersTranslationInput[] = [];
  e.setLayers((input) => {
    layersInputs.push(input);
    return defaultLayersReply(input);
  });
  e.setLayersTranslation((input) => {
    translationInputs.push(input);
    return defaultLayersTranslationReply(input);
  });
  return Object.assign(e, { layersInputs, translationInputs });
}
const main = async (e: Fixture) =>
  (await e.app.archive.status(e.id)).parts.find((p) => p.part === "main")!;
const step = async (e: Fixture) =>
  (await main(e)).steps.find((s) => s.step === "layers") as
    | (ArchiveStepReceipt & { output: { layers: Record<string, unknown> } })
    | undefined;
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

it("produces, checks and publishes the layers; reads overview, outline, three texts and Markdown", async () => {
  const e = await fixture();
  try {
    await e.submit("layers-all");
    expect((await e.app.archive.status(e.id)).status).toBe("READY");
    const receipt = (await step(e))!;
    expect(receipt).toMatchObject({ status: "done", reason: null });
    expect(receipt.output.layers).toMatchObject({
      status: "complete",
      redone: "all",
      given: 6,
      points: 6,
      translation: { status: "done", target_language: "zh-Hans" },
    });
    // Two calls: the layers and their translation part.
    expect(receipt.calls).toBe(2);
    expect(e.layersInputs).toHaveLength(1);
    expect(e.translationInputs).toHaveLength(1);
    // The input: numbered paragraphs and sentences, headings as heading lines.
    const input = e.layersInputs[0]!;
    expect(input).toMatch(/^Maximum number of points: 40\n/u);
    expect(input).toContain("# [s2] Introduction");
    expect(input).toMatch(/^\[p1\] <1> The abstract sample 1 showed/mu);
    expect(input).not.toContain("Example synthetic reference");
    const document_version_id = (await main(e)).document_version_id!;
    expect(await describe(e, document_version_id)).toEqual({
      state: "complete",
      points: 6,
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
      prompt_version: "reading-layers-v2",
    });
    expect(overview).not.toHaveProperty("machine_translation");
    // ADR 0070: summary, trunk with its basis, data, limits and advice.
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
      key_terms: ["spectra"],
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
    expect(overview.primary.map((p: { number: number }) => p.number)).toEqual([
      1, 2, 3,
    ]);
    expect(overview.primary[1].basis).toMatchObject({
      kind: "sentence",
      text: "The introduction sample 10",
      paragraph: 4,
      sentences: [1],
      fallback: false,
    });
    // Points grouped under the author's headings, without evidence.
    expect(
      overview.sections.map((s: { title: string | null }) => s.title),
    ).toEqual(["Abstract", "Introduction", "Methods", "Results"]);
    expect(overview.sections[1].points[0]).toEqual({
      number: 2,
      statement: "The paper states that The introduction sample 10 showed a.",
      key_terms: ["introduction"],
      section_id: overview.sections[1].section_id,
      section_title: "Introduction",
      primary: true,
      label: "introduction sample 10",
      kind: "result",
      relations: [{ word: "follows", targets: [{ kind: "point", number: 1 }] }],
    });
    // The outline pages by points; each evidence is the original sentence.
    const first = await layers(e, {
      document_version_id,
      part: "outline",
      limit: 4,
    });
    expect(first.points.map((p: { number: number }) => p.number)).toEqual([
      1, 2, 3, 4,
    ]);
    expect(first.total).toBe(6);
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
    expect(second.points.map((p: { number: number }) => p.number)).toEqual([
      5, 6,
    ]);
    expect(second.next_cursor).toBeNull();
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
    // Translation: statements, key terms and evidence from the stored translation.
    const translated = await layers(e, {
      document_version_id,
      part: "outline",
      text: "translation",
      limit: 2,
    });
    expect(translated).toMatchObject({
      machine_translation: true,
      target_language: "zh-Hans",
      untranslated: 0,
    });
    expect(translated.points[1]).toMatchObject({
      statement:
        "译文：The paper states that The introduction sample 10 showed a.",
      translated: true,
      key_terms: ["introduction"],
      label: "译文：introduction sample 10",
    });
    // The fake translation is the unit's whole text prefixed: sentence 1 of it.
    expect(translated.points[1].evidence[0]).toMatchObject({
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
    // The quantity is translated; the value never is.
    expect(both.data[0]).toMatchObject({
      value: "401 nm",
      translation: { quantity: "译文：Spectrum of the first sample" },
    });
    expect(both.primary[0].translation).toMatchObject({
      label: "译文：abstract sample 1",
    });
    // Markdown: the machine note first, the digest, headings and quoted evidence.
    const markdown = await layers(e, {
      document_version_id,
      part: "outline",
      format: "markdown",
      limit: 50,
    });
    expect(markdown.format).toBe("markdown");
    expect(markdown.markdown.split("\n")[0]).toBe(
      "> 要点与提要由机器写成，不是证据；依据是原文里的句子与图表。",
    );
    for (const heading of [
      "## 提要",
      "## 主干",
      "## 数据",
      "## 局限",
      "## 精读建议",
    ])
      expect(markdown.markdown).toContain(heading);
    expect(markdown.markdown).toContain(
      "| Spectrum of the first sample | 401 nm | ¶2 |",
    );
    expect(markdown.markdown).toContain(
      "- Only water was used as the medium.（¶2）",
    );
    expect(markdown.markdown).toContain("去处：Results → ¶9");
    expect(markdown.markdown).toContain(
      "> The introduction sample 10\n> — ¶4·1",
    );
    expect(markdown.markdown).toContain("## Introduction\n\n**2.** 〔结果〕");
    expect(markdown.markdown).toContain("（承接 1）");
    expect(markdown.markdown).toContain(
      "> The introduction sample 10 showed a stable synthetic spectrum near 410 nm in water.\n> — ¶4·1",
    );
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
      total: 6,
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

it("drops evidence that names nothing, points without evidence and key terms not in the statement, and numbers again", async () => {
  const e = await fixture();
  try {
    e.setLayers((input) => {
      e.layersInputs.push(input);
      const base = defaultLayersReply(input);
      return {
        digest: {
          ...base.digest,
          summary: { ...base.digest.summary, units: ["p1", "p99", "f1"] },
        },
        data: [],
        // Every point carries every field the schema asks for.
        points: (
          [
            {
              statement:
                "The paper states that The methods second sample 25 showed a.",
              evidence: ["p5.1", "p999.1", "p5.9"],
              primary: true,
              key_terms: ["second sample", "absent term", "methods", "showed"],
            },
            {
              statement: "Only evidence that names nothing.",
              evidence: ["p1.1-5", "p1.1,3", "f1", "nonsense"],
              key_terms: [],
            },
            {
              statement:
                "The paper states that The introduction sample 10 showed a.",
              evidence: ["p2.1-2", "p2.1-2"],
              primary: true,
              key_terms: ["introduction"],
            },
            {
              statement:
                "The paper states that The methods sample 22 showed a.",
              evidence: ["p4.3"],
              primary: true,
              key_terms: ["sample 22"],
            },
            { statement: " ", evidence: ["p4.1"], key_terms: [] },
            { statement: "x".repeat(301), evidence: ["p4.2"], key_terms: [] },
          ] as Record<string, unknown>[]
        ).map((p) => ({
          primary: false,
          label: null,
          kind: null,
          relations: [],
          basis: null,
          ...p,
        })),
      };
    });
    await e.submit("layers-drops");
    const receipt = (await step(e))!;
    expect(receipt).toMatchObject({ status: "done" });
    expect(receipt.output.layers).toMatchObject({
      given: 6,
      points: 3,
      dropped: { evidence: 7, points: 3, key_terms: 2, digest_units: 2 },
    });
    const document_version_id = (await main(e)).document_version_id!;
    const outline = await layers(e, { document_version_id, part: "outline" });
    // Ordered by their first evidence and numbered again.
    expect(
      outline.points.map((p: { number: number; statement: string }) => [
        p.number,
        p.statement,
      ]),
    ).toEqual([
      [1, "The paper states that The introduction sample 10 showed a."],
      [2, "The paper states that The methods sample 22 showed a."],
      [3, "The paper states that The methods second sample 25 showed a."],
    ]);
    expect(outline.points[0].evidence).toEqual([
      expect.objectContaining({ sentences: [1, 2], paragraph: 4 }),
    ]);
    expect(outline.points[1].evidence[0]).toMatchObject({
      sentences: [3],
      text: "The methods sample 22 showed a stable synthetic spectrum near 422 nm in water.",
    });
    // At most two key terms, each found in its statement.
    expect(outline.points[2].key_terms).toEqual(["second sample", "methods"]);
    const overview = await layers(e, { document_version_id, part: "overview" });
    expect(overview.summary.units).toHaveLength(1);
  } finally {
    await e.close();
  }
}, 0);

it("fails when too few points are left, keeps the full text ready, and redoes the step on resume", async () => {
  const e = await fixture();
  try {
    e.setLayers((input) => {
      e.layersInputs.push(input);
      const base = defaultLayersReply(input);
      return {
        ...base,
        points: base.points.map((p, i) =>
          i < 2 ? p : { ...p, evidence: ["p999.1"] },
        ),
      };
    });
    await e.submit("layers-too-few");
    const state = await e.app.archive.status(e.id);
    expect(state.status).toBe("READY");
    const failed = (await step(e))!;
    expect(failed).toMatchObject({
      status: "failed",
      reason: "layers-incomplete",
    });
    expect(failed.output.layers).toMatchObject({ given: 6, points: 2 });
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
    // Resume: the step runs again; a cut-off answer is asked once more for half the points.
    let asked = 0;
    e.setLayers((input) => {
      e.layersInputs.push(input);
      return asked++ ? defaultLayersReply(input) : { truncated: true };
    });
    await e.submit("layers-resume");
    expect(e.layersInputs.slice(-2).map((i) => i.split("\n")[0])).toEqual([
      "Maximum number of points: 40",
      "Maximum number of points: 20",
    ]);
    expect(await step(e)).toMatchObject({ status: "done", calls: 3 });
    expect(
      (await e.app.archive.status(e.id)).issues.find((i) => i.step === "layers")
        ?.resolution,
    ).toBe("continue");
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
    expect(e.layersInputs).toEqual([]);
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
      expect(JSON.stringify(result.structuredContent)).toContain(
        '"code":"layers-unavailable"',
      );
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
    expect(e.layersInputs).toEqual([]);
  } finally {
    await e.close();
  }
}, 0);

it("redoes only the translation part when only the translation changed", async () => {
  const e = await fixture();
  try {
    // First the translation misses the second Methods paragraph.
    e.setTranslation((input) => ({
      translations: input.units
        .filter((u) => !u.text.includes("methods second sample"))
        .map((u) => ({ id: u.id, translation: `译文：${u.text}` })),
    }));
    await e.submit("layers-partial-translation");
    expect(
      (await main(e)).steps.find((s) => s.step === "translate"),
    ).toMatchObject({ status: "failed", reason: "translation-incomplete" });
    const before = (await step(e))!;
    expect(before).toMatchObject({ status: "done" });
    const document_version_id = (await main(e)).document_version_id!;
    const partial = await layers(e, {
      document_version_id,
      part: "outline",
      text: "translation",
    });
    // Evidence on the untranslated unit keeps the original.
    expect(partial.points[4].evidence[0]).toMatchObject({
      translated: false,
      aligned: false,
      text: expect.stringContaining("The methods second sample 25"),
    });
    e.setTranslation((input) => ({
      translations: input.units.map((u) => ({
        id: u.id,
        translation: `译文：${u.text}`,
      })),
    }));
    await e.submit("layers-full-translation");
    const after = (await step(e))!;
    expect(after.output.layers).toMatchObject({
      redone: "translation",
      translation: { status: "done" },
    });
    expect(after.output.layers.sha256).not.toBe(before.output.layers.sha256);
    // One more translation call; the layers themselves were not asked again.
    expect(e.layersInputs).toHaveLength(1);
    expect(e.translationInputs).toHaveLength(2);
    expect(after.calls).toBe(1);
    const full = await layers(e, {
      document_version_id,
      part: "outline",
      text: "translation",
    });
    expect(full.points[4].evidence[0]).toMatchObject({
      translated: true,
      aligned: true,
    });
    expect(await describe(e, document_version_id)).toMatchObject({
      target_language: "zh-Hans",
    });
  } finally {
    await e.close();
  }
}, 0);

it("drops renderings not found in the translation and leaves unaligned evidence without a position", async () => {
  const e = await fixture();
  try {
    e.setLayersTranslation((input) => {
      e.translationInputs.push(input);
      const reply = defaultLayersTranslationReply(input);
      return {
        items: reply.items.map((item) =>
          item.id === "k1"
            ? {
                ...item,
                key_terms: item.key_terms.map((k) => ({
                  ...k,
                  translation: "不存在的词",
                })),
                evidence: item.evidence.map((x) => ({ ...x, sentences: [7] })),
              }
            : item.id === "k2"
              ? {
                  ...item,
                  evidence: item.evidence.map((x) => ({
                    ...x,
                    sentences: [1, 3],
                  })),
                }
              : item,
        ),
      };
    });
    await e.submit("layers-translation-checks");
    const receipt = (await step(e))!;
    expect(receipt.output.layers.translation).toMatchObject({
      status: "done",
      key_terms_dropped: 1,
      evidence_dropped: 2,
      aligned: 4,
    });
    // The second call got each evidence with its unit's translation in numbered sentences.
    const sent = e.translationInputs[0]!;
    expect(sent.units[0]!.sentences[0]).toEqual({
      n: 1,
      text: "译文：The abstract sample 1 showed a stable synthetic spectrum near 401 nm in water.",
    });
    const document_version_id = (await main(e)).document_version_id!;
    const outline = await layers(e, {
      document_version_id,
      part: "outline",
      text: "translation",
    });
    expect(outline.points[0].key_terms).toEqual([]);
    // Without a confirmed position the whole unit's translation is given.
    expect(outline.points[0].evidence[0]).toMatchObject({
      translated: true,
      aligned: false,
      text: expect.stringMatching(
        /^译文：The abstract sample 1 .* sample 5 .*water\.$/u,
      ),
    });
    expect(outline.points[1].evidence[0]).toMatchObject({ aligned: false });
    expect(outline.points[2].evidence[0]).toMatchObject({ aligned: true });
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
      translation: { status: "not-needed" },
    });
    expect(e.translationInputs).toEqual([]);
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
    expect(e.layersInputs).toHaveLength(2);
    expect((await step(e))!.output.layers).toMatchObject({ redone: "all" });
    // from_step layers redoes them although nothing changed.
    await e.submit("layers-from-step", undefined, "layers");
    expect(e.layersInputs).toHaveLength(3);
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

it("fails the step when fewer than three primary points are left, the full text staying ready", async () => {
  const e = await fixture();
  try {
    e.setLayers((input) => {
      e.layersInputs.push(input);
      const base = defaultLayersReply(input);
      return {
        ...base,
        points: base.points.map((p, i) => ({ ...p, primary: i < 2 })),
      };
    });
    await e.submit("layers-few-primary");
    expect((await e.app.archive.status(e.id)).status).toBe("READY");
    const failed = (await step(e))!;
    expect(failed).toMatchObject({
      status: "failed",
      reason: "layers-incomplete",
    });
    expect(failed.output.layers).toMatchObject({ primary: 2, points: 6 });
  } finally {
    await e.close();
  }
}, 0);

it("reads layers of an earlier file version as stale and redoes them on the next archive", async () => {
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
    const old = { ...(await store.load(row)), schema_version: 1 };
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
    // A receipt of the earlier release has an input key without the file
    // version, so archiving again redoes the layers as a whole.
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
    expect(e.layersInputs).toHaveLength(2);
    expect((await step(e))!.output.layers).toMatchObject({ redone: "all" });
    expect(await describe(e, key.document_version_id)).toMatchObject({
      state: "complete",
    });
  } finally {
    await e.close();
  }
}, 0);
