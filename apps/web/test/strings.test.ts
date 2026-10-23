import { expect, it } from "vitest";
import { readerErrorMessage } from "../src/reading/dom.js";
import {
  errorMessage,
  serviceMessage,
  valueCheckReason,
} from "../src/app/strings.js";
it("localizes service diagnostics without exposing arbitrary English reasons", () => {
  expect(valueCheckReason("cited-value-missing")).toContain("所引校订片段");
  expect(
    valueCheckReason(
      "At least one cited number is absent from the corrected fragment.",
    ),
  ).toContain("对应原文");
  expect(errorMessage(new Error("Unexpected provider failure"))).not.toContain(
    "Unexpected provider failure",
  );
  expect(errorMessage(new Error("请填写字段说明。"))).toBe("请填写字段说明。");
  expect(serviceMessage("parser-unavailable")).toContain("解析服务");
  expect(serviceMessage("command-rejected")).toContain("任务操作未被接受");
  expect(errorMessage(new Error("contract validation failed"))).toContain(
    "无法通过验证",
  );
  expect(
    readerErrorMessage(new Error("正文尚未完整，缺少续读游标"), "无法读取正文"),
  ).toContain("缺少续读游标");
  expect(
    readerErrorMessage(
      new Error("Unexpected transport failure"),
      "无法读取正文",
    ),
  ).toBe("无法读取正文");
});
