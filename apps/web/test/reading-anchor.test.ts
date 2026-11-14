/**
 * Direct tests of the reading position (spec "reading experience" 8.1:
 * anchors, remembering and restoring) and the view-to-view rules of 4.3,
 * without a browser.
 */
import { expect, it } from "vitest";
import {
  anchorIndex,
  anchorRatio,
  nearestBlock,
  pdfToText,
  placeDelta,
  readingLine,
  textToPdf,
  type TextBlock,
} from "../src/reading/anchor.js";
import {
  READING_MEMORY_LIMIT,
  recallReading,
  rememberReading,
  touchIndex,
} from "../src/reading/state.js";

const blocks = [
  { top: 100, bottom: 200 },
  { top: 220, bottom: 300 },
  { top: 300, bottom: 500 },
];

it("puts the reading line 28% down the area, from its upper edge", () => {
  expect(readingLine({ top: 50, height: 1000 })).toBe(330);
  // The new layout only moves the edge: the same parameter.
  expect(readingLine({ top: 0, height: 1000 }, 0.28)).toBe(280);
});

it("picks the block the line crosses, the lower one between two, the first and last at the ends", () => {
  // Inside a block.
  expect(anchorIndex(blocks, 150)).toBe(0);
  expect(anchorRatio(blocks[0]!, 150)).toBe(0.5);
  // Between two blocks: the lower one, at its top.
  expect(anchorIndex(blocks, 210)).toBe(1);
  expect(anchorRatio(blocks[1]!, 210)).toBe(0);
  // On the shared edge: the lower block.
  expect(anchorIndex(blocks, 300)).toBe(2);
  // Above the first block (page top) and below the last (page end).
  expect(anchorIndex(blocks, 10)).toBe(0);
  expect(anchorRatio(blocks[0]!, 10)).toBe(0);
  expect(anchorIndex(blocks, 900)).toBe(2);
  expect(anchorRatio(blocks[2]!, 900)).toBe(1);
  expect(anchorIndex([], 100)).toBe(-1);
});

it("computes the scroll that puts a block's point back on the line", () => {
  // The block's middle (top 300 + 100) should sit on the line at 330.
  expect(placeDelta(blocks[2]!, 0.5, 330)).toBe(70);
  expect(placeDelta(blocks[0]!, 0, 100)).toBe(0);
});

const text: TextBlock[] = [
  { start: 0, page: 1, region: [0, 50, 1000, 200] },
  { start: 100, page: 1, region: [0, 300, 1000, 600] },
  { start: 250, page: null, region: null },
  { start: 300, page: 2, region: [0, 100, 1000, 400] },
  { start: 420, page: 2, region: null },
];

it("maps full text to PDF by the block's page and region top, else the nearest earlier block (4.3)", () => {
  expect(textToPdf(text, 1)).toEqual({ page: 1, ratio: 0.3, exact: true });
  // A block known only by its page lands on the page's top.
  expect(textToPdf(text, 4)).toEqual({ page: 2, ratio: 0, exact: true });
  // No page: the earlier block's page, at the bottom of its region, not exact.
  expect(textToPdf(text, 2)).toEqual({ page: 1, ratio: 0.6, exact: false });
  expect(textToPdf([{ start: 0, page: null, region: null }], 0)).toBeNull();
});

it("maps PDF to full text by the region covering the place, else the closest block before it (4.3)", () => {
  expect(pdfToText(text, 1, 0.45)).toEqual({
    index: 1,
    ratio: 0.5,
    exact: true,
  });
  // Between two regions on the page: the last block starting above the place.
  expect(pdfToText(text, 1, 0.25)?.index).toBe(0);
  // Above every region of the page: the page's first block.
  expect(pdfToText(text, 1, 0.01)?.index).toBe(0);
  // A page without blocks: the nearest earlier page's last block, not exact.
  expect(pdfToText(text, 3, 0.5)).toEqual({
    index: 4,
    ratio: 1,
    exact: false,
  });
  expect(pdfToText([{ start: 0, page: 4, region: null }], 2, 0.5)).toBeNull();
});

it("finds a remembered offset in a new text version, or opens from the top past its end (4.5)", () => {
  const starts = [0, 120, 400, 900];
  expect(nearestBlock(starts, 450, 1200)).toBe(2);
  expect(nearestBlock(starts, 120, 1200)).toBe(1);
  expect(nearestBlock(starts, 0, 1200)).toBe(0);
  // The new text ends before the remembered place.
  expect(nearestBlock(starts, 1500, 1200)).toBe(-1);
});

class MemoryStorage {
  readonly values = new Map<string, string>();
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
}

it("keeps the fields of 4.5 per library and paper and evicts the least recently used past 300", () => {
  const storage = new MemoryStorage();
  rememberReading(
    "library-a",
    "paper-1",
    {
      view: "doc",
      doc: { version: "v1", start: 420, ratio: 0.25 },
      pdf: { sha256: "a".repeat(64), page: 3, ratio: 0.5, zoom: "fit" },
      fontSize: 22,
      information: false,
      sideTab: "marks",
      keySentences: false,
      sources: true,
    },
    storage,
  );
  expect(recallReading("library-a", "paper-1", storage)).toMatchObject({
    view: "doc",
    doc: { version: "v1", start: 420, ratio: 0.25 },
    pdf: { page: 3, ratio: 0.5, zoom: "fit" },
    fontSize: 22,
    information: false,
    sideTab: "marks",
    sources: true,
  });
  // Another library keeps its own record of the same paper.
  expect(recallReading("library-b", "paper-1", storage).doc).toBeNull();
  // A patch keeps the other fields.
  rememberReading("library-a", "paper-1", { view: "pdf" }, storage);
  expect(recallReading("library-a", "paper-1", storage)).toMatchObject({
    view: "pdf",
    fontSize: 22,
  });
  for (let n = 2; n <= READING_MEMORY_LIMIT + 1; n++)
    rememberReading("library-a", `paper-${n}`, { view: "pdf" }, storage);
  // The 301st paper evicted the one used longest ago.
  expect(recallReading("library-a", "paper-1", storage).view).toBeNull();
  expect(recallReading("library-a", "paper-2", storage).view).toBe("pdf");
  expect(
    [...storage.values.keys()].filter((key) => !key.endsWith(":index")),
  ).toHaveLength(READING_MEMORY_LIMIT);
  expect(touchIndex(["a", "b", "c"], "a", 3)).toEqual({
    index: ["b", "c", "a"],
    evicted: [],
  });
});

it("reads as unremembered where storage is refused, and never throws", () => {
  const refusing = {
    getItem: () => {
      throw new Error("denied");
    },
    setItem: () => {
      throw new Error("denied");
    },
    removeItem: () => {
      throw new Error("denied");
    },
  };
  expect(() =>
    rememberReading("library", "paper", { view: "doc" }, refusing),
  ).not.toThrow();
  expect(recallReading("library", "paper", refusing).view).toBeNull();
  expect(recallReading("library", "paper", null).view).toBeNull();
});
