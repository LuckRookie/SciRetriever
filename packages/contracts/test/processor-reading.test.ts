import { expect, it } from "vitest";
import {
  ContractValidationError,
  parseProcessorReading,
  PROCESSOR_READING_SCHEMA,
} from "../src/index.js";

it("accepts reading scope while leaving chunk size exclusively to the operator", () => {
  expect(parseProcessorReading()).toEqual({ scope: "full", query: null });
  expect(parseProcessorReading({ scope: "search", query: "catalyst" })).toEqual(
    { scope: "search", query: "catalyst" },
  );
  expect(PROCESSOR_READING_SCHEMA.properties).not.toHaveProperty(
    "max_chunk_bytes",
  );
  for (const reading of [
    { max_chunk_bytes: 12000 },
    { scope: "search" },
    { scope: "search", query: " " },
    { scope: "full", query: "catalyst" },
    { scope: "unknown" },
  ])
    expect(() => parseProcessorReading(reading)).toThrow(
      ContractValidationError,
    );
});
