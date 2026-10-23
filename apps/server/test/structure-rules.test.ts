import { describe, it, expect, vi } from "vitest";
import {
  parseDocumentStructureV2,
  parseSectionRole,
  type ProofreadSegmentKind,
} from "@sciretriever/contracts";
import {
  assignSectionRoles,
  ruleSectionRole,
} from "../src/document/section-rules.js";
import {
  segmentRoles,
  structureFigures,
  structureReferences,
  structureSatisfied,
} from "../src/document/structure-extract.js";
function document(
  items: readonly {
    text: string;
    level?: number;
    kind?: ProofreadSegmentKind;
  }[],
) {
  const parts: Buffer[] = [];
  const sections: {
    section_id: string;
    title: string;
    level: number;
    start_utf8: number;
    end_utf8: number;
    role: null;
    role_source: null;
  }[] = [];
  const segments = [];
  const stack: typeof sections = [];
  let offset = 0;
  for (const [i, item] of items.entries()) {
    const bytes = Buffer.from(
      `${item.level ? "#".repeat(item.level) + " " : ""}${item.text}\n\n`,
    );
    if (item.level) {
      while (stack.length && stack.at(-1)!.level >= item.level)
        stack.pop()!.end_utf8 = offset;
      const section = {
        section_id: `s${sections.length + 1}`,
        title: item.text,
        level: item.level,
        start_utf8: offset,
        end_utf8: 0,
        role: null,
        role_source: null,
      };
      sections.push(section);
      stack.push(section);
    }
    segments.push({
      segment_id: `p${i}`,
      block_id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
      kind: item.level ? "heading" : (item.kind ?? "text"),
      section_id: stack.at(-1)?.section_id ?? null,
      start_utf8: offset,
      end_utf8: offset + bytes.length,
      page: 0,
      region: [10, 10, 900, 100],
      continuation_regions: [],
      locate: "region",
      source: "parser",
      basis: "text-layer",
    });
    parts.push(bytes);
    offset += bytes.length;
  }
  for (const s of stack) s.end_utf8 = offset;
  const markdown = Buffer.concat(parts),
    structure = parseDocumentStructureV2(
      {
        schema_version: 2,
        text_encoding: "utf8",
        page_count: 1,
        sections,
        segments,
      },
      markdown.length,
    );
  return { markdown, structure };
}
const base = (f: ReturnType<typeof document>) => ({
  ...f,
  part: "main" as const,
  max_prefix_characters: 32,
  locked: {},
  classify: null,
});
describe("structure roles without mutating document bytes", () => {
  it.each([
    ["0 引言", "main", "introduction"],
    ["1 实验部分", "main", "methods"],
    ["2.1 Experimental Section", "main", "methods"],
    ["2. Results and Discussion", "main", "results-discussion"],
    ["IV. CONCLUSIONS", "main", "conclusion"],
    ["参考文献", "main", "references"],
    ["Supporting Information", "main", "appendix"],
    ["Experimental Section", "supplementary", "si-methods"],
    ["NMR Spectra", "supplementary", "si-characterization"],
    ["Computational Details", "supplementary", "si-computation"],
    ["Supplementary Tables", "supplementary", "si-tables"],
    ["Supplementary Figures", "supplementary", "si-figures"],
    ["References", "supplementary", "si-references"],
    ["Supporting Information", "supplementary", "body"],
    ["Methods for interpreting references", "main", null],
    ["3D structure", "main", null],
    ["Summary", "main", null],
  ] as const)(
    "classifies %s in %s without keyword substring guessing",
    (title, part, role) => {
      expect(ruleSectionRole(title, part)).toBe(role);
    },
  );
  it("keeps part-specific roles closed", () => {
    expect(() => parseSectionRole("si-methods", "main")).toThrow();
    expect(() => parseSectionRole("abstract", "supplementary")).toThrow();
    expect(() => parseSectionRole("arbitrary")).toThrow();
    expect(parseSectionRole("body", "main")).toBe("body");
  });
  it("inherits nested roles, bounds model context by Unicode characters, and preserves human locks", async () => {
    const f = document([
      { text: "Methods", level: 1 },
      { text: "Catalyst preparation", level: 2 },
      { text: "Fixture preparation." },
      { text: "Electronic landscape", level: 1 },
      { text: "🧪αβγ. This is the full paragraph." },
      { text: "Conclusion", level: 1 },
    ]);
    const original = Buffer.from(f.markdown),
      classify = vi.fn(
        async (
          _input: import("../src/document/section-rules.js").RoleModelInput,
        ) => {
          void _input;
          return "discussion";
        },
      );
    const result = await assignSectionRoles({
      ...base(f),
      max_prefix_characters: 2,
      locked: { s1: "results" },
      classify,
    });
    expect(result).toMatchObject([
      { role: "results", role_source: "manual", locked: true },
      {
        role: "results",
        role_source: "manual",
        inherited_from: "s1",
        locked: false,
      },
      { role: "discussion", role_source: "model", locked: false },
      { role: "conclusion", role_source: "rule" },
    ]);
    expect(classify).toHaveBeenCalledTimes(1);
    expect(classify.mock.calls[0]![0]).toMatchObject({
      prefix: "🧪α",
      previous_role: "results",
      next_role: "conclusion",
      part: "main",
    });
    expect(f.markdown).toEqual(original);
    await expect(
      assignSectionRoles({ ...base(f), locked: { missing: "methods" } }),
    ).rejects.toThrow("annotation-manual-conflict");
  });
  it("records a fallback for unavailable, invalid and failed classifications; cancellation remains cancellation", async () => {
    const f = document([
      { text: "Electronic landscape", level: 1 },
      { text: "Synthetic findings." },
    ]);
    expect(await assignSectionRoles(base(f))).toMatchObject([
      {
        role: "body",
        role_source: "fallback",
        failure_code: "role-model-unavailable",
      },
    ]);
    for (const classify of [
      async () => "si-methods",
      async () => {
        throw new Error("fake model failed");
      },
    ])
      expect(await assignSectionRoles({ ...base(f), classify })).toMatchObject([
        {
          role: "body",
          role_source: "fallback",
          failure_code: "role-model-failed",
        },
      ]);
    const stop = new AbortController();
    await expect(
      assignSectionRoles({
        ...base(f),
        signal: stop.signal,
        classify: async () => {
          stop.abort();
          return "body";
        },
      }),
    ).rejects.toThrow("annotation-cancelled");
  });
  it("marks pre-heading abstract/keywords and extracts adjacent captions and cited blocks", async () => {
    const f = document([
      { text: "Author information." },
      { text: "Abstract: A synthetic finding." },
      { text: "Keywords: synthetic; structure" },
      { text: "Results", level: 1 },
      { text: "A figure.", kind: "image" },
      { text: "Fig. 2. Synthetic measurements.", kind: "caption" },
      { text: "Table S1. Conditions.", kind: "caption" },
      { text: "<table><tr><td>5</td></tr></table>", kind: "table" },
      { text: "References", level: 1 },
      {
        text: "[1] Author. Title (2020). DOI: 10.1000/first.\n[2] Other. Second (2021).",
        kind: "reference-item",
      },
      {
        text: "Continued citation. https://doi.org/10.1000/second",
        kind: "reference-item",
      },
    ]);
    const sections = await assignSectionRoles(base(f)),
      roles = segmentRoles(f.structure, f.markdown, sections, "main");
    expect(roles.slice(0, 3).map((r) => r.role)).toEqual([
      "front-matter",
      "abstract",
      "keywords",
    ]);
    expect(structureFigures(f.structure, f.markdown)).toMatchObject([
      { kind: "figure", label: "Fig. 2", caption_segment_id: "p5", page: 0 },
      { kind: "table", label: "Table S1", caption_segment_id: "p6", page: 0 },
    ]);
    const refs = structureReferences(f.structure, f.markdown, roles);
    expect(refs).toMatchObject([
      { reference_index: 0, doi: "10.1000/first", segment_ids: ["p9"] },
      { reference_index: 1, doi: "10.1000/second", segment_ids: ["p9", "p10"] },
    ]);
    expect(structureSatisfied("main", sections)).toBe(true);
    expect(
      structureSatisfied(
        "main",
        sections.filter((s) => s.role !== "references"),
      ),
    ).toBe(true);
    expect(structureSatisfied("supplementary", sections)).toBe(false);
    expect(
      structureSatisfied(
        "main",
        sections.filter((s) => s.role !== "results"),
      ),
    ).toBe(false);
  });
  it("keeps unnumbered citation boundaries and supplementary references separate", async () => {
    const f = document([
      { text: "References", level: 1 },
      { text: "Author, Book, 2020.", kind: "reference-item" },
      { text: "Another, Dataset, 2021.", kind: "reference-item" },
    ]);
    const sections = await assignSectionRoles({
      ...base(f),
      part: "supplementary",
    });
    expect(sections).toMatchObject([{ role: "si-references" }]);
    expect(
      structureReferences(
        f.structure,
        f.markdown,
        segmentRoles(f.structure, f.markdown, sections, "supplementary"),
      ),
    ).toMatchObject([
      { reference_index: 0, doi: null, segment_ids: ["p1"] },
      { reference_index: 1, doi: null, segment_ids: ["p2"] },
    ]);
  });
});

it("does not attach a figure caption to the next table or reuse a caption for another object", () => {
  const f = document([
    { text: "synthetic image", kind: "image" },
    { text: "Fig. 1 Synthetic figure", kind: "caption" },
    { text: "synthetic table", kind: "table" },
    { text: "second synthetic image", kind: "image" },
  ]);
  expect(structureFigures(f.structure, f.markdown)).toEqual([
    {
      object_segment_id: "p0",
      caption_segment_id: "p1",
      kind: "figure",
      label: "Fig. 1",
      page: 0,
    },
    {
      object_segment_id: "p2",
      caption_segment_id: null,
      kind: "table",
      label: null,
      page: 0,
    },
    {
      object_segment_id: "p3",
      caption_segment_id: null,
      kind: "figure",
      label: null,
      page: 0,
    },
  ]);
});
