import { describe, expect, it } from "vitest";
import {
  parseProcessorInvocation,
  parseProcessorResult,
  processorComparison,
  processorPointer,
  type ProcessorInvocation,
} from "../src/index.js";
const id = (n: number) =>
  `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const invocation = (): ProcessorInvocation =>
  parseProcessorInvocation({
    schema_version: 1,
    processor: { id: "test", version: "1" },
    spec: { question: "air" },
    inputs: [
      {
        kind: "result",
        input_id: "i1",
        result_id: id(1),
        content_sha256: "a".repeat(64),
        record_ids: null,
      },
    ],
    execution: {
      method_sha256: "b".repeat(64),
      model: { provider: "fixture", model: "a" },
    },
  });
async function result() {
  const input = invocation();
  return {
    schema_version: 1,
    result_id: id(2),
    invocation: input,
    comparison_sha256: await processorComparison(input),
    status: "empty",
    content: { kind: "records", schema: { type: "object" }, records: [] },
    coverage: [
      { input_id: "i1", status: "complete", read_segments: [], gaps: [] },
    ],
    producer: "internal",
    provenance: {},
    literature_ids: [],
    created_at: "2026-10-18T00:00:00Z",
  };
}
describe("processor contracts", () => {
  it("includes model, method, specification, and upstream versions in reuse identity", async () => {
    const base = invocation();
    const original = await processorComparison(base);
    for (const value of [
      { ...base, spec: { question: "water" } },
      { ...base, execution: { ...base.execution, model: { model: "b" } } },
      { ...base, processor: { ...base.processor, version: "2" } },
      {
        ...base,
        inputs: [{ ...base.inputs[0]!, content_sha256: "c".repeat(64) }],
      },
    ])
      expect(
        await processorComparison(parseProcessorInvocation(value)),
      ).not.toBe(original);
  });
  it("cannot publish empty from an incomplete or unreported scope", async () => {
    expect((await parseProcessorResult(await result())).status).toBe("empty");
    for (const coverage of [
      [],
      [
        {
          input_id: "i1",
          status: "partial",
          read_segments: [],
          gaps: ["truncated"],
        },
      ],
      [
        {
          input_id: "unknown",
          status: "complete",
          read_segments: [],
          gaps: [],
        },
      ],
    ])
      await expect(
        parseProcessorResult({ ...(await result()), coverage }),
      ).rejects.toThrow();
  });
  it("keeps partial result identity independent of the computation key", async () => {
    const a = await parseProcessorResult({
      ...(await result()),
      status: "ok",
      coverage: [
        {
          input_id: "i1",
          status: "partial",
          read_segments: [],
          gaps: ["unreadable"],
        },
      ],
    });
    const b = await parseProcessorResult({ ...a, result_id: id(3) });
    expect(a.comparison_sha256).toBe(b.comparison_sha256);
    expect(a.result_id).not.toBe(b.result_id);
  });
  it("rejects prototype paths, duplicate input identities and malformed status", async () => {
    expect(() => processorPointer({ x: 1 }, "/__proto__")).toThrow();
    expect(() => processorPointer([1], "/00")).toThrow();
    const value = invocation();
    expect(() =>
      parseProcessorInvocation({
        ...value,
        inputs: [...value.inputs, ...value.inputs],
      }),
    ).toThrow();
    await expect(
      parseProcessorResult({ ...(await result()), status: "failed" }),
    ).rejects.toThrow();
  });
});
