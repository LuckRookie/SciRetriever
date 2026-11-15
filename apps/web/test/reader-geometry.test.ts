/** Spec 8.1 "版面计算": the sheet on the desk at the widths of spec 1.1, either side of each step. */
import { describe, expect, it } from "vitest";
import {
  pageColumn,
  sheetGeometry,
  topBarLayout,
} from "../src/app/features/reader/geometry.js";

describe("sheet on the desk (spec 1.1)", () => {
  // Desk width → tier, margins, where notes go, whether the spine shows (reading size 20 px).
  const table = [
    [1920, "wide", 150, 210, "margin", true],
    [1440, "wide", 150, 210, "margin", true],
    [1088, "wide", 150, 210, "margin", true],
    [1087, "medium", 96, null, "margin", true],
    [1024, "medium", 96, null, "margin", true],
    [800, "medium", 96, null, "below", true],
    [799, "narrow", 56, 24, "below", true],
    [640, "narrow", 56, 24, "below", true],
    [639, "full", 24, 16, "below", false],
    [390, "full", 24, 16, "below", false],
  ] as const;
  for (const [desk, tier, left, right, notes, spine] of table)
    it(`${desk} px: ${tier}`, () => {
      const g = sheetGeometry(desk, 20);
      expect(g.tier).toBe(tier);
      expect(g.marginLeft).toBe(left);
      if (right !== null) expect(g.marginRight).toBe(right);
      expect(g.notes).toBe(notes);
      expect(g.spine).toBe(spine);
      expect(g.sheet).toBe(g.marginLeft + g.column + g.marginRight);
      if (tier === "wide") {
        // The sheet is the text column plus 360 px of margins.
        expect(g.sheet).toBe(g.column + 360);
        expect(g.column).toBeLessThanOrEqual(680);
      }
      if (tier === "medium" || tier === "narrow") {
        // Desk width less 56 px, 16 px of desk on the left.
        expect(g.sheet).toBe(desk - 56);
        expect(g.left).toBe(16);
      }
      if (tier === "full") {
        expect(g.sheet).toBe(desk);
        expect(g.left).toBe(0);
        expect(g.framed).toBe(false);
      } else {
        // The sheet, the 8 px gap and the 16 px spine are centred together.
        expect(g.left + g.sheet + 8 + 16 + g.left).toBeCloseTo(desk, 6);
        expect(g.spineLeft).toBe(g.left + g.sheet + 8);
      }
      // A left margin narrower than 96 px keeps only bars and marks.
      expect(g.compactLeft).toBe(left < 96);
    });

  it("keeps the text column at 34 em where it fits: 680 px at 20 px on a 1440 px desk", () => {
    const g = sheetGeometry(1440, 20);
    expect(g.column).toBe(680);
    expect(g.sheet).toBe(1040);
    expect(g.left).toBe(188);
  });

  it("moves notes below the paragraph once the right margin is narrower than 190 px", () => {
    expect(sheetGeometry(1024, 20)).toMatchObject({
      marginRight: 192,
      notes: "margin",
    });
    expect(sheetGeometry(1000, 20)).toMatchObject({
      marginRight: 168,
      notes: "below",
    });
  });

  it("widens the text column with the font size, margins unchanged, at least 24 em", () => {
    for (const size of [18, 20, 22, 24]) {
      const g = sheetGeometry(1920, size);
      expect(g.column).toBe(34 * size);
      expect([g.marginLeft, g.marginRight]).toEqual([150, 210]);
    }
    // 1100 px leaves 684 px for the column: 24 px text gets that, not 34 em.
    const tight = sheetGeometry(1100, 24);
    expect(tight.column).toBe(1100 - 56 - 360);
    expect(tight.column).toBeGreaterThanOrEqual(24 * 24);
    expect(sheetGeometry(1100, 18).column).toBe(34 * 18);
  });

  it("indents the page header 40 px on the wide sheet, 24 px in the middle and 16 px when full width (spec 1.2)", () => {
    expect(sheetGeometry(1440, 20).headerIndent).toBe(40);
    expect(sheetGeometry(1024, 20).headerIndent).toBe(24);
    expect(sheetGeometry(700, 20).headerIndent).toBe(24);
    expect(sheetGeometry(390, 20).headerIndent).toBe(16);
  });
});

/** Spec 8.1 "顶栏收起": either side of 1180, 760 and 640 px (spec 1.3). */
describe("the top bar folding away (spec 1.3)", () => {
  const table = [
    [1440, "all", "buttons", "segmented"],
    [1180, "all", "buttons", "segmented"],
    [1179, "current", "buttons", "segmented"],
    [760, "current", "buttons", "segmented"],
    [759, "current", "more", "segmented"],
    [640, "current", "more", "segmented"],
    [639, "none", "more", "menu"],
    [390, "none", "more", "menu"],
  ] as const;
  for (const [width, tabs, tools, views] of table)
    it(`${width} px`, () => {
      expect(topBarLayout(width)).toEqual({ tabs, tools, views });
    });
  it("treats an unmeasured bar as the widest", () => {
    expect(topBarLayout(0)).toEqual({
      tabs: "all",
      tools: "buttons",
      views: "segmented",
    });
  });
});

describe("the PDF's page column (spec 3.5)", () => {
  it("is the sheet at 适宽: as wide, at the same place, at every tier", () => {
    for (const desk of [1920, 1440, 1110, 1087, 900, 700, 639, 390]) {
      const sheet = sheetGeometry(desk, 20),
        column = pageColumn(desk, 20, null);
      expect(column.pageWidth, String(desk)).toBe(sheet.sheet);
      expect(column.left, String(desk)).toBe(sheet.left);
    }
  });
  it("follows the reading size at 适宽, as the sheet does", () => {
    expect(pageColumn(1440, 24, null).pageWidth).toBe(
      sheetGeometry(1440, 24).sheet,
    );
  });
  it("centres a zoomed column with the spine, and keeps 16 px of desk when wider", () => {
    // 306 px pages (50%) on a 1110 px desk: (1110 − 306 − 8 − 16) / 2.
    expect(pageColumn(1110, 20, 306)).toEqual({
      pageWidth: 306,
      width: 306,
      left: 390,
    });
    expect(pageColumn(1110, 20, 1836).left).toBe(16);
    // Below 640 px there is no spine: centred on the desk, at least 0.
    expect(pageColumn(390, 20, 306).left).toBe(42);
    expect(pageColumn(390, 20, 612).left).toBe(0);
  });
  it("shares the desk less the spine's room between a page and its translation", () => {
    const pair = pageColumn(1110, 20, null, 2);
    expect(pair.width).toBe(1110 - 56);
    expect(pair.pageWidth).toBe((1110 - 56 - 24) / 2);
    expect(pair.left).toBe(16);
  });
});
