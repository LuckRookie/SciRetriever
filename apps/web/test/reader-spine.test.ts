/** Spec 8.1 “书脊映射”: the spine's parts, window and ticks (reading-experience 1.5). */
import { describe, expect, it } from "vitest";
import {
  SPINE,
  pageParts,
  pdfParts,
  spineSegments,
  spineTicks,
  spineWindow,
  spineY,
  textParts,
  tipSide,
} from "../src/app/features/reader/spine.js";

const outline = [
  { title: "Abstract", role: "abstract", level: 2, start: 100, end: 600 },
  { title: "1 Introduction", level: 1, start: 600, end: 2600 },
  { title: "1.1 Scope", level: 2, start: 900, end: 2600 },
  { title: "2 Methods", level: 1, start: 2600, end: 6600 },
  { title: "3 Results", level: 1, start: 6600, end: 10600 },
];

describe("spine parts (spec 1.5)", () => {
  it("has one part per top-level heading, the abstract its own, by their bytes", () => {
    const parts = textParts(outline, 0);
    expect(parts.map((p) => p.label)).toEqual([
      "Abstract",
      "1 Introduction",
      "2 Methods",
      "3 Results",
    ]);
    // What precedes the first heading belongs to the first part.
    expect(parts[0]).toMatchObject({ start: 0, end: 600 });
    expect(parts.at(-1)).toMatchObject({ start: 6600, end: 10600 });
  });
  it("is one part without headings, and pages in the PDF", () => {
    expect(textParts([], 5000)).toEqual([{ label: "", start: 0, end: 5000 }]);
    expect(pageParts(9)).toEqual([{ label: "", start: 0, end: 9 }]);
  });
  it("sizes parts by bytes within 1 px, 3 px apart, none shorter than 3 px", () => {
    const parts = textParts(outline, 0),
      height = 600;
    const segments = spineSegments(parts, height);
    const room = height - 2 * SPINE.pad - SPINE.gap * (parts.length - 1);
    const total = parts.reduce((sum, p) => sum + p.end - p.start, 0);
    for (const s of segments)
      expect(
        Math.abs(s.height - (room * (s.end - s.start)) / total),
      ).toBeLessThanOrEqual(1);
    for (let i = 1; i < segments.length; i++)
      expect(
        segments[i]!.top - segments[i - 1]!.top - segments[i - 1]!.height,
      ).toBeCloseTo(SPINE.gap);
    const tiny = spineSegments(
      [
        { label: "a", start: 0, end: 1 },
        { label: "b", start: 1, end: 100000 },
      ],
      300,
    );
    expect(tiny[0]!.height).toBe(SPINE.min);
    expect(tiny[0]!.height + tiny[1]!.height).toBeCloseTo(
      300 - 2 * SPINE.pad - SPINE.gap,
    );
  });
  it("does not change with the reading size: only bytes count", () => {
    const parts = textParts(outline, 0);
    expect(spineSegments(parts, 500)).toEqual(spineSegments(parts, 500));
  });
});

describe("spine parts in the PDF (spec 1.5)", () => {
  const sections = [
    { title: "Abstract", role: "abstract", level: 2, page: 1 },
    { title: "1 Introduction", level: 1, page: 2 },
    { title: "1.1 Scope", level: 2, page: 3 },
    { title: "2 Methods", level: 1, page: 4 },
    { title: "3 Results", level: 1, page: 4 },
    { title: "4 Discussion", level: 1, page: 7 },
  ];
  it("runs each part from its heading's page to the next heading's page", () => {
    expect(pdfParts(sections, 9)).toEqual([
      { label: "Abstract", start: 0, end: 1 },
      { label: "1 Introduction", start: 1, end: 3 },
      { label: "2 Methods", start: 3, end: 3 },
      { label: "3 Results", start: 3, end: 6 },
      { label: "4 Discussion", start: 6, end: 9 },
    ]);
  });
  it("sizes the parts by pages; a part within one page still shows (3 px)", () => {
    const segments = spineSegments(pdfParts(sections, 9), 400);
    expect(segments).toHaveLength(5);
    expect(segments[2]!.height).toBe(SPINE.min);
    expect(segments[4]!.height / segments[3]!.height).toBeCloseTo(1, 0);
  });
  it("is one part without parsed text", () => {
    expect(pdfParts([], 9)).toEqual(pageParts(9));
    expect(pdfParts([{ title: "x", level: 1, page: null }], 9)).toEqual(
      pageParts(9),
    );
  });
});

describe("spine window and ticks", () => {
  const segments = spineSegments(textParts(outline, 0), 600);
  it("frames the bytes on screen within 1 px, also while the text is still arriving", () => {
    const methods = segments[2]!;
    const window = spineWindow(segments, 3600, 4600);
    expect(
      Math.abs(window.top - (methods.top + methods.height / 4)),
    ).toBeLessThanOrEqual(1);
    expect(Math.abs(window.height - methods.height / 4)).toBeLessThanOrEqual(1);
    // Only the first batch laid out: the parts come from the outline, not the layout.
    const early = spineSegments(textParts(outline, 1200), 600);
    expect(early).toEqual(segments);
  });
  it("puts a unit at its place inside its part", () => {
    expect(spineY(segments, 600)).toBeCloseTo(segments[1]!.top);
    expect(spineY(segments, 10600)).toBeCloseTo(
      segments[3]!.top + segments[3]!.height,
    );
  });
  it("merges ticks closer than 3 px; a find hit outranks a mark", () => {
    const ticks = spineTicks(segments, [
      { unit: 3000, kind: "mark", id: "a" },
      { unit: 3001, kind: "find" },
      { unit: 9000, kind: "mark", id: "b" },
    ]);
    expect(ticks).toHaveLength(2);
    expect(ticks[0]).toMatchObject({ kind: "find", ids: ["a"] });
    expect(ticks[1]).toMatchObject({ kind: "mark", ids: ["b"] });
  });
  it("opens the hover to the right where the desk has room, else to the left", () => {
    expect(tipSide(300, 220)).toBe("right");
    expect(tipSide(230, 220)).toBe("left");
  });
});
