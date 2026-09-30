import { expect, it, vi } from "vitest";
import {
  extractionSpecHash,
  EXTRACTION_SCHEMA_URI,
} from "@sciretriever/contracts";

const workerState = vi.hoisted(() => ({
  count: 0,
  options: null as unknown,
}));
vi.mock("node:worker_threads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:worker_threads")>();
  class ControlledWorker {
    private readonly listeners = new Map<string, (value: unknown) => void>();
    constructor(_path: unknown, options: unknown) {
      workerState.count++;
      workerState.options = options;
      const attempt = workerState.count;
      queueMicrotask(() => {
        if (attempt === 1)
          this.listeners.get("error")?.(
            Object.assign(new Error("worker memory limit"), {
              code: "ERR_WORKER_OUT_OF_MEMORY",
            }),
          );
        else this.listeners.get("message")?.({ valid: true, issue: null });
      });
    }
    once(name: string, listener: (value: unknown) => void): this {
      this.listeners.set(name, listener);
      return this;
    }
    removeAllListeners(name: string): this {
      this.listeners.delete(name);
      return this;
    }
    async terminate(): Promise<number> {
      return 0;
    }
  }
  return { ...actual, Worker: ControlledWorker };
});
import { validateExtractionSpec } from "../src/extraction/spec.js";

it("classifies worker resource exit and releases admission for the next schema", async () => {
  const content = {
    schema_version: 1 as const,
    spec_id: "resource-test",
    spec_version: "1",
    record_meaning: "synthetic record",
    output_schema: { $schema: EXTRACTION_SCHEMA_URI, type: "object" },
    field_instructions: [],
    inclusion_rules: [],
    missing_value_rules: [],
    evidence_policy: {
      field_granularity: "file" as const,
      required_pointers: "record-root" as const,
      cross_input_relation: "optional" as const,
    },
    required_capabilities: [],
  };
  const spec = { ...content, spec_sha256: await extractionSpecHash(content) };
  await expect(validateExtractionSpec(spec)).rejects.toMatchObject({
    code: "schema-resource-limit",
  });
  expect(await validateExtractionSpec(spec)).toMatchObject({
    spec_id: "resource-test",
  });
  expect(workerState.count).toBe(2);
  expect(workerState.options).toMatchObject({
    resourceLimits: {
      maxOldGenerationSizeMb: 64,
      maxYoungGenerationSizeMb: 16,
      codeRangeSizeMb: 16,
      stackSizeMb: 2,
    },
  });
});
