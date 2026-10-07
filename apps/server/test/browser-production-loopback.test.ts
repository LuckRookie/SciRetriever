import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  parseMetadataObservation,
  parseLiteratureId,
} from "@sciretriever/contracts";
import { createApplication } from "../src/bootstrap/application.js";
import { BrowserNetworkProxy } from "../src/network/browser-proxy.js";
import { createBrowserNetworkAdmission } from "../src/network/browser-admission.js";
import { NetworkBudgetCoordinator } from "../src/network/budget.js";
import { resolveBrowserDestination } from "../src/network/policy.js";
import { verifyInstalledCloakRuntime } from "../src/configuration/cloak-runtime.js";
import {
  FIXTURE_LITERATURE,
  startWorkbenchFixture,
  workbenchPdf,
} from "../src/workbench/synthetic-fixture.js";

async function startCrossOriginFixture() {
  const requests: string[] = [];
  let port = 0;
  const server = createServer((request, response) => {
    requests.push(`${request.headers.host}${request.url}`);
    const cdn = `http://cdn.fixture.test:${port}`;
    if (request.headers.host === `cdn.fixture.test:${port}`) {
      if (request.url === "/article.css") {
        response.writeHead(200, { "Content-Type": "text/css" });
        response.end(
          "#article { display: block !important; font: 20px sans-serif; }",
        );
      } else if (request.url === "/article.js") {
        response.writeHead(200, { "Content-Type": "text/javascript" });
        response.end(
          `const link=document.createElement('a');link.href='${cdn}/paper%2Fmain.pdf?token=synthetic%2Fcap&key=synthetic';link.textContent='CDN PDF';document.getElementById('article').append(link);`,
        );
      } else if (
        request.url === "/paper%2Fmain.pdf?token=synthetic%2Fcap&key=synthetic"
      ) {
        response.writeHead(200, { "Content-Type": "application/pdf" });
        response.end(workbenchPdf("", "", false));
      } else {
        response.writeHead(404);
        response.end();
      }
      return;
    }
    response.writeHead(200, { "Content-Type": "text/html" });
    response.end(
      `<title>Institutional article fixture</title><link rel="stylesheet" href="${cdn}/article.css"><main id="article" style="display:none">Access through the current institutional network. </main><script src="${cdn}/article.js"></script>`,
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture");
  port = address.port;
  return {
    origin: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

it("refuses loopback in the default production Browser Network policy", async () => {
  const budget = new NetworkBudgetCoordinator();
  const network = createBrowserNetworkAdmission({ budget });
  try {
    await expect(
      network.admitNavigation("http://127.0.0.1:12345/article"),
    ).rejects.toBeDefined();
    await expect(
      network.admitNavigation("https://127.0.0.1/article"),
    ).rejects.toBeDefined();
  } finally {
    await network.proxy.close();
    budget.close();
  }
});

describe.runIf(!!process.env.SCIRETRIEVER_CLOAK_BUNDLE)(
  "formal Browser acquisition on verified Cloak loopback",
  () => {
    it.each(["Download PDF", "View PDF", "CDN PDF"])(
      "commits a primary PDF through %s, formal Completion and real host capture",
      async (linkName) => {
        const runtime = await verifyInstalledCloakRuntime(
          process.env.SCIRETRIEVER_CLOAK_BUNDLE!,
        );
        const home = await mkdtemp(
          join(tmpdir(), "sciretriever-browser-production-"),
        );
        const configHome = join(home, ".sciretriever");
        await mkdir(configHome, { mode: 0o700 });
        await writeFile(
          join(configHome, "config.toml"),
          '[providers.fixture]\napi = "openai-chat-completions"\nbase_url = "http://127.0.0.1:9/v1"\n[models."fixture/browser-model"]\nimage = true\nstream = false\n[browser]\nenabled = true\nmodel = "fixture/browser-model"\nprofile = "synthetic"\n[sources.acquisition]\nmode = "custom"\nproviders = []\n',
          { mode: 0o600 },
        );
        const fixture =
          linkName === "CDN PDF"
            ? await startCrossOriginFixture()
            : await startWorkbenchFixture();
        const port = Number(new URL(fixture.origin).port);
        const resolver = () => ["127.0.0.1"];
        const policy = {
          allowed_schemes: ["http"] as const,
          allowed_classes: ["loopback"] as const,
          allowed_addresses: ["127.0.0.1"],
          allowed_ports: [{ scheme: "http" as const, port }],
        };
        const proxy = new BrowserNetworkProxy({
          resolver,
          policy,
          coordinator: new NetworkBudgetCoordinator(),
          limits: {
            maxConcurrency: 4,
            maxHostConcurrency: 4,
            maxResponseBytes: 16 * 1024 * 1024,
            maxRedirects: 0,
            maxRetries: 0,
          },
        });
        let application:
          | Awaited<ReturnType<typeof createApplication>>
          | undefined;
        try {
          const connection = await proxy.start();
          application = await createApplication(home, {
            executionSchema: "upgrade-synthetic",
            browserRuntime: runtime,
            browserProxy: connection,
            browserAdmitNavigation: async (url) =>
              (await resolveBrowserDestination(url, resolver, policy)).url.url,
            acquisitionAssembly: {
              doiLandingSource: {
                source_name: "doi-landing",
                ready: true,
                discover: async () => [],
              },
            },
            agentTransportFactory:
              () =>
              async ({ body, onDispatched }) => {
                onDispatched?.();
                const wire = JSON.parse(new TextDecoder().decode(body)) as {
                  messages: Array<{
                    content: Array<{ type: string; text?: string }>;
                  }>;
                };
                const text = wire.messages[1]?.content.find(
                  (part) => part.type === "text",
                )?.text;
                if (!text) throw new Error("observation unavailable");
                const observation = JSON.parse(text) as {
                  observation_revision: number;
                  elements: Array<{ element_id: string; name: string }>;
                };
                const download = observation.elements.find(
                  (element) => element.name === linkName,
                );
                const action = download
                  ? {
                      kind: "click-element",
                      element_id: download.element_id,
                      revision: observation.observation_revision,
                    }
                  : { kind: "stop", reason: "budget" };
                return {
                  status: 200,
                  headers: [],
                  body: new TextEncoder().encode(
                    JSON.stringify({
                      model: "browser-model",
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
                  ),
                };
              },
          });
          expect(application.agents.readiness("browser").configured).toBe(true);
          await application.database.putLiterature(FIXTURE_LITERATURE);
          await application.observations.publish({
            ...parseMetadataObservation({
              observation_id: "00000000-0000-0000-0000-000000000101",
              provenance: {
                provenance_id: "00000000-0000-0000-0000-000000000102",
                source_kind: "metadata-provider",
                source_name: "fixture",
                source_record_id: "fixture-article",
                observed_at: "2026-09-10T00:00:00Z",
                input_sha256: "a".repeat(64),
                parameters_sha256: null,
              },
              metadata: FIXTURE_LITERATURE.metadata,
              version_role: "published",
              version_links: [],
              asset_hints: [
                {
                  url: `${fixture.origin}/article`,
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
            literature_id: FIXTURE_LITERATURE.literature_id,
          });
          expect(application.databaseCompletion).not.toBeNull();
          const report = await application.databaseCompletion!.run({
            selector: {
              kind: "literatures",
              literature_ids: [
                parseLiteratureId(FIXTURE_LITERATURE.literature_id),
              ],
            },
            goal: "ASSET_READY",
          });
          expect(report.completed, JSON.stringify(report)).toMatchObject([
            { literature_id: FIXTURE_LITERATURE.literature_id },
          ]);
          expect(
            (await application.library.detail(FIXTURE_LITERATURE.literature_id))
              .primary_pdf?.article_identity_status,
          ).toBe("unverified");
          expect(
            await application.database.hasAutomaticPdfExhaustion(
              FIXTURE_LITERATURE.literature_id,
            ),
          ).toBe(false);
          if ("requests" in fixture) {
            expect(fixture.requests).toEqual(
              expect.arrayContaining([
                `127.0.0.1:${port}/article`,
                `cdn.fixture.test:${port}/article.css`,
                `cdn.fixture.test:${port}/article.js`,
                `cdn.fixture.test:${port}/paper%2Fmain.pdf?token=synthetic%2Fcap&key=synthetic`,
              ]),
            );
          }
        } finally {
          await application?.close();
          await proxy.close();
          await fixture.close();
          await rm(home, { recursive: true, force: true });
        }
      },
      90_000,
    );
  },
);
