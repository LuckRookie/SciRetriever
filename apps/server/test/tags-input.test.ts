import { expect, it } from "vitest";
import { selectTagInput } from "../src/tags/input.js";

function source(rows: readonly { text: string; role: string }[]) {
  let offset = 0;
  const segments = rows.map((r, i) => {
    const start_utf8 = offset;
    offset += Buffer.byteLength(r.text);
    return { segment_id: `segment-${i}`, start_utf8, end_utf8: offset };
  });
  return {
    markdown: Buffer.from(rows.map((r) => r.text).join("")),
    segments,
    roles: new Map(segments.map((s, i) => [s.segment_id, rows[i]!.role])),
  };
}
it("keeps complete Unicode fragments and later conclusions when an earlier section exceeds its budget", () => {
  const data = source([
    { text: "中".repeat(20000), role: "abstract" },
    { text: "omitted abstract detail".repeat(1000), role: "abstract" },
    { text: "Introduction with 🧪 evidence.", role: "introduction" },
    { text: "The final conclusion is retained.", role: "conclusion" },
    { text: "Unselected bibliography.", role: "references" },
  ]);
  const out = selectTagInput(data.markdown, data.segments, data.roles);
  expect(out.fragments.map((f) => f.segment_id)).toEqual([
    "segment-0",
    "segment-2",
    "segment-3",
  ]);
  expect(out.fragments[0]!.text).toBe("中".repeat(20000));
  expect(out.fragments.at(-1)!.text).toBe("The final conclusion is retained.");
  expect(out.coverage).toMatchObject({
    selection: "preferred-sections",
    available_segments: 4,
    truncated: true,
  });
  expect(out.coverage.sections[0]).toMatchObject({
    available_segments: 2,
    included_segments: 1,
    omitted: { "section-byte-limit": 1 },
  });
});
it("reports fallback omissions instead of presenting the first eight fragments as full coverage", () => {
  const data = source(
    Array.from({ length: 10 }, (_, i) => ({
      text: `Body ${i}.`,
      role: "body",
    })),
  );
  const out = selectTagInput(data.markdown, data.segments, data.roles);
  expect(out.fragments).toHaveLength(8);
  expect(out.coverage).toMatchObject({
    selection: "body-fallback",
    available_segments: 10,
    truncated: true,
  });
  expect(out.coverage.sections[0]!.omitted["fallback-segment-limit"]).toBe(2);
});
it("reports a single oversized fragment as omitted without splitting its evidence scope", () => {
  const data = source([{ text: "x".repeat(65537), role: "abstract" }]);
  const out = selectTagInput(data.markdown, data.segments, data.roles);
  expect(out.fragments).toEqual([]);
  expect(out.coverage.included_utf8_bytes).toBe(0);
  expect(out.coverage.sections[0]!.omitted["section-byte-limit"]).toBe(1);
});
