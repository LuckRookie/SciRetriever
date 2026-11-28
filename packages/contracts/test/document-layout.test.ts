import { expect, it } from "vitest";
import {
  parseDocumentLayout,
  parseDocumentStructureV2,
  parseDocumentReadResult,
  parseArrangementOperation,
  parseArrangementSourceBlock,
} from "../src/index.js";
const id = "00000000-0000-4000-8000-000000000001";
const document = {
  document_id: id,
  document_version_id: id,
  representation_sha256: "a".repeat(64),
  source_material_ref: {
    literature_id: id,
    asset_id: id,
    asset_sha256: "b".repeat(64),
    media_type: "application/pdf",
    byte_size: 10,
    artifact: {
      sha256: "b".repeat(64),
      byte_size: 10,
      media_type: "application/pdf",
    },
  },
  locator_scheme: "utf8-segment-v1",
};
const capabilities = {
  text: true,
  outline: true,
  resources: true,
  table_context: false,
  figure_caption: false,
  page: true,
  bbox: true,
};
const layout = {
  schema_version: 1,
  article_info: [{ start_utf8: 0, end_utf8: 5 }],
  figure_groups: [
    {
      group_id: "group1",
      kind: "figure",
      rows: [2],
      objects: [
        {
          segment_id: "image1",
          row: 0,
          column: 0,
          start_utf8: 5,
          end_utf8: 10,
        },
        {
          segment_id: "image2",
          row: 0,
          column: 1,
          start_utf8: 10,
          end_utf8: 15,
        },
      ],
      captions: [{ segment_id: "caption1", start_utf8: 15, end_utf8: 20 }],
    },
  ],
  footnotes: [
    { segment_id: "note1", page_index: 0, start_utf8: 20, end_utf8: 25 },
  ],
};
it("round-trips presentation ranges and nullable native titles through the common document read contract", () => {
  expect(parseDocumentLayout(layout, 25, 1)).toEqual(layout);
  const described = {
    document,
    capabilities,
    gaps: [],
    section_count: 1,
    segment_count: 5,
    resource_count: 2,
    layout,
  };
  expect(
    parseDocumentReadResult("describe", described, { document_version_id: id }),
  ).toEqual(described);
  const outline = {
    document,
    sections: [
      {
        section_id: "s1",
        title: null,
        title_truncated: false,
        level: 2,
        start_utf8: 0,
        end_utf8: 25,
        role: "methods",
        role_source: "arrangement",
      },
    ],
    total: 1,
    next_cursor: null,
    capabilities,
    gaps: [],
  };
  expect(
    parseDocumentReadResult("outline", outline, {
      document_version_id: id,
      limit: 10,
      cursor: null,
    }),
  ).toEqual(outline);
  expect(() =>
    parseDocumentReadResult(
      "outline",
      {
        ...outline,
        sections: [{ ...outline.sections[0], title_truncated: true }],
      },
      { document_version_id: id, limit: 10, cursor: null },
    ),
  ).toThrow();
  expect(
    parseDocumentReadResult(
      "describe",
      Object.fromEntries(
        Object.entries(described).filter(([key]) => key !== "layout"),
      ),
      { document_version_id: id },
    ),
  ).not.toHaveProperty("layout");
});
it("rejects malformed ranges, grids, duplicate segment ownership, extra keys and source provenance", () => {
  for (const bad of [
    { ...layout, article_info: [{ start_utf8: 2, end_utf8: 1 }] },
    { ...layout, footnotes: [{ ...layout.footnotes[0], page_index: 1 }] },
    { ...layout, figure_groups: [{ ...layout.figure_groups[0], rows: [1] }] },
    { ...layout, footnotes: [layout.footnotes[0], layout.footnotes[0]] },
    { ...layout, html: "<aside>" },
  ])
    expect(() => parseDocumentLayout(bad, 25, 1)).toThrow();
  expect(() =>
    parseArrangementOperation({
      kind: "drop",
      leaf_id: id,
      reason: "header",
      source: "program",
    }),
  ).toThrow();
  expect(
    parseArrangementOperation({
      kind: "drop",
      leaf_id: id,
      reason: "header",
      source: "program",
      rule: "page-chrome-v1/mineru-header",
    }),
  ).toMatchObject({ source: "program" });
  expect(() =>
    parseArrangementSourceBlock({ pdf_geometry: { line_count: 1 } }, 1),
  ).toThrow();
});
it("requires layout ranges to match existing image, caption and footnote segments", () => {
  const segment = (
    segment_id: string,
    kind: string,
    start_utf8: number,
    end_utf8: number,
  ) => ({
    segment_id,
    block_id: segment_id,
    kind,
    start_utf8,
    end_utf8,
    section_id: "s1",
    page: 0,
    region: null,
    continuation_regions: [],
    locate: "page",
    source: "parser",
    basis: "text-layer",
  });
  const structure = {
    schema_version: 2,
    text_encoding: "utf8",
    page_count: 1,
    sections: [
      {
        section_id: "s1",
        title: null,
        level: 2,
        start_utf8: 0,
        end_utf8: 25,
        role: null,
        role_source: null,
      },
    ],
    segments: [
      segment("info", "text", 0, 5),
      segment("image1", "image", 5, 10),
      segment("image2", "image", 10, 15),
      segment("caption1", "caption", 15, 20),
      segment("note1", "footnote", 20, 25),
    ],
    layout,
  };
  expect(parseDocumentStructureV2(structure, 25)).toEqual(structure);
  expect(() =>
    parseDocumentStructureV2(
      {
        ...structure,
        segments: structure.segments.map((s) =>
          s.segment_id === "note1" ? { ...s, kind: "text" } : s,
        ),
      },
      25,
    ),
  ).toThrow();
  expect(() =>
    parseDocumentStructureV2(
      {
        ...structure,
        layout: {
          ...layout,
          footnotes: [{ ...layout.footnotes[0], segment_id: "absent" }],
        },
      },
      25,
    ),
  ).toThrow();
});
it("accepts table notes only on a table group, as footnote segments outside the page footnotes", () => {
  const segment = (segment_id: string, kind: string, start: number) => ({
    segment_id,
    block_id: segment_id,
    kind,
    start_utf8: start,
    end_utf8: start + 5,
    section_id: "s1",
    page: 0,
    region: null,
    continuation_regions: [],
    locate: "page",
    source: "parser",
    basis: "text-layer",
  });
  const group = {
    group_id: "g-table1",
    kind: "table",
    rows: [1],
    objects: [
      { segment_id: "table1", row: 0, column: 0, start_utf8: 0, end_utf8: 5 },
    ],
    captions: [{ segment_id: "caption1", start_utf8: 5, end_utf8: 10 }],
    notes: [{ segment_id: "note1", start_utf8: 10, end_utf8: 15 }],
  };
  const tableLayout = {
    schema_version: 1,
    article_info: [],
    figure_groups: [group],
    footnotes: [],
  };
  const structure = {
    schema_version: 2,
    text_encoding: "utf8",
    page_count: 1,
    sections: [
      {
        section_id: "s1",
        title: null,
        level: 2,
        start_utf8: 0,
        end_utf8: 15,
        role: null,
        role_source: null,
      },
    ],
    segments: [
      segment("table1", "table", 0),
      segment("caption1", "caption", 5),
      segment("note1", "footnote", 10),
    ],
    layout: tableLayout,
  };
  expect(parseDocumentStructureV2(structure, 15)).toEqual(structure);
  for (const figure_groups of [
    [{ ...group, notes: [] }],
    [{ ...group, kind: "figure" }],
    [{ ...group, notes: [{ ...group.notes[0], extra: 1 }] }],
  ])
    expect(() =>
      parseDocumentLayout({ ...tableLayout, figure_groups }),
    ).toThrow();
  // A note is a footnote segment, and it is never also a page footnote.
  expect(() =>
    parseDocumentStructureV2(
      {
        ...structure,
        segments: structure.segments.map((s) =>
          s.segment_id === "note1" ? { ...s, kind: "text" } : s,
        ),
      },
      15,
    ),
  ).toThrow();
  expect(() =>
    parseDocumentLayout({
      ...tableLayout,
      footnotes: [
        { segment_id: "note1", page_index: 0, start_utf8: 10, end_utf8: 15 },
      ],
    }),
  ).toThrow();
});
