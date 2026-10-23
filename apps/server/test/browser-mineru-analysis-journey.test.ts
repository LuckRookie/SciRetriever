import { initializeCatalogSchema } from "../src/storage/sqlite/catalog-schema.js";
import { fakeRawParseServer } from "./raw-parse-server.js";
import { workbenchTestAccess } from "./workbench-auth-fixture.js";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { TypeScriptConfigurationOwner } from "../src/configuration/owner.js";
import { startSyntheticWorkbench } from "../src/bootstrap/workbench.js";
import { verifyInstalledCloakRuntime } from "../src/configuration/cloak-runtime.js";
import { FIXTURE_LITERATURE } from "../src/workbench/synthetic-fixture.js";

const bundle = process.env.SCIRETRIEVER_CLOAK_BUNDLE;

it.skipIf(!bundle)(
  "runs Browser capture through the configured MinerU HTTP profile without starting analysis",
  async () => {
    const home = await mkdtemp(
      join(tmpdir(), "sciretriever-browser-mineru-analysis-"),
    );
    const mineru = await fakeRawParseServer();
    let modelCalls = 0;
    const model = createServer(async (request, response) => {
      for await (const _chunk of request) void _chunk;
      modelCalls++;
      response.writeHead(500);
      response.end("Analysis must not be invoked by parsing");
    });
    await new Promise<void>((resolveServer) =>
      model.listen(0, "127.0.0.1", resolveServer),
    );
    const address = model.address();
    if (!address || typeof address === "string")
      throw new Error("model fixture unavailable");
    await initializeCatalogSchema(join(home, "catalog.sqlite"));
    const owner = new TypeScriptConfigurationOwner(home);
    await owner.publish(
      `[providers.fixture]\napi = "openai-chat-completions"\nbase_url = "http://127.0.0.1:${address.port}/v1"\n[models."fixture/journey-model"]\nstream = false\n[analyze]\nmodel = "fixture/journey-model"\nmetadata_max_output_tokens = 2048\ncontent_max_output_tokens = 4096\nmax_input_bytes = 1048576\nmax_chunk_bytes = 1048576\nmax_chunk_count = 1\nmax_total_llm_requests = 2\nmax_total_output_tokens = 6144\n[parsing]\nbase_url = "${mineru.url}"\nconnection_mode = "loopback"\nmodel_identity = "operator-vlm-model@fixture-revision"\n`,
      "missing",
      ["providers", "models", "analyze", "parsing"],
    );
    const browserRuntime = await verifyInstalledCloakRuntime(bundle!);
    let workbench:
      | Awaited<ReturnType<typeof startSyntheticWorkbench>>
      | undefined;
    try {
      workbench = await startSyntheticWorkbench({
        access: workbenchTestAccess,
        home,
        runtime: browserRuntime,
        assets: new Map(),
        configurationOwner: owner,
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
        request_id: "browser-mineru-download",
        input: {
          kind: "click-element",
          element_id: download.element_id,
          revision: observation.observation_revision,
        },
      });
      await expect
        .poll(() => workbench!.session.view().candidates.length, {
          timeout: 15000,
        })
        .toBe(1);
      const candidate = workbench.session.view().candidates[0]!;
      await workbench.session.acceptCandidate(client, {
        session_id: workbench.session.id,
        control_epoch: workbench.session.view().control.epoch,
        transfer_id: candidate.transfer_id,
        sha256: candidate.sha256,
      });
      const completion = await workbench.application.completion!.complete({
        literature_id: FIXTURE_LITERATURE.literature_id,
        transfer_ids: [],
      });
      expect(completion.outcome).toBe("parser_results_ready");
      if (completion.outcome !== "parser_results_ready")
        throw new Error("raw parse unavailable");
      expect(
        completion.receipt.profiles.map((p) => [p.profile, p.status]),
      ).toEqual([["vlm-engine", "published"]]);
      const raw = await workbench.application.rawParseStorage!.current(
        completion.receipt.asset_id,
      );
      expect(raw.map((p) => p.result?.profile).sort()).toEqual(["vlm-engine"]);
      for (const row of raw) {
        expect(row.result?.blocks).not.toBeNull();
        expect(row.result?.model_identity).toBe(
          `operator-vlm-model@fixture-revision/${row.profile}`,
        );
      }
      const detail = await workbench.application.library.detail(
        FIXTURE_LITERATURE.literature_id,
      );
      expect(detail.literature.status).toBe("ASSET_READY");
      expect(detail).not.toHaveProperty("parser_result");
      expect(detail).not.toHaveProperty("content");
      expect(modelCalls).toBe(0);
      expect(mineru.submitted.map((s) => s.profile).sort()).toEqual([
        "vlm-engine",
      ]);
      expect(
        await workbench.application.library.search({
          query: { text: FIXTURE_LITERATURE.metadata.title },
          limit: 10,
          sort: "relevance",
          cursor: null,
        }),
      ).toMatchObject({
        items: [
          { literature: { literature_id: FIXTURE_LITERATURE.literature_id } },
        ],
      });
    } finally {
      await workbench?.close();
      model.closeAllConnections();
      await new Promise<void>((resolveClose, reject) =>
        model.close((error) => (error ? reject(error) : resolveClose())),
      );
      await mineru.close();
      await rm(home, { recursive: true, force: true });
    }
  },
  120_000,
);
