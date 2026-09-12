import { describe, expect, it } from "vitest";
import { TieredAcquisitionService } from "../src/acquisition/tiered.js";
import { safeLocator, PublicAcquisitionRegistry } from "../src/index.js";
import type { AcquisitionSourcePort } from "../src/acquisition/sources/public.js";

function source(
  sourceName: string,
  discover: AcquisitionSourcePort["discover"],
): AcquisitionSourcePort {
  return { source_name: sourceName, ready: true, discover };
}

const item = (key: string) => ({
  key,
  request: { identifiers: [{ namespace: "doi", value: key }] },
});

describe("tiered acquisition batch", () => {
  it("keeps mixed success, exhaustion and source errors separate", async () => {
    const first = source("first", async (request) => {
      const key = request.identifiers[0]?.value;
      if (key === "fail") throw new Error("fixture source failure");
      if (key === "empty") return [];
      return [safeLocator("first", "https://fixture.test/first.pdf")];
    });
    const fallback = source("fallback", async (request) => {
      if (request.identifiers[0]?.value === "success")
        return [safeLocator("fallback", "https://fixture.test/fallback.pdf")];
      return [];
    });
    const progress: string[] = [];
    const service = new TieredAcquisitionService(
      new PublicAcquisitionRegistry([first, fallback], ["first", "fallback"]),
      { cooldown_ms: 0 },
    );
    const results = await service.run(
      [item("success"), item("empty"), item("fail")],
      async (_item, sourcePort, candidate) => {
        progress.push(`${sourcePort.source_name}:${candidate.locator}`);
      },
      {
        on_progress: (event) =>
          progress.push(`${event.key}:${event.disposition}`),
      },
    );
    expect(results.map((result) => result.disposition)).toEqual([
      "acquired",
      "exhausted",
      "failed",
    ]);
    expect(results[0]).toMatchObject({
      source: "first",
      candidate: { kind: "pdf" },
    });
    expect(results[1]).toMatchObject({ source: null, failure: null });
    expect(results[2]).toMatchObject({
      failure: {
        code: "source-discovery-failed",
        source: "first",
        retryable: true,
      },
    });
    expect(progress).toContain("success:acquired");
  });

  it("applies never, notify and pause without converting a source error to entitlement", async () => {
    const broken = source("broken", async () => {
      throw new Error("blocked fixture");
    });
    const registry = new PublicAcquisitionRegistry([broken], ["broken"]);
    const run = (assistance: "never" | "notify" | "pause") =>
      new TieredAcquisitionService(registry, {
        assistance,
        cooldown_ms: 0,
      }).run([item("x")], async () => undefined);
    await expect(run("never")).resolves.toMatchObject([
      { disposition: "failed", failure: { code: "source-discovery-failed" } },
    ]);
    await expect(run("notify")).resolves.toMatchObject([
      { disposition: "skipped", failure: { code: "assistance-skipped" } },
    ]);
    await expect(run("pause")).resolves.toMatchObject([
      { disposition: "interrupted", failure: { code: "assistance-required" } },
    ]);
  });

  it("stops a batch at a cancellation boundary and does not replay completed items", async () => {
    const controller = new AbortController();
    const sourcePort = source("fixture", async () => {
      controller.abort();
      return [safeLocator("fixture", "https://fixture.test/a.pdf")];
    });
    const service = new TieredAcquisitionService(
      new PublicAcquisitionRegistry([sourcePort], ["fixture"]),
      { cooldown_ms: 0 },
    );
    const results = await service.run(
      [item("first"), item("second")],
      async () => undefined,
      { signal: controller.signal },
    );
    expect(results.map((result) => result.disposition)).toEqual([
      "interrupted",
      "interrupted",
    ]);
    expect(results[1]?.failure?.code).toBe("execution-cancelled");
  });
});
