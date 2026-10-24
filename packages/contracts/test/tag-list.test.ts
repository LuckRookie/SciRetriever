import { describe, expect, it } from "vitest";
import { parseTag, parseTagListItem } from "../src/tags.js";

const tag = {
  tag_id: "00000000-0000-4000-8000-000000000001",
  name_zh: "",
  name_en: "Synthetic topic",
  aliases: ["Synthetic alias"],
  definition: { includes: "Synthetic topic", excludes: "" },
  parent_id: null,
  category: null,
  kind: "topic",
  status: "active",
  merged_into: null,
  locked: false,
  created_vocab_version: 1,
  backfilled_vocab_version: null,
  examples: [],
};

describe("tag list read projection", () => {
  it("adds uses without changing the strict stored Tag contract", () => {
    const item = parseTagListItem({ ...tag, uses: 0 });
    expect(item).toEqual({ ...parseTag(tag), uses: 0 });
    expect(Object.isFrozen(item)).toBe(true);
    expect(parseTagListItem({ ...tag, uses: 17 }).uses).toBe(17);
    expect(() => parseTag(item)).toThrow();
    expect(() => parseTagListItem({ ...tag, uses: 1, extra: true })).toThrow();
    expect(() =>
      parseTagListItem({ ...tag, tag_id: "invalid", uses: 1 }),
    ).toThrow();
    expect(() =>
      parseTagListItem(Object.assign(Object.create({ uses: 1 }), tag)),
    ).toThrow();
  });
  it.each([undefined, null, -1, 1.5, "2", NaN, Infinity, 2 ** 53])(
    "rejects invalid or missing uses: %s",
    (uses) => {
      expect(() => parseTagListItem({ ...tag, uses })).toThrow();
    },
  );
});
