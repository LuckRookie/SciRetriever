import { expect, it } from "vitest";
import { parseWebPageData, WEB_PAGE_LIMITS } from "../src/index.js";
const page = {
  url: "https://synthetic.invalid/article",
  title: "Original  title",
  meta: [
    { attribute: "name", key: "Citation_Title", content: "  Raw content  " },
  ],
  json_ld: ["{not JSON; interpretation is the adapter's task}"],
  is_pdf: false,
};
it("preserves the closed original page shape without interpreting tags or JSON-LD", () => {
  expect(parseWebPageData(page)).toEqual(page);
  for (const input of [
    { ...page, token: "synthetic" },
    { ...page, title: 1 },
    { ...page, is_pdf: 1 },
    { ...page, meta: [{ ...page.meta[0], attribute: "http-equiv" }] },
    { ...page, meta: [{ ...page.meta[0], extra: "x" }] },
    { ...page, json_ld: [{}] },
    { ...page, url: "file:///synthetic.pdf" },
    { ...page, url: "https://user:synthetic@synthetic.invalid" },
  ])
    expect(() => parseWebPageData(input)).toThrow();
});
it("enforces all counts and byte limits before interpretation", () => {
  expect(
    parseWebPageData({
      ...page,
      meta: Array.from({ length: 500 }, () => page.meta[0]),
    }).meta,
  ).toHaveLength(500);
  expect(() =>
    parseWebPageData({
      ...page,
      meta: Array.from({ length: 501 }, () => page.meta[0]),
    }),
  ).toThrow();
  expect(
    parseWebPageData({ ...page, json_ld: Array(5).fill("{}") }),
  ).toMatchObject({ json_ld: Array(5).fill("{}") });
  expect(() =>
    parseWebPageData({ ...page, json_ld: Array(6).fill("{}") }),
  ).toThrow();
  expect(
    parseWebPageData({
      ...page,
      json_ld: ["x".repeat(WEB_PAGE_LIMITS.json_ld_bytes)],
    }).json_ld[0]!.length,
  ).toBe(WEB_PAGE_LIMITS.json_ld_bytes);
  expect(() =>
    parseWebPageData({
      ...page,
      json_ld: ["x".repeat(WEB_PAGE_LIMITS.json_ld_bytes + 1)],
    }),
  ).toThrow();
  expect(() =>
    parseWebPageData({ ...page, json_ld: ["啊".repeat(30_000)] }),
  ).toThrow();
  expect(() =>
    parseWebPageData({ ...page, title: "x".repeat(WEB_PAGE_LIMITS.bytes) }),
  ).toThrow();
});
