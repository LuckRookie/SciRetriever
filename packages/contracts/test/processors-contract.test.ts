import { describe, expect, it } from "vitest";
import {
  parseProcessorInvocation,
  parseProcessorResult,
  processorComparison,
  processorPointer,
  type ProcessorInvocation,
  type ProcessorContent,
  processorValues,
  uncheckedProcessorValues,
  parseProcessorValueChecks,
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
        kind: "snapshot",
        input_id: "i1",
        snapshot_id: id(1),
        content_sha256: "a".repeat(64),
        mapped_results: [],
      },
    ],
    execution: {
      reads: { parts: "main", roles: "all" },
      uses_description: false,
      map: null,
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
    value_checks: [],
    coverage: [
      {
        input_id: "i1",
        parts: [],
        status: "complete",
        read_segments: [],
        gaps: [],
      },
    ],
    producer: "internal",
    provenance: {},
    literature_ids: [],
    created_at: "2026-10-18T00:00:00Z",
  };
}
describe("processor contracts", () => {
  it("checks each array value and refuses duplicated evidence in place of a distinct source", () => {
    const sources = [1, 2].map((n) => ({
      kind: "result" as const,
      result_id: id(n),
      content_sha256: "a".repeat(64),
      record_id: "source",
      pointer: "/yield",
    }));
    const content: ProcessorContent = {
      kind: "records",
      schema: { type: "object" },
      records: [
        {
          record_id: "r",
          payload: {
            values: [
              { value: 12, raw: "12", unit: "%" },
              { value: 15, raw: "15", unit: "%" },
            ],
          },
          evidence: [{ pointer: "/values", sources }],
          missing: {},
        },
      ],
    };
    expect(processorValues(content).map((v) => v.pointer)).toEqual([
      "/values/0",
      "/values/1",
    ]);
    const checks = uncheckedProcessorValues(content, "Unverified candidate.");
    expect(parseProcessorValueChecks(checks, content)).toEqual(checks);
    expect(() =>
      parseProcessorValueChecks(
        [
          {
            ...checks[0],
            sources: [checks[0]!.sources[0], checks[0]!.sources[0]],
          },
          checks[1],
        ],
        content,
      ),
    ).toThrow();
    expect(() =>
      parseProcessorValueChecks(checks.slice(0, 1), content),
    ).toThrow();
  });
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
          parts: [],
          input_id: "i1",
          status: "partial",
          read_segments: [],
          gaps: ["truncated"],
        },
      ],
      [
        {
          parts: [],
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
          parts: [],
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
