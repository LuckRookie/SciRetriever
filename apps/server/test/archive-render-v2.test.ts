import { expect, it } from "vitest";
import {
  parseArchiveBuildRequest,
  parseArchiveTextBundleV2,
  parseProofreadVersionV2,
  verifyStructureAnnotation,
  type ArchiveTextBundleV2,
  type ArrangementOperation,
} from "@sciretriever/contracts";
import { archiveTextFixture, arranged } from "./archive-text-fixture.js";
import {
  renderArrangement,
  arrangementAnnotation,
  arrangedStructureSatisfied,
} from "../src/archive/render.js";
import {
  archiveTextVersion,
  pendingArchivePages,
} from "../src/archive/text-pipeline.js";
import { emptyArchiveUsage } from "../src/archive/text-session.js";
import { mapMarkdownEdit } from "../src/archive/markdown-edit.js";
import {
  reviewArrangement,
  acceptArrangement,
} from "../src/archive/arrangement.js";
const assigned = (
  id: string,
  role: import("@sciretriever/contracts").ArchiveSectionRole,
): Extract<ArrangementOperation, { kind: "assign" }> => ({
  kind: "assign",
  leaf_id: id,
  target:
    role === "additional" ? { role, original_heading_leaf_id: null } : { role },
  presentation: { kind: "content" },
});
const doc = "00000000-0000-0000-0000-000000000999";
function bundle(
  source: Awaited<ReturnType<typeof archiveTextFixture>>["source"],
  operations?: readonly ArrangementOperation[],
): ArchiveTextBundleV2 {
  const base = operations ?? arranged(source).operations,
    review = reviewArrangement(source, base);
  const snapshot = acceptArrangement(
      source,
      {
        schema_version: 1,
        source_input_sha256: source.input_sha256,
        reviewed_candidates_sha256: review.candidates_sha256,
        operations: base,
        break_decisions: review.candidates.map((c) =>
          base.some(
            (o) =>
              o.kind === "merge" &&
              o.leaf_ids.includes(c.left_leaf_id) &&
              o.leaf_ids.includes(c.right_leaf_id),
          )
            ? { candidate_id: c.candidate_id, decision: "merge" }
            : {
                candidate_id: c.candidate_id,
                decision: "keep",
                reason: "synthetic",
              },
        ),
      },
      "c".repeat(64),
    ),
    destinations = new Map(
      snapshot.destinations.map((d) => [d.leaf_id, d.destination]),
    );
  return parseArchiveTextBundleV2({
    schema_version: 2,
    page_count: source.raw.page_count,
    source_blocks: source.blocks,
    arrangement: snapshot,
    leaves: snapshot.leaves.map((leaf) => ({
      leaf,
      destination: destinations.get(leaf.leaf_id),
      corrected_text: leaf.original_text,
      correction_ids: [],
      text_source: "parser",
      basis: "text-layer",
    })),
  });
}
it("renders cross-footnote/figure/caption merges in place, with exact leaf payload ranges and retained resource closure", async () => {
  const f = await archiveTextFixture([
    { text: "Cross-" },
    { text: "Independent note.", type: "footnote" },
    { text: "", type: "image", image: true },
    { text: "Figure 1. Synthetic.", type: "caption" },
    { text: "page paragraph." },
    { text: "Keywords: exact.", type: "text" },
  ]);
  const leaves = arranged(f.source).leaves,
    ops: ArrangementOperation[] = leaves.map((l, i) => ({
      ...assigned(
        l.leaf_id,
        i === 1 ? "end-matter" : i === 5 ? "keywords" : "methods",
      ),
    }));
  ops.push(
    { kind: "merge", leaf_ids: [leaves[0]!.leaf_id, leaves[4]!.leaf_id] },
    {
      kind: "caption",
      object_leaf_id: leaves[2]!.leaf_id,
      caption_leaf_ids: [leaves[3]!.leaf_id],
      object_kind: "figure",
    },
  );
  const b = bundle(f.source, ops),
    rendered = renderArrangement(b, f.source.raw.resources),
    text = rendered.markdown.toString();
  expect(text).toContain("Cross-page paragraph.");
  expect(text.indexOf("Independent note.")).toBeGreaterThan(
    text.indexOf("Cross-page paragraph."),
  );
  expect(rendered.source_map).toHaveLength(6);
  for (const range of rendered.source_map)
    expect(
      rendered.markdown.subarray(range.start_utf8, range.end_utf8).toString(),
    ).toBe(leaves.find((l) => l.leaf_id === range.leaf_id)!.original_text);
  const a = arrangementAnnotation(doc, "main", b, rendered);
  expect(await verifyStructureAnnotation(a)).toEqual(a);
  expect(a.figures[0]!.caption_segment_ids).toEqual([leaves[3]!.leaf_id]);
  expect(
    a.segment_roles.find((s) => s.segment_id === leaves[1]!.leaf_id)!.role,
  ).toBe("end-matter");
  expect(a.sections.some((s) => s.role === "keywords")).toBe(true);
  expect(rendered.resources).toHaveLength(1);
});
it("keeps original subheadings and excludes heading-only sections from readiness", async () => {
  const f = await archiveTextFixture([
      { text: "Experimental Section", type: "title" },
    ]),
    leaf = arranged(f.source).leaves[0]!,
    b = bundle(f.source, [
      {
        ...assigned(leaf.leaf_id, "methods"),
        presentation: { kind: "subheading", level: 3 },
      },
    ]),
    rendered = renderArrangement(b, []),
    annotation = arrangementAnnotation(doc, "main", b, rendered);
  expect(rendered.markdown.toString()).toContain("### Experimental Section");
  expect(rendered.structure.sections).toHaveLength(1);
  expect(annotation.body_content_leaf_ids).toEqual([]);
  expect(arrangedStructureSatisfied(annotation, b)).toBe(false);
});
it("keeps first-page article information before the body instead of sorting by skeleton role", async () => {
  const f = await archiveTextFixture([
      { text: "Affiliation: Northlight Institute.", page: 0 },
      { text: "We introduce the work.", page: 0 },
      { text: "The work is concluded.", page: 2 },
    ]),
    [affiliation, intro, conclusion] = arranged(f.source).leaves,
    b = bundle(f.source, [
      assigned(affiliation!.leaf_id, "end-matter"),
      assigned(intro!.leaf_id, "introduction"),
      assigned(conclusion!.leaf_id, "conclusion"),
    ]),
    rendered = renderArrangement(b, []),
    text = rendered.markdown.toString();
  expect(text.indexOf("The work is concluded.")).toBeGreaterThan(
    text.indexOf("Affiliation: Northlight Institute."),
  );
  expect(rendered.structure.segments.map((s) => s.page)).toEqual([0, 0, 2]);
});
it("renders native headings once and adds display-math structure without altering formula payload", async () => {
  const f = await archiveTextFixture([
      { text: "Original title", type: "title" },
      { text: "Experimental Section", type: "title" },
      { text: "E = mc^2", type: "equation" },
      { text: "$$\nF = ma\n$$", type: "equation" },
    ]),
    leaves = arranged(f.source).leaves;
  const b = bundle(
      f.source,
      leaves.map((l, i) => ({
        ...assigned(l.leaf_id, i === 0 ? "title" : "methods"),
        presentation:
          i < 2
            ? { kind: "section-heading" as const }
            : { kind: "content" as const },
      })),
    ),
    r = renderArrangement(b, []),
    text = r.markdown.toString();
  expect(text).toContain(
    "# Original title\n\n## Experimental Section\n\n$$\nE = mc^2\n$$",
  );
  expect(text).not.toContain("## 标题");
  expect(text).not.toContain("## 方法");
  expect(text.match(/\$\$/gu)).toHaveLength(4);
  for (const span of r.source_map)
    expect(r.markdown.subarray(span.start_utf8, span.end_utf8).toString()).toBe(
      leaves.find((l) => l.leaf_id === span.leaf_id)!.original_text,
    );
  expect(
    r.structural_ranges.filter((s) => s.kind === "equation-delimiter"),
  ).toHaveLength(2);
});
it("keeps split copyright out of Markdown without changing any other code point", async () => {
  const f = await archiveTextFixture([
      { text: "ABSTRACT: A😀B. © 2001 Elsevier. All rights reserved." },
    ]),
    root = f.source.blocks[0]!,
    cut = [...root.text.slice(0, root.text.indexOf("©"))].length;
  const { arrangementLeafId } = await import("../src/archive/arrangement.js"),
    left = arrangementLeafId(
      root.root_block_id,
      0,
      cut,
      f.source.raw.result_sha256,
    ),
    right = arrangementLeafId(
      root.root_block_id,
      cut,
      [...root.text].length,
      f.source.raw.result_sha256,
    );
  const b = bundle(f.source, [
      { kind: "split", root_block_id: root.root_block_id, cuts: [cut] },
      assigned(left, "abstract"),
      { kind: "drop", leaf_id: right, reason: "copyright" },
    ]),
    r = renderArrangement(b, []);
  expect(r.markdown.toString()).toContain("ABSTRACT: A😀B. ");
  expect(r.markdown.toString()).not.toContain("©");
  expect(r.source_map.map((s) => s.leaf_id)).toEqual([left]);
});
it("validates new archive requests and immutable V2 manifests without accepting the old write contract", async () => {
  expect(
    parseArchiveBuildRequest({
      schema_version: 2,
      literature_id: doc,
      mode: "full",
      from_step: "proofread",
      retry_page_indexes: [0, 2],
    }).retry_page_indexes,
  ).toEqual([0, 2]);
  for (const old of [
    { literature_id: doc },
    { schema_version: 2, literature_id: doc, from_step: "document" },
  ])
    expect(() => parseArchiveBuildRequest(old)).toThrow(
      expect.objectContaining({ code: "archive-contract-obsolete" }),
    );
  expect(() =>
    parseArchiveBuildRequest({
      schema_version: 2,
      literature_id: doc,
      from_step: "proofread",
      retry_page_indexes: [0, 0],
    }),
  ).toThrow();
  const f = await archiveTextFixture([{ text: "Exact." }]),
    snapshot = arranged(f.source),
    output = await archiveTextVersion(
      f.source,
      snapshot,
      pendingArchivePages(f.source, snapshot),
      emptyArchiveUsage(),
      {
        arrange: "synthetic",
        page_classify: "synthetic",
        suspects: "synthetic",
        correction: "synthetic",
        model_config_sha256: null,
      },
      [],
      null,
    );
  expect(await parseProofreadVersionV2(output.version)).toEqual(output.version);
  await expect(
    parseProofreadVersionV2({ ...output.version, unexpected: 1 }),
  ).rejects.toThrow();
  await expect(
    parseProofreadVersionV2({
      ...output.version,
      content_sha256: "0".repeat(64),
    }),
  ).rejects.toThrow();
  expect(() =>
    parseArchiveTextBundleV2({ ...output.bundle, leaves: [] }),
  ).toThrow();
});
it("refuses structural or ambiguous Markdown edits while mapping a unique leaf edit", async () => {
  const f = await archiveTextFixture([
      { text: "A😀B." },
      { text: "Another paragraph." },
    ]),
    b = bundle(f.source),
    r = renderArrangement(b, []),
    text = r.markdown.toString();
  expect(
    mapMarkdownEdit(r.markdown, text.replace("A😀B.", "AβB."), r.source_map),
  ).toMatchObject({
    status: "mapped",
    changes: [{ leaf_id: b.leaves[0]!.leaf.leaf_id, text: "AβB." }],
  });
  expect(
    mapMarkdownEdit(r.markdown, "new document", r.source_map),
  ).toMatchObject({ status: "mapping-conflict" });
});
