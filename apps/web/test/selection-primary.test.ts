import { expect, it } from "vitest";
import { selectionPrimary } from "../src/app/features/library/selection.js";

it("makes the first usable of 获取 PDF and 解析全文 the selection bar's primary, and none when both are disabled (page specs “连续选择与选择栏”)", () => {
  // Papers without a PDF: 获取 PDF leads, whatever 解析全文 can do.
  expect(selectionPrimary(undefined, undefined)).toBe("acquire");
  expect(
    selectionPrimary(
      undefined,
      "所选文献没有要解析全文的；解析全文需要先有 PDF",
    ),
  ).toBe("acquire");
  // All have PDFs: 解析全文 leads when it acts on some.
  expect(selectionPrimary("所选文献都已有 PDF", undefined)).toBe("archive");
  // Over the limit is disabled too, so it never leads.
  expect(selectionPrimary("最多处理 1,000 篇，请减少选择。", undefined)).toBe(
    "archive",
  );
  // Both 0: no primary at all.
  expect(
    selectionPrimary(
      "所选文献都已有 PDF",
      "所选文献没有要解析全文的；解析全文需要先有 PDF",
    ),
  ).toBeNull();
});
