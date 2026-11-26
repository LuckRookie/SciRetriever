/** Spec 8.1 “标记”: the right margin's notes keep apart (reading-experience 2.5). */
import { describe, expect, it } from "vitest";
import {
  MARGIN,
  layoutMargin,
} from "../src/app/features/reader/marks/margin.js";

const note = (id: string, want: number, height = 40) => ({
  id,
  want,
  height,
  firstLine: 18,
});

describe("margin notes", () => {
  it("stay at their lines when there is room", () => {
    expect(layoutMargin([note("a", 0), note("b", 100)])).toEqual([
      { id: "a", top: 0, want: 0, folded: false },
      { id: "b", top: 100, want: 100, folded: false },
    ]);
  });
  it("keep at least 10 px apart, in reading order", () => {
    const places = layoutMargin([note("b", 20), note("a", 0)]);
    expect(places.map((p) => p.id)).toEqual(["a", "b"]);
    expect(places[1]!.top).toBe(40 + MARGIN.gap);
  });
  it("show the first line only when pushed more than 120 px from their line", () => {
    const places = layoutMargin([
      note("a", 0, 200),
      note("b", 10),
      note("c", 20),
    ]);
    expect(places[1]).toMatchObject({ top: 210, folded: true });
    // A folded note takes its first line's height only.
    expect(places[2]!.top).toBe(210 + 18 + MARGIN.gap);
  });
  it("go below what already stands in the margin of an annotated copy (ADR 0070)", () => {
    const places = layoutMargin(
      [note("a", 30), note("b", 300)],
      [{ top: 0, bottom: 90 }],
    );
    expect(places[0]).toMatchObject({ top: 90 + MARGIN.gap, folded: false });
    expect(places[1]!.top).toBe(300);
  });
});
