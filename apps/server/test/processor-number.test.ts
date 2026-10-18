import { describe, expect, it } from "vitest";
import { reportedNumber } from "../src/analysis/processor-number.js";

describe("reported numeric typography", () => {
  it.each([
    ["25", 25],
    ["−60", -60],
    [".05", 0.05],
    ["9.27e-4", 0.000927],
    ["9.27 \\times 10^{-4}", 0.000927],
    ["$8 \\times 10^{-4}$", 0.0008],
    ["1.5 × 10⁻⁴", 0.00015],
    ["10^{−4}", 0.0001],
    ["0e-400", 0],
  ])("reads %s without changing its magnitude", (raw, value) => {
    expect(reportedNumber(String(raw))).toBe(value);
  });
  it.each([
    "-60 to -70",
    "2.5 ± 0.05",
    "<1",
    "~1",
    "1 2",
    "1/2",
    "2+3",
    "25 C",
    "1e400",
    "1e-400",
    "NaN",
    "Infinity",
  ])("refuses a range, expression, qualifier or invalid number: %s", (raw) => {
    expect(reportedNumber(raw)).toBeNull();
  });
});
