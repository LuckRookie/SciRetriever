import { emptyQuery } from "../src/app/data/library.js";
import { parseLibraryCounts } from "@sciretriever/contracts";
import { expect, it } from "vitest";
import {
  MAIN_MATERIAL_STATES,
  MATERIAL_STATES,
  MORE_MATERIAL_STATES,
  materialCount,
  materialCountScope,
  materialQuery,
  queryMaterialState,
} from "../src/app/data/material-states.js";

const counts = parseLibraryCounts({
  total: 100,
  recently_opened: 0,
  statuses: {
    UNREVIEWED: 60,
    ASSET_READY: 15,
    ARCHIVING: 3,
    ARCHIVE_FAILED: 2,
    READY: 18,
    EXCLUDED: 2,
  },
  unavailable_pdf: 7,
  with_primary_pdf: 40,
  full_text: { total: 100, obtained: 40, missing: 60, exhausted: 7 },
});

it("splits the library into categories that do not overlap and add up to the total (page specs “界面用词”)", () => {
  expect(MAIN_MATERIAL_STATES.map((state) => state.label)).toEqual([
    "有全文",
    "有 PDF",
    "只有书目",
  ]);
  expect(MORE_MATERIAL_STATES.map((state) => state.label)).toEqual([
    "正在解析全文",
    "全文解析失败",
    "没找到 PDF",
    "已排除",
  ]);
  expect(
    MATERIAL_STATES.map((state) => [
      state.label,
      materialCount(counts, state.id),
    ]),
  ).toEqual([
    ["有全文", 18],
    ["有 PDF", 15],
    ["只有书目", 53],
    ["正在解析全文", 3],
    ["全文解析失败", 2],
    ["没找到 PDF", 7],
    ["已排除", 2],
  ]);
  expect(
    MATERIAL_STATES.reduce(
      (sum, state) => sum + materialCount(counts, state.id),
      0,
    ),
  ).toBe(counts.total);
});

it("selects one category with the existing query fields and reads it back", () => {
  const base = { ...emptyQuery(), venue: "Joule" };
  expect(materialQuery(base, "metadata")).toMatchObject({
    venue: "Joule",
    statuses: ["UNREVIEWED"],
    needs_manual_pdf: false,
    has_primary_pdf: null,
  });
  expect(materialQuery(base, "unavailable")).toMatchObject({
    statuses: [],
    needs_manual_pdf: true,
  });
  expect(materialQuery(base, "ASSET_READY")).toMatchObject({
    statuses: ["ASSET_READY"],
    needs_manual_pdf: null,
  });
  for (const state of [...MATERIAL_STATES.map((s) => s.id), ""] as const)
    expect(queryMaterialState(materialQuery(base, state))).toBe(state);
  // The counts leave the category out, so switching changes no number.
  expect(materialCountScope(materialQuery(base, "metadata"))).toEqual(
    materialCountScope(base),
  );
});
