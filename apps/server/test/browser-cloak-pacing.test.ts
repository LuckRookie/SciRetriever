import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  parseLiterature,
  parseMetadataObservation,
  type WorkbenchObservation,
} from "@sciretriever/contracts";
import { createApplication } from "../src/bootstrap/application.js";
import { verifyInstalledCloakRuntime } from "../src/configuration/cloak-runtime.js";
import { NetworkBudgetCoordinator } from "../src/network/budget.js";
import { BrowserNetworkProxy } from "../src/network/browser-proxy.js";
import { resolveBrowserDestination } from "../src/network/policy.js";
import {
  FIXTURE_LITERATURE,
  workbenchPdf,
} from "../src/workbench/synthetic-fixture.js";

it.runIf(!!process.env.SCIRETRIEVER_CLOAK_BUNDLE)(
  "observes a PDF link appearing after 5.1 seconds on verified Cloak and dispatches without adding another pacing interval",
  async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "sciretriever-cloak-pacing-"),
    );
    const literature = parseLiterature({
      ...FIXTURE_LITERATURE,
      metadata: {
        ...FIXTURE_LITERATURE.metadata,
        title: "Delayed PDF article",
        identifiers: [{ namespace: "doi", value: "10.1000/delayed-pdf" }],
      },
    });
    const bytes = workbenchPdf("10.1000/delayed-pdf", "published");
    const events: { event: string; at: number }[] = [];
    const calls: { at: number; end: number; elements: readonly string[] }[] =
      [];
    const failures: unknown[] = [];
    const handleModel = async (
      request: IncomingMessage,
      response: ServerResponse,
    ) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request)
        chunks.push(Buffer.from(chunk as Uint8Array));
      const wire = JSON.parse(Buffer.concat(chunks).toString()) as {
        messages: { content: { type: string; text?: string }[] }[];
      };
      const observation = JSON.parse(
        wire.messages[1]!.content.find((part) => part.type === "text")!.text!,
      ) as WorkbenchObservation;
      const call = {
        at: performance.now(),
        end: 0,
        elements: observation.elements.map((element) => element.name),
      };
      calls.push(call);
      const name = calls.length === 1 ? "Open PDF options" : "Download PDF";
      const element = observation.elements.find((item) => item.name === name);
      const action = element
        ? {
            kind: "click-element",
            element_id: element.element_id,
            revision: observation.observation_revision,
          }
        : { kind: "stop", reason: "budget" };
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          model: "browser",
          choices: [
            {
              finish_reason: "tool_calls",
              message: {
                tool_calls: [
                  {
                    function: {
                      name: "browser_action",
                      arguments: JSON.stringify({ action }),
                    },
                  },
                ],
              },
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
      );
      call.end = performance.now();
    };
    const server = createServer((request, response) => {
      if (request.url === "/v1/chat/completions") {
        void handleModel(request, response).catch((error: unknown) => {
          failures.push(error);
          response.destroy();
        });
      } else if (request.url === "/article") {
        response.writeHead(200, { "content-type": "text/html" });
        response.end(`<title>Delayed PDF article</title><main><h1>Delayed PDF article</h1><p>Institutional access available.</p><button id="prepare">Open PDF options</button></main><script>
          let prepared = false;
          document.getElementById('prepare').onclick = () => {
            if (prepared) return;
            prepared = true;
            fetch('/action-finished');
            setTimeout(() => {
              const link = document.createElement('a');
              link.href = '/paper.pdf';
              link.download = 'article.pdf';
              link.textContent = 'Download PDF';
              document.querySelector('main').append(link);
              fetch('/button-visible');
            }, 5100);
          };
        </script>`);
      } else if (
        request.url === "/action-finished" ||
        request.url === "/button-visible"
      ) {
        events.push({ event: request.url.slice(1), at: performance.now() });
        response.writeHead(204);
        response.end();
      } else if (request.url === "/paper.pdf") {
        events.push({ event: "pdf-request", at: performance.now() });
        response.writeHead(200, {
          "content-type": "application/pdf",
          "content-disposition": "attachment; filename=article.pdf",
          "content-length": bytes.length,
        });
        response.end(bytes);
      } else {
        response.writeHead(404);
        response.end();
      }
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;
    const policy = {
      allowed_schemes: ["http"] as const,
      allowed_classes: ["loopback"] as const,
      allowed_addresses: ["127.0.0.1"],
      allowed_ports: [{ scheme: "http" as const, port }],
    };
    const resolver = () => ["127.0.0.1"];
    const budget = new NetworkBudgetCoordinator();
    const proxy = new BrowserNetworkProxy({
      resolver,
      policy,
      coordinator: budget,
      limits: {
        maxConcurrency: 8,
        maxHostConcurrency: 8,
        maxResponseBytes: Number.MAX_SAFE_INTEGER,
        maxRedirects: 0,
        maxRetries: 0,
      },
    });
    let app: Awaited<ReturnType<typeof createApplication>> | undefined;
    let pending: Promise<unknown> | undefined;
    try {
      const home = join(directory, "home");
      await mkdir(join(home, ".sciretriever"), {
        recursive: true,
        mode: 0o700,
      });
      await writeFile(
        join(home, ".sciretriever", "config.toml"),
        `[providers.fixture]\napi = "openai-chat-completions"\nbase_url = "http://127.0.0.1:${port}/v1"\n[models."fixture/browser"]\nimage = true\nstream = false\n[browser]\nenabled = true\nmodel = "fixture/browser"\nprofile = "delayed-pdf-fixture"\n[sources.acquisition]\nmode = "custom"\nproviders = []\n`,
        { mode: 0o600 },
      );
      const runtime = await verifyInstalledCloakRuntime(
        process.env.SCIRETRIEVER_CLOAK_BUNDLE!,
      );
      app = await createApplication(home, {
        executionSchema: "upgrade-synthetic",
        browserRuntime: runtime,
        browserProxy: await proxy.start(),
        browserAdmitNavigation: async (url) =>
          (await resolveBrowserDestination(url, resolver, policy)).url.url,
        acquisitionAssembly: {
          doiLandingSource: {
            source_name: "doi-landing",
            ready: true,
            discover: async () => [],
          },
        },
      });
      await app.database.putLiterature(literature);
      await app.observations.publish({
        ...parseMetadataObservation({
          observation_id: "00000000-0000-0000-0000-000000007101",
          provenance: {
            provenance_id: "00000000-0000-0000-0000-000000007102",
            source_kind: "metadata-provider",
            source_name: "fixture",
            source_record_id: "delayed-pdf",
            observed_at: "2026-10-05T00:00:00Z",
            input_sha256: "a".repeat(64),
            parameters_sha256: null,
          },
          metadata: literature.metadata,
          version_role: "published",
          version_links: [],
          asset_hints: [
            {
              url: `http://pacing-publisher.test:${port}/article`,
              kind: "landing-page",
              media_type: null,
              asset_role: null,
              version_role: "published",
              access_status: "open",
              license: null,
            },
          ],
          reference_texts: [],
          declared_keywords: [],
          reference_count: 0,
          cited_by_count: 0,
        }),
        literature_id: literature.literature_id,
      });
      pending = app.databaseCompletion!.run({
        selector: {
          kind: "literatures",
          literature_ids: [literature.literature_id],
        },
        goal: "ASSET_READY",
      });
      const report = (await pending) as { completed: readonly unknown[] };
      expect(report.completed).toHaveLength(1);
      expect(failures).toEqual([]);
      expect(calls).toHaveLength(2);
      expect(calls[0]!.elements).not.toContain("Download PDF");
      expect(calls[1]!.elements).toContain("Download PDF");
      const actionAt = events.find(
        (event) => event.event === "action-finished",
      )!.at;
      const visibleAt = events.find(
        (event) => event.event === "button-visible",
      )!.at;
      expect(visibleAt - actionAt).toBeGreaterThanOrEqual(5_000);
      expect(calls[1]!.at - calls[0]!.end).toBeGreaterThanOrEqual(5_000);
      expect(calls[1]!.at).toBeGreaterThanOrEqual(visibleAt);
      expect(calls[1]!.at - visibleAt).toBeLessThan(2_000);
      const asset = (await app.database.currentFacts(literature.literature_id))!
        .primary_asset!;
      expect(asset.sha256).toBe(
        createHash("sha256").update(bytes).digest("hex"),
      );
      expect(
        (await app.library.detail(literature.literature_id)).primary_pdf
          ?.article_identity_status,
      ).toBe("unverified");
      const evidence = await mkdtemp(
        join(tmpdir(), "sciretriever-cloak-pacing-evidence-"),
      );
      await writeFile(
        join(evidence, "evidence.json"),
        JSON.stringify(
          {
            runtime: runtime.version,
            calls,
            events,
            sha256: asset.sha256,
            size_bytes: asset.size_bytes,
          },
          null,
          2,
        ),
      );
      process.stdout.write(`Cloak pacing evidence: ${evidence}\n`);
    } finally {
      await app?.close();
      await pending?.catch(() => undefined);
      await proxy.close();
      budget.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  },
  90_000,
);
