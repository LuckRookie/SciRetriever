import {
  latestBrowserObservationMessage,
  browserModelToolCallId,
} from "./browser-model-fixture.js";
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
  parseArtifactRef,
  parseLiterature,
  parseMetadataObservation,
  type WorkbenchObservation,
} from "@sciretriever/contracts";
import { createApplication } from "../src/bootstrap/application.js";
import { BrowserNetworkProxy } from "../src/network/browser-proxy.js";
import { NetworkBudgetCoordinator } from "../src/network/budget.js";
import { resolveBrowserDestination } from "../src/network/policy.js";
import { verifyInstalledCloakRuntime } from "../src/configuration/cloak-runtime.js";
import {
  FIXTURE_LITERATURE,
  workbenchPdf,
} from "../src/workbench/synthetic-fixture.js";

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

it.runIf(!!process.env.SCIRETRIEVER_CLOAK_BUNDLE)(
  "refills a fourth article while two model workers and an earlier native download retain their ownership",
  async () => {
    const root = await mkdtemp(
      join(tmpdir(), "sciretriever-parallel-production-"),
    );
    const slow = gate();
    const models = gate();
    const ids = ["c", "a", "b", "d"] as const;
    const papers = ids.map((name, index) => ({
      name,
      literature: parseLiterature({
        ...FIXTURE_LITERATURE,
        literature_id: `00000000-0000-0000-0000-00000000900${index}`,
        meta_literature_id: `10000000-0000-0000-0000-00000000900${index}`,
        metadata: {
          ...FIXTURE_LITERATURE.metadata,
          title: `Parallel article ${name}`,
          identifiers: [
            { namespace: "doi", value: `10.1000/parallel-${name}` },
          ],
        },
      }),
      bytes: workbenchPdf(`10.1000/parallel-${name}`, "published"),
    }));
    const requests: { host: string; path: string; at: number }[] = [];
    let slowFinished = false;
    let slowStarted = false;
    const origin = createServer((request, response) => {
      const host = (request.headers.host ?? "").split(":")[0]!;
      requests.push({ host, path: request.url ?? "", at: performance.now() });
      const paper = papers.find(
        (item) => host === `${item.name}-publisher.test`,
      );
      if (!paper) {
        response.writeHead(404);
        response.end();
        return;
      }
      if (request.url === "/article") {
        response.writeHead(200, { "content-type": "text/html" });
        response.end(
          `<title>${paper.literature.metadata.title}</title><main><h1>${paper.literature.metadata.title}</h1><p>Institutional access available.</p><a href="/paper.pdf" download>Download PDF</a></main>`,
        );
      } else if (request.url === "/paper.pdf") {
        response.writeHead(200, {
          "content-type": "application/pdf",
          "content-disposition": "attachment; filename=article.pdf",
          "content-length": paper.bytes.length,
        });
        if (paper.name === "c") {
          slowStarted = true;
          response.write(paper.bytes.slice(0, 100));
          void slow.promise.then(() => {
            slowFinished = true;
            response.end(paper.bytes.slice(100));
          });
        } else response.end(paper.bytes);
      } else {
        response.writeHead(404);
        response.end();
      }
    });
    origin.listen(0, "127.0.0.1");
    await once(origin, "listening");
    const port = (origin.address() as AddressInfo).port;
    const calls: { article: string; at: number; end: number | null }[] = [];
    let activeModels = 0;
    let heldModels = 0;
    let peakModels = 0;
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
      const raw = latestBrowserObservationMessage(wire).content.find(
        (part) => part.type === "text",
      )!.text!;
      const observation = JSON.parse(raw) as WorkbenchObservation;
      const paper = papers.find(
        (item) => item.literature.literature_id === observation.article_id,
      )!;
      const call = {
        article: paper.name,
        at: performance.now(),
        end: null as number | null,
      };
      calls.push(call);
      peakModels = Math.max(peakModels, ++activeModels);
      try {
        // Any page may become readable first. Leave decision workers available
        // until C actually starts its native transfer, then establish overlap.
        if (paper.name !== "c" && slowStarted) {
          heldModels++;
          try {
            await models.promise;
          } finally {
            heldModels--;
          }
        }
        const pdf = observation.elements.find(
          (element) => element.name === "Download PDF",
        );
        const first =
          calls.filter((item) => item.article === paper.name).length === 1;
        // A and B deliberately need another observation; the production clock must
        // enforce the five-second action interval, even for a short explicit wait.
        const action =
          pdf &&
          (paper.name === "c" || slowStarted) &&
          !(paper.name !== "c" && first)
            ? {
                kind: "click-element",
                element_id: pdf.element_id,
                revision: observation.observation_revision,
              }
            : {
                kind: "wait-for-change",
                timeout_ms: 100,
                revision: observation.observation_revision,
              };
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
                      id: browserModelToolCallId(),
                      type: "function",
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
      } finally {
        activeModels--;
      }
    };
    const model = createServer((request, response) => {
      void handleModel(request, response).catch(() => response.destroy());
    });
    model.listen(0, "127.0.0.1");
    await once(model, "listening");
    const modelPort = (model.address() as AddressInfo).port;
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
      const home = join(root, "home");
      await mkdir(join(home, ".sciretriever"), {
        recursive: true,
        mode: 0o700,
      });
      await writeFile(
        join(home, ".sciretriever", "config.toml"),
        `[providers.fixture]\napi = "openai-chat-completions"\nbase_url = "http://127.0.0.1:${modelPort}/v1"\n[models."fixture/browser"]\nimage = true\nstream = false\n[browser]\nenabled = true\nmodel = "fixture/browser"\nprofile = "parallel-fixture"\n[execution]\nmax_concurrency = 3\n[sources.acquisition]\nmode = "custom"\nproviders = []\n`,
        { mode: 0o600 },
      );
      app = await createApplication(home, {
        executionSchema: "upgrade-synthetic",
        browserRuntime: await verifyInstalledCloakRuntime(
          process.env.SCIRETRIEVER_CLOAK_BUNDLE!,
        ),
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
      for (const [index, paper] of papers.entries()) {
        await app.database.putLiterature(paper.literature);
        await app.observations.publish({
          ...parseMetadataObservation({
            observation_id: `00000000-0000-0000-0000-00000000910${index}`,
            provenance: {
              provenance_id: `00000000-0000-0000-0000-00000000920${index}`,
              source_kind: "metadata-provider",
              source_name: "fixture",
              source_record_id: paper.name,
              observed_at: "2026-10-05T00:00:00Z",
              input_sha256: "a".repeat(64),
              parameters_sha256: null,
            },
            metadata: paper.literature.metadata,
            version_role: "published",
            version_links: [],
            asset_hints: [
              {
                url: `http://${paper.name}-publisher.test:${port}/article`,
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
          literature_id: paper.literature.literature_id,
        });
      }
      pending = app.databaseCompletion!.run({
        selector: {
          kind: "literatures",
          literature_ids: papers.map((p) => p.literature.literature_id),
        },
        goal: "ASSET_READY",
      });
      // Surface a rejection immediately while the assertions observe its in-flight work.
      void pending.catch(() => undefined);
      await expect
        .poll(() => heldModels, {
          timeout: 30_000,
        })
        .toBe(2);
      await expect
        .poll(
          () => app!.execution!.transfers.resources.snapshot().native_bytes,
          { timeout: 30_000 },
        )
        .toBeGreaterThan(0);
      expect(activeModels).toBe(2);
      expect(slowFinished).toBe(false);
      models.release();
      await expect
        .poll(
          async () => {
            const results = await Promise.all(
              papers
                .slice(1)
                .map((paper) =>
                  app!.database.currentFacts(paper.literature.literature_id),
                ),
            );
            return results.filter((facts) => Boolean(facts?.primary_asset))
              .length;
          },
          { timeout: 30_000 },
        )
        .toBe(3);
      expect(
        (await app.database.currentFacts(papers[0]!.literature.literature_id))!
          .primary_asset,
      ).toBeNull();
      expect(slowFinished).toBe(false);
      slow.release();
      const report = (await pending) as { completed: readonly unknown[] };
      expect(report.completed).toHaveLength(4);
      expect(peakModels).toBe(2);
      for (const paper of papers) {
        const facts = (await app.database.currentFacts(
          paper.literature.literature_id,
        ))!;
        const asset = facts.primary_asset!;
        expect(asset.sha256).toBe(
          createHash("sha256").update(paper.bytes).digest("hex"),
        );
        const exported = await app.files.withVerified(
          asset.path,
          parseArtifactRef({
            sha256: asset.sha256,
            byte_size: asset.size_bytes,
            media_type: "application/pdf",
          }),
          async (chunks) => {
            const hash = createHash("sha256");
            for await (const chunk of chunks) hash.update(chunk);
            return hash.digest("hex");
          },
        );
        expect(exported).toBe(asset.sha256);
        expect(
          (await app.library.detail(paper.literature.literature_id)).primary_pdf
            ?.article_identity_status,
        ).toBe("unverified");
        if (paper.name !== "c") {
          const turns = calls.filter((item) => item.article === paper.name);
          expect(turns[1]!.at - turns[0]!.end!).toBeGreaterThanOrEqual(5_000);
        }
      }
      await expect
        .poll(
          () => app!.execution!.transfers.resources.snapshot().temporary_bytes,
        )
        .toBe(0);
      const evidence = {
        runtime: "verified-cloak",
        calls,
        peak_model_requests: peakModels,
        requests,
        resources: app.execution!.transfers.resources.snapshot(),
        files: papers.map((p) => ({
          article: p.name,
          sha256: createHash("sha256").update(p.bytes).digest("hex"),
          bytes: p.bytes.length,
        })),
      };
      const evidenceDirectory = await mkdtemp(
        join(tmpdir(), "sciretriever-parallel-browser-evidence-"),
      );
      await writeFile(
        join(evidenceDirectory, "evidence.json"),
        JSON.stringify(evidence, null, 2),
      );
      process.stdout.write(`Parallel Browser evidence: ${evidenceDirectory}\n`);
    } catch (error) {
      const report = await Promise.race([
        pending,
        Promise.resolve("still-running"),
      ]);
      process.stderr.write(
        `Parallel Browser failure: ${JSON.stringify({ calls, requests, report })}\n`,
      );
      throw error;
    } finally {
      models.release();
      slow.release();
      await app?.close();
      await pending?.catch(() => undefined);
      await proxy.close();
      budget.close();
      origin.closeAllConnections();
      model.closeAllConnections();
      await Promise.all([
        new Promise<void>((resolve) => origin.close(() => resolve())),
        new Promise<void>((resolve) => model.close(() => resolve())),
      ]);
      await rm(root, { recursive: true, force: true });
    }
  },
  120_000,
);
