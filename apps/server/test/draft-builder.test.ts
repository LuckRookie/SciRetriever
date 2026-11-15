import { performance } from "node:perf_hooks";
import { expect, it, vi } from "vitest";
import {
  canonicalJsonBytes,
  parseRawParseInput,
  rawParseIdentity,
  parseDocumentMaterialRef,
  type RawBlockType,
  type DraftContent,
} from "@sciretriever/contracts";
import {
  buildDraftDocument,
  rebuildDraftDocument,
  renderDraftContent,
  compareDraftLeaves,
  draftMethodHash,
  pageLayerHash,
  draftComparisonText,
} from "../src/document/draft-builder.js";
import {
  byteHash,
  prepareArrangementSource,
} from "../src/archive/text-source.js";
import { arrangementLeafId } from "../src/archive/arrangement.js";
import { paragraphBreakEvidenceForBody } from "../src/archive/paragraph-breaks.js";
import { documentIdentity } from "../src/document/proofread-publication.js";
import { pageReviewPlan, reviewTokens } from "../src/proofread/page-review.js";
import { DshAgentRuntime } from "../src/agents/dsh/runtime.js";
import type { ProofreadInputReader } from "../src/proofread/draft.js";
import type { PdfPageInspection } from "../src/browser/pdf-region.js";
import { archiveTextFixture, imageBytes } from "./archive-text-fixture.js";

type Block = {
  text: string;
  page?: number;
  type?: RawBlockType;
  html?: string;
  image?: boolean;
  title_level?: number;
  font_size?: number;
  bbox?: readonly [number, number, number, number];
};
/** Valid, deterministic multi-page PDF; inspections are supplied as pure inputs. */
function pdf(pages: readonly PdfPageInspection[]) {
  const objects = [
    "",
    "",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  const kids: number[] = [];
  for (const page of pages) {
    const id = objects.length + 1;
    kids.push(id);
    const printed = page.text
      .replace(/[\\()]/gu, "\\$&")
      .replace(/[\r\n]+/gu, " ");
    const stream = `BT /F1 12 Tf 40 740 Td (${printed}) Tj ET`;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${id + 1} 0 R >>`,
      `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    );
  }
  objects[0] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[1] = `<< /Type /Pages /Kids [${kids.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`;
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((object, i) => {
    offsets.push(Buffer.byteLength(body));
    body += `${i + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(body);
  return Buffer.from(
    body +
      `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` +
      offsets.map((n) => `${String(n).padStart(10, "0")} 00000 n \n`).join("") +
      `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`,
  );
}
async function fixture(
  values: readonly Block[],
  layers?: readonly string[],
  kinds?: readonly PdfPageInspection["kind"][],
  markdownOnly = false,
) {
  const f = await archiveTextFixture(
    values,
    layers ? { layers, page_count: layers.length } : {},
  );
  const blocks = JSON.parse(Buffer.from(f.bytes).toString("utf8"));
  for (const [i, value] of values.entries()) {
    blocks.blocks[i].bbox = value.bbox ?? [0, 200, 900, 300];
    if (value.title_level !== undefined)
      blocks.blocks[i].title_level = value.title_level;
  }
  const bytes = canonicalJsonBytes(blocks);
  const pages = f.pages.map((p): PdfPageInspection => {
    const kind = kinds?.[p.page] ?? p.kind;
    const items = values.flatMap((v, i) => {
      if ((v.page ?? 0) !== p.page || !v.font_size) return [];
      const b = blocks.blocks[i].bbox as number[];
      return [
        {
          bbox: [
            b[0]! * 0.595 + 1,
            b[1]! * 0.842 + 1,
            b[2]! * 0.595 - 1,
            b[3]! * 0.842 - 1,
          ] as const,
          font_size: v.font_size,
          font: "Synthetic",
          length: v.text.length,
        },
      ];
    });
    return {
      ...p,
      kind,
      ...(items.length ? { layout: { width: 595, height: 842, items } } : {}),
    };
  });
  const markdown = f.markdown.length ? f.markdown : Buffer.from("\n");
  const original = pdf(pages),
    sourceHash = byteHash(original);
  const input = parseRawParseInput({
    ...f.input,
    source_sha256: sourceHash,
    markdown: {
      ...f.input.markdown,
      sha256: byteHash(markdown),
      byte_size: markdown.length,
    },
    blocks: markdownOnly
      ? null
      : { ...f.input.blocks, sha256: byteHash(bytes), byte_size: bytes.length },
    profile: markdownOnly ? "vlm-engine-markdown-only" : f.input.profile,
    page_sizes: markdownOnly ? [] : f.input.page_sizes,
    private_content_list: markdownOnly ? null : f.input.private_content_list,
  });
  const raw = { ...input, ...(await rawParseIdentity(input)) };
  const read = vi.fn<ProofreadInputReader["readArtifact"]>(
    async (id, kind, ref) => {
      if (id !== raw.raw_parse_id)
        throw new Error("Unexpected synthetic raw ID");
      if (kind === "image") {
        if (ref !== "images/fixture.png")
          throw new Error("Unknown synthetic image");
        return imageBytes;
      }
      return kind === "blocks" ? bytes : markdown;
    },
  );
  const reader = { readArtifact: read };
  const material = parseDocumentMaterialRef({
    literature_id: "00000000-0000-0000-0000-000000000851",
    asset_id: raw.source_asset_id,
    asset_sha256: sourceHash,
    byte_size: original.length,
    media_type: "application/pdf",
    artifact: {
      sha256: sourceHash,
      byte_size: original.length,
      media_type: "application/pdf",
    },
  });
  return {
    raw,
    reader,
    pages,
    material,
    original,
    bytes,
    build: (signal?: AbortSignal) =>
      buildDraftDocument(
        raw,
        reader,
        pages,
        material,
        signal ? { signal } : {},
      ),
  };
}

it("forms an exact draft without model/network calls and reconstructs sealed bytes without raw inputs", async () => {
  const f = await fixture([
    { text: "A stable synthetic paragraph." },
    { text: "Another exact paragraph." },
  ]);
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    throw new Error("Network forbidden");
  });
  const model = vi
    .spyOn(DshAgentRuntime.prototype, "createSession")
    .mockImplementation(() => {
      throw new Error("Model forbidden");
    });
  try {
    const first = await f.build(),
      second = await f.build();
    expect(first.structure.segments.map((s) => s.basis)).toEqual([
      "text-layer-match",
      "text-layer-match",
    ]);
    expect(first.counts).toEqual({
      differs_segments: 0,
      differences: 0,
      image_only_pages: 0,
    });
    expect(first.document).toEqual(second.document);
    expect(first.document.document_id).toBe(
      documentIdentity(f.material.literature_id, f.material.asset_id),
    );
    expect(first.content_bytes).toEqual(second.content_bytes);
    expect(first.markdown.toString()).toBe(
      "A stable synthetic paragraph.\n\nAnother exact paragraph.\n\n",
    );
    expect(first.structure_bytes).toEqual(second.structure_bytes);
    expect(first.document.schema_version).toBe(3);
    expect(first.document.builder_version).toBe("draft-leaves-v1");
    expect(first.document.page_layer_sha256).toBe(pageLayerHash(f.pages));
    const changedMethod = await buildDraftDocument(
      f.raw,
      f.reader,
      f.pages,
      f.material,
      { correct_reading_order: true },
    );
    expect(changedMethod.document.draft_method_sha256).not.toBe(
      first.document.draft_method_sha256,
    );
    expect(changedMethod.document.document_version_id).not.toBe(
      first.document.document_version_id,
    );
    expect(changedMethod.markdown).toEqual(first.markdown);
    expect(
      draftMethodHash({ ...first.content.method, reading_order: true }),
    ).not.toBe(first.document.draft_method_sha256);
    f.reader.readArtifact.mockImplementation(async () => {
      throw new Error("Raw reader forbidden during reconstruction");
    });
    const rebuilt = await rebuildDraftDocument(
      first.document,
      first.content_bytes,
    );
    expect(rebuilt.markdown).toEqual(first.markdown);
    expect(rebuilt.structure_bytes).toEqual(first.structure_bytes);
    expect(rebuilt.counts).toEqual(first.counts);
    expect(network).not.toHaveBeenCalled();
    expect(model).not.toHaveBeenCalled();
    const changed = new Uint8Array(first.content_bytes);
    changed[10] = changed[10]! ^ 1;
    await expect(
      rebuildDraftDocument(first.document, changed),
    ).rejects.toMatchObject({ code: "source-integrity" });
    await expect(
      rebuildDraftDocument(
        { ...first.document, raw_parse_id: f.material.asset_id },
        first.content_bytes,
      ),
    ).rejects.toMatchObject({ code: "source-integrity" });
  } finally {
    network.mockRestore();
    model.mockRestore();
  }
});

it("records only the wrong leaf, retaining differences on an untrusted whole page", async () => {
  const f = await fixture(
    [
      { text: "The sample was heated to 50 degrees and then cooled." },
      { text: "This exact leaf is present." },
      { text: "These unrelated tokens occur only inside the diagram." },
    ],
    [
      "The sample was heated to 60 degrees and then cooled. This exact leaf is present.",
    ],
  );
  const result = await f.build();
  expect(result.structure.segments.map((s) => s.basis)).toEqual([
    "text-layer-differs",
    "text-layer-match",
    "no-text-layer",
  ]);
  expect(result.content.leaves[0]!.differences).toEqual([
    {
      leaf_id: result.structure.segments[0]!.segment_id,
      page_index: 0,
      kind: "mismatch",
      parsed: "50",
      text_layer: "60",
      other_page_index: null,
    },
  ]);
  expect(result.counts).toEqual({
    differs_segments: 1,
    differences: 1,
    image_only_pages: 0,
  });
  const low = await fixture(
    [
      { text: "A correct fragment" },
      { text: "one two three four five six seven eight nine ten" },
    ],
    ["A correct fragment one two three unrelated words"],
  );
  const b = await low.build();
  expect(b.content.leaves[0]!.basis).toBe("text-layer-match");
  expect(b.content.leaves[1]!.basis).toBe("text-layer-differs");
  const prepared = await prepareArrangementSource(
    low.raw,
    low.reader,
    low.pages,
  );
  const leaves = prepared.blocks.map((r) => ({
    leaf_id: arrangementLeafId(
      r.root_block_id,
      0,
      [...r.text].length,
      low.raw.result_sha256,
    ),
    source: {
      root_block_id: r.root_block_id,
      source_sha256: r.source_sha256,
      start: 0,
      end: [...r.text].length,
    },
    type: r.type,
    original_text: r.text,
    page_index: r.page_hint,
    region: r.region_hint,
    image_ref: r.image_ref,
  }));
  expect(pageReviewPlan(low.pages[0]!, leaves).trusted).toBe(false);
  expect(pageReviewPlan(low.pages[0]!, leaves).differences).toEqual([]);
});

it("compares visible HTML table words and all specified entities rather than markup", async () => {
  const html =
    "<table><tr><td>Alpha &amp; beta</td><td>yield &#54;7 &#x43; &nbsp; &quot;value&quot; &apos;word&apos; &lt;x&gt; &unknown;</td></tr></table>";
  const f = await fixture(
    [{ type: "table", text: "", html }],
    ["Alpha & beta yield 67 C \"value\" 'word' <x>"],
  );
  const b = await f.build();
  expect(b.content.leaves[0]!.basis).toBe("text-layer-match");
  expect(b.content.leaves[0]!.differences).toEqual([]);
  expect(b.markdown.toString()).toContain(html);
  expect(reviewTokens(html)).not.toEqual(
    reviewTokens(draftComparisonText(html)),
  );
  const source = await prepareArrangementSource(f.raw, f.reader, f.pages);
  const root = source.blocks[0]!;
  const unclean = pageReviewPlan(f.pages[0]!, [
    {
      leaf_id: arrangementLeafId(
        root.root_block_id,
        0,
        [...root.text].length,
        f.raw.result_sha256,
      ),
      source: {
        root_block_id: root.root_block_id,
        source_sha256: root.source_sha256,
        start: 0,
        end: [...root.text].length,
      },
      type: root.type,
      original_text: root.text,
      page_index: 0,
      region: root.region_hint,
      image_ref: null,
    },
  ]);
  expect(unclean.clean).toBe(true);
  // Old proofreading cannot call this table a clean exact transcription.
  expect(unclean.trusted && unclean.differences.length === 0).toBe(false);
});

it("handles symbol-only equations, scans, blank pages, drawings and a unique elsewhere page", async () => {
  const f = await fixture(
    [
      { text: "\\frac{}{}\\sum", type: "equation", image: true },
      { text: "", type: "image", image: true },
      { text: "chemical labels unseen in text layer", type: "caption" },
      { text: "wrong page four distinct tokens", page: 0 },
      { text: "scan text", page: 1 },
      { text: "blank page parser text", page: 2 },
    ],
    ["other local words", "", "", "wrong page four distinct tokens"],
    ["text-layer", "image-only", "blank", "text-layer"],
  );
  const b = await f.build();
  expect(b.content.leaves.map((l) => l.basis)).toEqual([
    "no-text-layer",
    "no-text-layer",
    "no-text-layer",
    "text-layer-differs",
    "no-text-layer",
    "no-text-layer",
  ]);
  expect(b.content.leaves[3]!.differences[0]).toMatchObject({
    kind: "elsewhere",
    other_page_index: 3,
    text_layer: "",
    parsed: "wrong page four distinct tokens",
  });
  expect(b.counts.image_only_pages).toBe(1);
  expect(b.markdown.toString()).toContain("$$\n\\frac{}{}\\sum\n$$");
  expect(
    b.markdown.toString().match(/!\[\]\(images\/fixture.png\)/gu),
  ).toHaveLength(1);
  expect(
    (await rebuildDraftDocument(b.document, b.content_bytes)).resources,
  ).toEqual(b.resources);
  const equation = await fixture(
    [{ text: "x + y", type: "equation", image: true }],
    ["x + y"],
  );
  const eq = await equation.build();
  expect(eq.resources).toEqual([]);
  expect(eq.markdown.toString()).toBe("$$\nx + y\n$$\n\n");
  const fallback = await fixture(
    [{ text: "", type: "equation", image: true }],
    [""],
  );
  expect((await fallback.build()).markdown.toString()).toBe(
    "![](images/fixture.png)\n\n\n",
  );
});

it("does not classify an ambiguous other page or fewer than four distinct words as elsewhere", async () => {
  const a = await fixture(
    [{ text: "unique four different words", page: 0 }],
    ["unrelated", "unique four different words", "unique four different words"],
  );
  expect((await a.build()).content.leaves[0]!.basis).toBe("no-text-layer");
  const b = await fixture(
    [{ text: "three different words", page: 0 }],
    ["unrelated", "three different words"],
  );
  expect((await b.build()).content.leaves[0]!.basis).toBe("no-text-layer");
});

it("merges only automatic breaks, takes the worst leaf basis and keeps each leaf on its own page", async () => {
  const f = await fixture(
    [
      { text: "first clause continues", page: 0 },
      { text: "drawing phrase continues", page: 1 },
      { text: "last clause 50 ends.", page: 2 },
    ],
    ["first clause continues", "unrelated layer", "last clause 60 ends."],
  );
  const b = await f.build();
  expect(b.structure.segments).toHaveLength(1);
  expect(b.content.leaves.map((l) => l.basis)).toEqual([
    "text-layer-match",
    "no-text-layer",
    "text-layer-differs",
  ]);
  const segment = b.structure.segments[0]!;
  expect(segment).toMatchObject({
    segment_id: b.content.leaves[0]!.leaf_id,
    block_id: b.content.leaves[0]!.leaf_id,
    page: 0,
    basis: "text-layer-differs",
    source: "rule",
  });
  expect(segment.continuation_regions.map((r) => r.page)).toEqual([1, 2]);
  expect(b.segment_leaves[0]!.differences).toEqual(
    b.content.leaves.flatMap((l) => l.differences),
  );
  expect(b.segment_leaves[0]!.differences[0]!.page_index).toBe(2);
  expect(b.markdown.toString()).toBe(
    "first clause continues drawing phrase continues last clause 50 ends.\n\n",
  );
  const noRegion: DraftContent = {
    ...b.content,
    source_blocks: b.content.source_blocks.map((root, i) =>
      i === 1 ? { ...root, region_hint: null } : root,
    ),
  };
  const rebuilt = await renderDraftContent(noRegion, []);
  expect(
    rebuilt.structure.segments[0]!.continuation_regions.map((r) => r.page),
  ).toEqual([2]);
});

it("records chrome drops, preserves bibliography/copyright/interface text, and leaves uncertain breaks alone", async () => {
  const f = await fixture([
    { text: "Journal header", type: "header" },
    { text: "A sentence ends.", page: 0 },
    { text: "next paragraph begins", page: 1 },
    { text: "DOI: 10.5555/synthetic", type: "text", page: 1 },
    { text: "© 2026 Synthetic copyright", page: 1 },
    { text: "Publisher interface", type: "aside", page: 1 },
    { text: "2", type: "page-number", page: 1 },
  ]);
  const b = await f.build();
  expect(
    b.content.operations.filter((o) => o.kind === "drop").map((o) => o.reason),
  ).toEqual(["header", "footer"]);
  expect(b.content.operations.some((o) => o.kind === "merge")).toBe(false);
  expect(b.markdown.toString()).toContain("DOI: 10.5555/synthetic");
  expect(b.markdown.toString()).toContain("© 2026 Synthetic copyright");
  expect(b.markdown.toString()).toContain("Publisher interface");
  expect(b.markdown.toString()).not.toContain("Journal header");
  expect(
    b.structure.sections.every(
      (s) => s.role === null && s.role_source === null,
    ),
  ).toBe(true);
  expect(b.structure).not.toHaveProperty("layout");
});

it("does not skip first-page text or title/list/equation/reference blockers between body leaves", async () => {
  for (const type of [
    "text",
    "title",
    "list",
    "equation",
    "reference",
    "discarded",
  ] as const) {
    const f = await fixture([
      { text: "A broken fragment", bbox: [20, 200, 400, 300] },
      {
        text:
          type === "text" ? "University Author Address." : "Standalone blocker",
        type,
        bbox: [20, 400, 400, 500],
      },
      { text: "continuation text", bbox: [550, 50, 950, 150] },
    ]);
    const b = await f.build();
    const merges = b.content.operations.filter((o) => o.kind === "merge");
    const first = b.content.leaves[0]!.leaf_id,
      last = b.content.leaves[2]!.leaf_id;
    expect(
      merges.some(
        (o) => o.leaf_ids.includes(first) && o.leaf_ids.includes(last),
      ),
    ).toBe(false);
  }
});

it("keeps a measured layout candidate for model review separate in the draft", async () => {
  const values = Array.from(
    { length: 5 },
    (_, i): Block => ({
      text: `A complete synthetic statement ${i}.`,
      page: i === 4 ? 1 : 0,
      bbox: [20, 120 + (i % 4) * 180, 420, 240 + (i % 4) * 180],
    }),
  );
  const f = await fixture(values);
  for (const page of f.pages) {
    const items = values.flatMap((v, i) => {
      if ((v.page ?? 0) !== page.page) return [];
      const box = v.bbox!;
      return [0, 1, 2].map((line) => ({
        bbox: [
          box[0] * 0.595 + (line === 0 && i < 4 ? 12 : 0),
          box[1] * 0.842 + 12 * line,
          box[2] * 0.595,
          box[1] * 0.842 + 12 * line + 8,
        ] as const,
        font_size: 10,
        font: "Synthetic",
        length: 15,
      }));
    });
    f.pages[page.page] = {
      ...page,
      layout: { width: 595, height: 842, items },
    };
  }
  const b = await f.build();
  const source = await prepareArrangementSource(f.raw, f.reader, f.pages);
  const leaves = source.blocks.map((root) => ({
    leaf_id: arrangementLeafId(
      root.root_block_id,
      0,
      [...root.text].length,
      f.raw.result_sha256,
    ),
    source: {
      root_block_id: root.root_block_id,
      source_sha256: root.source_sha256,
      start: 0,
      end: [...root.text].length,
    },
    type: root.type,
    original_text: root.text,
    page_index: root.page_hint,
    region: root.region_hint,
    image_ref: root.image_ref,
  }));
  const proof = paragraphBreakEvidenceForBody(
    source,
    leaves,
    () => true,
    () => false,
  )(leaves[3]!, leaves[4]!, []);
  expect(proof).toMatchObject({
    candidate: true,
    basis: "layout",
    automatic: false,
  });
  expect(b.content.operations.some((op) => op.kind === "merge")).toBe(false);
  expect(b.structure.segments).toHaveLength(5);
});

it("keeps skipped floats out of a merged paragraph and preserves the hyphen seam", async () => {
  const f = await fixture([
    { text: "anti-", page: 0 },
    { text: "diagram", type: "image", image: true, page: 0 },
    { text: "inflammatory effect.", page: 1 },
  ]);
  const b = await f.build();
  expect(b.markdown.toString()).toBe(
    "anti-inflammatory effect.\n\n![](images/fixture.png)\ndiagram\n\n",
  );
  expect(b.content.operations.find((o) => o.kind === "merge")).toMatchObject({
    source: "program",
    rule: "paragraph-break-v3",
    joiners: [""],
  });
});

it("derives heading levels without roles, including the paper title in recurring-style statistics", async () => {
  const f = await fixture([
    {
      text: "Paper title",
      type: "title",
      title_level: 5,
      font_size: 18,
      bbox: [0, 100, 900, 150],
    },
    {
      text: "Detail A",
      type: "title",
      title_level: 5,
      font_size: 12,
      bbox: [0, 200, 900, 250],
    },
    {
      text: "Main section",
      type: "title",
      title_level: 5,
      font_size: 18,
      bbox: [0, 300, 900, 350],
    },
    {
      text: "Detail B",
      type: "title",
      title_level: 5,
      font_size: 12,
      bbox: [0, 400, 900, 450],
    },
  ]);
  const b = await f.build();
  expect(b.structure.sections.map((s) => s.level)).toEqual([2, 3, 2, 3]);
  expect(b.markdown.toString()).toBe(
    "## Paper title\n\n### Detail A\n\n## Main section\n\n### Detail B\n\n",
  );
  const fallback = await fixture([
    { text: "No heading before this paragraph." },
    { text: "1.2 Numbered section", type: "title", title_level: 5 },
    { text: "Plain heading", type: "title", title_level: 3 },
  ]);
  expect(
    (await fallback.build()).structure.sections.map((s) => [s.title, s.level]),
  ).toEqual([
    [null, 2],
    ["1.2 Numbered section", 3],
    ["Plain heading", 4],
  ]);
});

it("accepts uniquely located markdown-only input and maps ambiguity to needs-parse", async () => {
  const f = await fixture(
    [{ text: "# Unique heading\n\nThe unique body text." }],
    undefined,
    undefined,
    true,
  );
  const b = await f.build();
  expect(b.markdown.toString()).toContain("## Unique heading");
  expect(b.content.raw.profile).toBe("vlm-engine-markdown-only");
  const ambiguous = await fixture(
    [{ text: "Repeated text." }],
    ["Repeated text.", "Repeated text."],
    undefined,
    true,
  );
  await expect(ambiguous.build()).rejects.toMatchObject({
    code: "needs-parse",
  });
  const wordless = await fixture([{ text: "---" }], ["", ""], undefined, true);
  await expect(wordless.build()).rejects.toMatchObject({ code: "needs-parse" });
  const anchored = await fixture(
    [{ text: "Known words.\n\n---\n\nMore known words." }],
    ["Known words More known words", "other page words"],
    undefined,
    true,
  );
  expect(
    (await anchored.build()).content.leaves.every((l) => l.page_index === 0),
  ).toBe(true);
});

it("maps absent tools, source/hash tampering and cancellation without publishing anything", async () => {
  const f = await fixture([{ text: "Synthetic text", image: true }]);
  await expect(
    buildDraftDocument(f.raw, f.reader, null, f.material),
  ).rejects.toMatchObject({ code: "page-tools-unavailable" });
  await expect(
    buildDraftDocument(
      { ...f.raw, result_sha256: "0".repeat(64) as typeof f.raw.result_sha256 },
      f.reader,
      f.pages,
      f.material,
    ),
  ).rejects.toMatchObject({ code: "source-integrity" });
  const source = f.reader.readArtifact.getMockImplementation()!;
  f.reader.readArtifact.mockImplementation(async (id, kind, ref, signal) =>
    kind === "image"
      ? Buffer.alloc(imageBytes.length, 7)
      : source(id, kind, ref, signal),
  );
  await expect(f.build()).rejects.toMatchObject({ code: "source-integrity" });
  f.reader.readArtifact.mockImplementation(async () => {
    throw new Error("Synthetic source missing");
  });
  await expect(f.build()).rejects.toMatchObject({ code: "source-integrity" });
  const controller = new AbortController();
  controller.abort();
  await expect(f.build(controller.signal)).rejects.toMatchObject({
    code: "cancelled",
  });
  const unlisted = await fixture([{ text: "![unknown](images/unlisted.png)" }]);
  await expect(unlisted.build()).rejects.toMatchObject({
    code: "source-integrity",
  });
});

it("yields during long comparison loops and observes cancellation", async () => {
  const f = await fixture([{ text: "alpha beta gamma delta" }]);
  const source = await prepareArrangementSource(f.raw, f.reader, f.pages),
    root = source.blocks[0]!;
  const leaf = {
    leaf_id: arrangementLeafId(
      root.root_block_id,
      0,
      [...root.text].length,
      f.raw.result_sha256,
    ),
    source: {
      root_block_id: root.root_block_id,
      source_sha256: root.source_sha256,
      start: 0,
      end: [...root.text].length,
    },
    type: root.type,
    original_text: root.text,
    page_index: 0,
    region: root.region_hint,
    image_ref: null,
  };
  const controller = new AbortController();
  const task = compareDraftLeaves(
    Array.from({ length: 10000 }, () => leaf),
    f.pages,
    controller.signal,
  );
  setImmediate(() => controller.abort());
  await expect(task).rejects.toMatchObject({ code: "cancelled" });
});

it("uses cooperative source preparation without changing identities or legacy defaults", async () => {
  const f = await fixture([{ text: "A synthetic source." }]);
  const before = await prepareArrangementSource(f.raw, f.reader, f.pages);
  const after = await prepareArrangementSource(
    f.raw,
    f.reader,
    f.pages,
    undefined,
    { cooperative: true },
  );
  expect(canonicalJsonBytes(after)).toEqual(canonicalJsonBytes(before));
  const controller = new AbortController();
  const cancelled = new Error("Synthetic source cancellation");
  const reader: ProofreadInputReader = {
    readArtifact: async (...args) => {
      const bytes = await f.reader.readArtifact(...args);
      setImmediate(() => controller.abort(cancelled));
      return bytes;
    },
  };
  await expect(
    prepareArrangementSource(f.raw, reader, f.pages, controller.signal, {
      cooperative: true,
    }),
  ).rejects.toBe(cancelled);
});

it("rejects oversized body and sealed content using the real byte ceilings", async () => {
  const start = performance.now();
  const large = "a".repeat(3 * 1024 * 1024);
  const f = await fixture(
    Array.from({ length: 3 }, () => ({ text: large })),
    [""],
  );
  await expect(f.build()).rejects.toMatchObject({ code: "draft-too-large" });
  const g = await fixture(
    Array.from({ length: 6 }, () => ({ text: large })),
    [""],
  );
  await expect(g.build()).rejects.toMatchObject({ code: "draft-too-large" });
  console.info(
    `Draft real-size overflow checks: ${(performance.now() - start).toFixed(0)} ms (body >8 MiB; content >16 MiB).`,
  );
}, 120_000);
