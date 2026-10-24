import { describe, expect, it } from "vitest";
import { ContractValidationError, parseTaskProgress } from "../src/index.js";

describe("task list progress contract", () => {
  it.each([
    { total: 0, done: 0 },
    { total: 5, done: 3 },
    { total: 2, done: 2 },
  ])("accepts bounded target counts %j", (progress) => {
    expect(parseTaskProgress(progress)).toEqual(progress);
    expect(Object.isFrozen(parseTaskProgress(progress))).toBe(true);
  });
  it.each([
    null,
    {},
    { total: 1 },
    { total: 0, done: 1 },
    { total: 1, done: -1 },
    { total: -1, done: 0 },
    { total: 1.5, done: 1 },
    { total: 2, done: 0.5 },
    { total: "2", done: 1 },
    { total: Number.MAX_SAFE_INTEGER + 1, done: 0 },
    { total: 1, done: 1, attempts: 2 },
  ])("rejects malformed progress %j", (value) => {
    expect(() => parseTaskProgress(value)).toThrow(ContractValidationError);
  });
});
