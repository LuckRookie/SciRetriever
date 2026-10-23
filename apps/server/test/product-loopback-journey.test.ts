import { initializeCatalogSchema } from "../src/storage/sqlite/catalog-schema.js";
import { rawParserFixture } from "./raw-parser-fixture.js";
import { workbenchTestAccess } from "./workbench-auth-fixture.js";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  parseArtifactRef,
  parseProvenance,
  sha256,
} from "@sciretriever/contracts";
import { startSyntheticWorkbench } from "../src/bootstrap/workbench.js";
import { verifyInstalledCloakRuntime } from "../src/configuration/cloak-runtime.js";
import { TypeScriptConfigurationOwner } from "../src/configuration/owner.js";
import { FIXTURE_LITERATURE } from "../src/workbench/synthetic-fixture.js";

const bundle = process.env.SCIRETRIEVER_CLOAK_BUNDLE;

it.skipIf(!bundle)(
  "runs real Browser capture through publication and raw parsing without analysis",
  async () => {
    const home = await mkdtemp(join(tmpdir(), "sciretriever-product-journey-"));
    let calls = 0;
    const model = createServer(async (request, response) => {
      for await (const chunk of request) void chunk;
      calls++;
      response.writeHead(500);
      response.end("Analysis must not be invoked by parsing");
    });
    await new Promise<void>((done) => model.listen(0, "127.0.0.1", done));
    const address = model.address();
    if (!address || typeof address === "string")
      throw new Error("model unavailable");
    await initializeCatalogSchema(join(home, "catalog.sqlite"));
    const owner = new TypeScriptConfigurationOwner(home);
    await owner.publish(
      `[providers.fixture]\napi = "openai-chat-completions"\nbase_url = "http://127.0.0.1:${address.port}/v1"\n[models."fixture/journey-model"]\nstream = false\n[analyze]\nmodel = "fixture/journey-model"\nmetadata_max_output_tokens = 2048\ncontent_max_output_tokens = 4096\nmax_input_bytes = 1048576\nmax_chunk_bytes = 1048576\nmax_chunk_count = 1\nmax_total_llm_requests = 2\nmax_total_output_tokens = 6144\n`,
      "missing",
      ["providers", "models", "analyze"],
    );
    const runtime = await verifyInstalledCloakRuntime(bundle!);
    let workbench:
      | Awaited<ReturnType<typeof startSyntheticWorkbench>>
      | undefined;
    try {
      workbench = await startSyntheticWorkbench({
        access: workbenchTestAccess,
        home,
        runtime,
        assets: new Map(),
        configurationOwner: owner,
        applicationOptions: {
          parsing: {
            rawParser: rawParserFixture({
              parse: async (request) => {
                const bytes = new TextEncoder().encode(
                  "# Parsed loopback journey\n\nSynthetic content.\n",
                );
                return {
                  source_asset_id: request.source_asset_id,
                  source_sha256: request.source_sha256,
                  page_count: 1,
                  markdown: {
                    bytes,
                    artifact: parseArtifactRef({
                      sha256: await sha256(bytes),
                      byte_size: bytes.byteLength,
                      media_type: "text/markdown",
                    }),
                  },
                  resources: [],
                  provenance: {
                    provenance: parseProvenance({
                      provenance_id: "00000000-0000-0000-0000-000000009001",
                      source_kind: "parser",
                      source_name: "loopback-journey",
                      source_record_id: null,
                      observed_at: "2026-09-10T00:00:00Z",
                      input_sha256: request.source_sha256,
                      parameters_sha256: "a".repeat(64),
                    }),
                    parser_version: "loopback-journey",
                    mode: null,
                    model_identity: null,
                  },
                };
              },
            }),
          },
        },
      });
      const client = workbench.session.attach();
      workbench.session.takeover(
        client,
        workbench.session.view().control.epoch,
      );
      // Navigation commits before Cloak necessarily has a readable surface.
      // Follow the same refresh contract as a connected workbench client.
      await expect
        .poll(
          async () => {
            await workbench!.session.refresh();
            return workbench!.session
              .view()
              .observation?.elements.some(
                (element) => element.name === "Download PDF",
              );
          },
          { timeout: 15_000 },
        )
        .toBe(true);
      const observation = workbench.session.view().observation!;
      const download = observation.elements.find(
        (element) => element.name === "Download PDF",
      );
      if (!download) throw new Error("download action unavailable");
      await workbench.session.command(client, {
        session_id: observation.session_id,
        page_id: observation.page_id,
        document_generation: observation.document_generation,
        observation_revision: observation.observation_revision,
        viewport_revision: observation.viewport_revision,
        control_epoch: workbench.session.view().control.epoch,
        request_id: "product-journey-download",
        input: {
          kind: "click-element",
          element_id: download.element_id,
          revision: observation.observation_revision,
        },
      });
      await expect
        .poll(() => workbench!.session.view().candidates.length, {
          timeout: 15_000,
        })
        .toBe(1);
      const candidate = workbench.session.view().candidates[0]!;
      await workbench.session.acceptCandidate(client, {
        session_id: workbench.session.id,
        control_epoch: workbench.session.view().control.epoch,
        transfer_id: candidate.transfer_id,
        sha256: candidate.sha256,
      });
      const result = await workbench.application.completion!.complete({
        literature_id: FIXTURE_LITERATURE.literature_id,
        transfer_ids: [],
      });
      expect(result.outcome).toBe("parser_results_ready");
      if (result.outcome !== "parser_results_ready")
        throw new Error("raw parse unavailable");
      expect(result.receipt.profiles.map((p) => [p.profile, p.status])).toEqual(
        [["vlm-engine", "published"]],
      );
      const detail = await workbench.application.library.detail(
        FIXTURE_LITERATURE.literature_id,
      );
      expect(detail.literature.status).toBe("ASSET_READY");
      expect(detail).not.toHaveProperty("content");
      expect(detail).not.toHaveProperty("parser_result");
      expect(calls).toBe(0);
    } finally {
      await workbench?.close();
      await new Promise<void>((done, reject) =>
        model.close((error) => (error ? reject(error) : done())),
      );
      await rm(home, { recursive: true, force: true });
    }
  },
  30_000,
);
