import { expect, it } from "vitest";
import { parseAssetId, sha256 } from "@sciretriever/contracts";
import { fakeRawParseServer, type RawParseFault } from "./raw-parse-server.js";
import { MinerULoopbackParser } from "../src/parsing/backends/mineru/loopback.js";
import { NetworkBudgetCoordinator } from "../src/network/budget.js";
import { workbenchPdf } from "../src/workbench/synthetic-fixture.js";

it.each([
  null,
  "backend",
  "missing-v2",
  "unknown-type",
  "failure",
  "timeout",
] as const)(
  "uses real production protocol with synthetic dual-profile service (%s)",
  async (fault: RawParseFault | null) => {
    const server = await fakeRawParseServer(
      fault ? { "vlm-engine": fault } : {},
    );
    const coordinator = new NetworkBudgetCoordinator();
    try {
      const parser = new MinerULoopbackParser({
        baseUrl: server.url,
        modelIdentity: "synthetic",
        coordinator,
        timeoutMs: fault === "timeout" ? 150 : 5000,
        pollIntervalMs: 5,
      });
      const bytes = workbenchPdf();
      const request = {
        source_asset_id: parseAssetId("00000000-0000-0000-0000-000000000990"),
        source_sha256: await sha256(bytes),
        media_type: "application/pdf" as const,
        withContent: async <T>(
          fn: (chunks: AsyncIterable<Uint8Array>) => Promise<T>,
        ) =>
          fn(
            (async function* () {
              yield bytes;
            })(),
          ),
      };
      const pipeline = await parser.parseRaw(request, "pipeline");
      expect(pipeline.result.profile).toBe("pipeline");
      if (fault)
        await expect(
          parser.parseRaw(request, "vlm-engine"),
        ).rejects.toMatchObject({
          code:
            fault === "timeout" || fault === "failure"
              ? "parser-unavailable"
              : "parser-structure",
        });
      else
        expect(
          (await parser.parseRaw(request, "vlm-engine")).result.profile,
        ).toBe("vlm-engine");
      expect(server.submitted.map((s) => s.profile)).toEqual([
        "pipeline",
        "vlm-engine",
      ]);
      expect(server.submitted[0]!.fields).toContain(
        'name="lang_list"\r\n\r\nch',
      );
      expect(server.submitted[0]!.fields).not.toContain(
        'name="image_analysis"',
      );
      expect(server.submitted[1]!.fields).toContain(
        'name="image_analysis"\r\n\r\ntrue',
      );
    } finally {
      coordinator.close();
      await server.close();
    }
  },
);
