import { expect, it } from "vitest";
import { parseAnalysisInputIdentity } from "@sciretriever/contracts";
import { ContentAnalysisService } from "../src/entry/content-analysis.js";

const id = "00000000-0000-0000-0000-000000000001";
const input = parseAnalysisInputIdentity({
  literature_id: id,
  primary_asset_id: "00000000-0000-0000-0000-000000000002",
  primary_pdf_sha256: "a".repeat(64),
  parser_result_sha256: "b".repeat(64),
  input_metadata_revision: 3,
  input_metadata_sha256: "c".repeat(64),
});
it("returns the explicit no-content input identity without invoking content acceptance or claiming cleanup", async () => {
  let accepts = 0;
  const service = new ContentAnalysisService(
    { analyzeContent: async () => ({ outcome: "no_usable_content", input }) },
    {
      accept: async () => {
        accepts++;
        throw new Error("unexpected acceptance");
      },
    },
  );
  try {
    const result = await service.analyzeCurrent(id);
    expect(result).toEqual({ outcome: "no_usable_content", input });
    expect(Object.isFrozen(result)).toBe(true);
    if (result.outcome !== "no_usable_content")
      throw new Error("wrong outcome");
    expect(Object.isFrozen(result.input)).toBe(true);
    expect(accepts).toBe(0);
  } finally {
    await service.close();
  }
});
it("rejects a decision for another Literature and preserves ordinary Analysis failures", async () => {
  let accepts = 0,
    calls = 0;
  const failure = new Error("fixture analysis failure");
  const service = new ContentAnalysisService(
    {
      analyzeContent: async () => {
        if (++calls === 1)
          return {
            outcome: "no_usable_content",
            input: parseAnalysisInputIdentity({
              ...input,
              literature_id: input.primary_asset_id,
            }),
          };
        throw failure;
      },
    },
    {
      accept: async () => {
        accepts++;
        throw new Error("unexpected acceptance");
      },
    },
  );
  try {
    await expect(service.analyzeCurrent(id)).rejects.toMatchObject({
      code: "content-analysis-contract",
    });
    await expect(service.analyzeCurrent(id)).rejects.toBe(failure);
    expect(accepts).toBe(0);
  } finally {
    await service.close();
  }
});
it("close cancels pending Analysis, waits for it, and prevents later calls", async () => {
  let calls = 0,
    accepts = 0,
    released = false;
  const service = new ContentAnalysisService(
    {
      analyzeContent: async (_id, signal) => {
        calls++;
        await new Promise<void>((r) =>
          signal!.addEventListener("abort", () => r(), { once: true }),
        );
        released = true;
        return { outcome: "no_usable_content", input };
      },
    },
    {
      accept: async () => {
        accepts++;
        throw new Error("unexpected acceptance");
      },
    },
  );
  const pending = service.analyzeCurrent(id);
  const rejected = expect(pending).rejects.toMatchObject({
    code: "content-analysis-cancelled",
  });
  await service.close();
  await rejected;
  expect(released).toBe(true);
  expect(accepts).toBe(0);
  await expect(service.analyzeCurrent(id)).rejects.toMatchObject({
    code: "content-analysis-closed",
  });
  expect(calls).toBe(1);
  await service.close();
});
it("validates the entire neutral input identity and rejects cancellation before Analysis starts", async () => {
  for (const value of [
    { ...input, input_metadata_revision: 0 },
    { ...input, parser_result_sha256: "wrong" },
    { ...input, cleared: true },
  ])
    expect(() => parseAnalysisInputIdentity(value)).toThrow();
  let calls = 0;
  const service = new ContentAnalysisService(
    {
      analyzeContent: async () => {
        calls++;
        return { outcome: "no_usable_content", input };
      },
    },
    {
      accept: async () => {
        throw new Error("unexpected acceptance");
      },
    },
  );
  try {
    await expect(
      service.analyzeCurrent(id, AbortSignal.abort()),
    ).rejects.toMatchObject({ code: "content-analysis-cancelled" });
    expect(calls).toBe(0);
  } finally {
    await service.close();
  }
});
