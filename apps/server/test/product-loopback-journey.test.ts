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
import { TypeScriptParserArtifactRules } from "../src/parsing/artifact-rules.js";
import { FIXTURE_LITERATURE } from "../src/workbench/synthetic-fixture.js";

const bundle = process.env.SCIRETRIEVER_CLOAK_BUNDLE;

it.skipIf(!bundle)(
  "runs real Browser capture through publication, parsing, loopback Analysis and Library query",
  async () => {
    const home = await mkdtemp(join(tmpdir(), "sciretriever-product-journey-"));
    let calls = 0;
    const model = createServer(async (request, response) => {
      for await (const chunk of request) void chunk;
      calls++;
      const value =
        calls === 1
          ? { outcome: "usable", metadata: FIXTURE_LITERATURE.metadata }
          : {
              markdown:
                "# 研究背景与目标\n\nLoopback journey content.\n\n# 研究方法\n\n未提供\n\n# 数据\n\n未提供\n\n# 结论与局限性\n\n未提供\n\n# 参考文献\n\n未提供\n",
            };
      response.setHeader("Content-Type", "application/json");
      response.end(
        JSON.stringify({
          model: "journey-model",
          choices: [
            {
              finish_reason: "stop",
              message: { content: JSON.stringify(value) },
            },
          ],
          usage: { prompt_tokens: 20, completion_tokens: 30 },
        }),
      );
    });
    await new Promise<void>((done) => model.listen(0, "127.0.0.1", done));
    const address = model.address();
    if (!address || typeof address === "string")
      throw new Error("model unavailable");
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
        home,
        runtime,
        assets: new Map(),
        configurationOwner: owner,
        applicationOptions: {
          parsing: {
            rules: new TypeScriptParserArtifactRules(),
            parser: {
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
            },
          },
        },
      });
      const client = workbench.session.attach();
      workbench.session.takeover(
        client,
        workbench.session.view().control.epoch,
      );
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
      expect(result.outcome).toBe("content_ready");
      const detail = await workbench.application.library.detail(
        FIXTURE_LITERATURE.literature_id,
      );
      expect(detail.literature.status).toBe("CONTENT_READY");
      expect(detail.content?.sections[0]?.markdown).toContain(
        "Loopback journey content",
      );
      expect(calls).toBe(2);
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
