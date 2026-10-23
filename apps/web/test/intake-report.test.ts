import { expect, it } from "vitest";
import { readIntakeReport } from "../src/app/data/intake.js";

it("distinguishes rejected imports from accepted and already present papers", () => {
  const report = readIntakeReport({
    format: "bibtex",
    items: [
      { disposition: "created", record_index: 0, reason: null },
      { disposition: "matched", record_index: 1, reason: null },
      { disposition: "enriched", record_index: 2, reason: null },
      { disposition: "rejected", record_index: 3, reason: "malformed-record" },
    ],
  });
  expect(report.status).toBe("partial");
  expect(report.summary).toBe(
    "新增 1 篇 · 补充 1 篇 · 已存在 1 篇 · 未接纳 1 条",
  );
  expect(report.notices).toEqual(["第 4 条：记录格式不完整或无法解析。"]);
  expect(
    readIntakeReport({
      format: "ris",
      items: [
        { disposition: "rejected", record_index: 0, reason: "empty-document" },
      ],
    }).status,
  ).toBe("failed");
});

it("preserves partial, failed and interrupted discovery despite HTTP success", () => {
  const base = {
    accepted_count: 2,
    matched_count: 3,
    source_results: [
      {
        provider_name: "crossref",
        outcome: "FAILED",
        failure: { reason: "internal English reason" },
      },
    ],
  };
  expect(readIntakeReport({ ...base, status: "PARTIAL" })).toMatchObject({
    status: "partial",
    label: "部分完成",
    summary: "已接纳 2 条元数据 · 匹配已有 3 条",
  });
  expect(readIntakeReport({ ...base, status: "FAILED" }).status).toBe("failed");
  expect(readIntakeReport({ ...base, status: "INTERRUPTED" }).label).toBe(
    "已中断",
  );
  expect(
    readIntakeReport({ ...base, status: "FAILED" }).notices.join(),
  ).not.toContain("internal English reason");
  expect(
    readIntakeReport({
      status: "COMPLETED",
      result_count: 4,
      source_results: [],
    }).summary,
  ).toContain("4 篇文献");
  expect(() => readIntakeReport({ accepted: 1 })).toThrow();
  expect(() =>
    readIntakeReport({ ...base, accepted_count: -1, status: "COMPLETED" }),
  ).toThrow();
});
