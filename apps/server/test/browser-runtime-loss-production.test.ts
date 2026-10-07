import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import {
  parseArtifactRef,
  parseLiterature,
  parseMetadataObservation,
  type WorkbenchObservation,
} from "@sciretriever/contracts";
import {
  createApplication,
  type Application,
} from "../src/bootstrap/application.js";
import type {
  BrowserArticleCloseOutcome,
  BrowserArticleExecution,
} from "../src/browser/article-session.js";
import { OwnedBrowserCdpConnection } from "../src/browser/cdp.js";
import { verifyInstalledCloakRuntime } from "../src/configuration/cloak-runtime.js";
import { BrowserNetworkProxy } from "../src/network/browser-proxy.js";
import { NetworkBudgetCoordinator } from "../src/network/budget.js";
import { resolveBrowserDestination } from "../src/network/policy.js";
import {
  FIXTURE_LITERATURE,
  workbenchPdf,
} from "../src/workbench/synthetic-fixture.js";

it.runIf(!!process.env.SCIRETRIEVER_CLOAK_BUNDLE)(
  "settles production Completion on shared Browser loss during model HTTP and WaitForChange while preserving a published PDF",
  async () => {
    const home = await mkdtemp(
      join(tmpdir(), "sciretriever-runtime-loss-production-"),
    );
    const evidenceDirectory = await mkdtemp(
      join(tmpdir(), "sciretriever-runtime-loss-evidence-"),
    );
    const controller = new AbortController();
    let releaseModel!: () => void;
    const modelGate = new Promise<void>((resolve) => {
      releaseModel = resolve;
    });
    const papers = (["published", "model", "waiting"] as const).map(
      (name, index) => ({
        name,
        literature: parseLiterature({
          ...FIXTURE_LITERATURE,
          literature_id: `00000000-0000-0000-0000-00000000960${index}`,
          meta_literature_id: `10000000-0000-0000-0000-00000000960${index}`,
          metadata: {
            ...FIXTURE_LITERATURE.metadata,
            title: `Runtime loss article ${name}`,
            identifiers: [
              { namespace: "doi", value: `10.1000/runtime-loss-${name}` },
            ],
          },
        }),
        bytes: workbenchPdf(`10.1000/runtime-loss-${name}`, "published"),
      }),
    );
    const requests: { article: string; path: string; at_ms: number }[] = [];
    const origin = createServer((request, response) => {
      const host = (request.headers.host ?? "").split(":")[0]!;
      const paper = papers.find(
        (item) => host === `${item.name}-publisher.test`,
      );
      requests.push({
        article: paper?.name ?? "unknown",
        path: request.url ?? "",
        at_ms: performance.now(),
      });
      if (paper && request.url === "/article") {
        response.writeHead(200, { "content-type": "text/html" });
        response.end(
          `<title>${paper.literature.metadata.title}</title><main><h1>${paper.literature.metadata.title}</h1><a href="/paper.pdf" download>Download PDF</a></main>`,
        );
      } else if (paper && request.url === "/paper.pdf") {
        response.writeHead(200, {
          "content-type": "application/pdf",
          "content-disposition": "attachment; filename=article.pdf",
        });
        response.end(paper.bytes);
      } else {
        response.writeHead(404);
        response.end();
      }
    });
    origin.listen(0, "127.0.0.1");
    await once(origin, "listening");
    const port = (origin.address() as AddressInfo).port;
    const calls: {
      article: string;
      at_ms: number;
      end_ms: number | null;
      closed_ms: number | null;
    }[] = [];
    const fixtureFailures: string[] = [];
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
      const paper = papers.find(
        (item) => item.literature.literature_id === observation.article_id,
      )!;
      const call = {
        article: paper.name,
        at_ms: performance.now(),
        end_ms: null as number | null,
        closed_ms: null as number | null,
      };
      calls.push(call);
      response.once("close", () => {
        call.closed_ms = performance.now();
      });
      if (paper.name === "model") await modelGate;
      if (response.destroyed) return;
      const pdf = observation.elements.find(
        (element) => element.name === "Download PDF",
      )!;
      const action =
        paper.name === "published"
          ? {
              kind: "click-element",
              element_id: pdf.element_id,
              revision: observation.observation_revision,
            }
          : {
              kind: "wait-for-change",
              timeout_ms: 120_000,
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
      call.end_ms = performance.now();
    };
    const model = createServer((request, response) => {
      void handleModel(request, response).catch((error: unknown) => {
        fixtureFailures.push(error instanceof Error ? error.name : "unknown");
        response.destroy();
      });
    });
    model.listen(0, "127.0.0.1");
    await once(model, "listening");
    const modelPort = (model.address() as AddressInfo).port;
    const resolver = () => ["127.0.0.1"];
    const policy = {
      allowed_schemes: ["http"] as const,
      allowed_classes: ["loopback"] as const,
      allowed_addresses: ["127.0.0.1"],
      allowed_ports: [{ scheme: "http" as const, port }],
    };
    const budget = new NetworkBudgetCoordinator();
    const proxy = new BrowserNetworkProxy({
      resolver,
      policy,
      coordinator: budget,
      limits: {
        maxConcurrency: 8,
        maxHostConcurrency: 8,
        maxResponseBytes: 1024 * 1024,
        maxRedirects: 0,
        maxRetries: 0,
      },
    });
    const runtime = await verifyInstalledCloakRuntime(
      process.env.SCIRETRIEVER_CLOAK_BUNDLE!,
    );
    const executions = new Map<string, BrowserArticleExecution>();
    const waitFailures: {
      article_id: string;
      at_ms: number;
      name: string;
      code: string | null;
      frames: string[];
    }[] = [];
    const removed: {
      session_id: string;
      outcome: BrowserArticleCloseOutcome;
      at_ms: number;
    }[] = [];
    let app: Application | undefined;
    let pending:
      | ReturnType<NonNullable<Application["databaseCompletion"]>["run"]>
      | undefined;
    let report: Awaited<NonNullable<typeof pending>> | undefined;
    let protocol: OwnedBrowserCdpConnection | undefined;
    let runtimeLostAt: number | undefined;
    let browserCloseAcknowledged = false;
    let reportAt: number | undefined;
    let passed = false;
    try {
      await mkdir(join(home, ".sciretriever"), { mode: 0o700 });
      await writeFile(
        join(home, ".sciretriever", "config.toml"),
        `[providers.fixture]\napi = "openai-chat-completions"\nbase_url = "http://127.0.0.1:${modelPort}/v1"\n[models."fixture/browser"]\nimage = true\nstream = false\n[browser]\nenabled = true\nmodel = "fixture/browser"\nprofile = "runtime-loss-fixture"\n[sources.acquisition]\nmode = "custom"\nproviders = []\n`,
        { mode: 0o600 },
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
        browserCollaboration: {
          registered: (execution) => {
            executions.set(execution.identity.literature_id, execution);
          },
          removed: (sessionId, outcome) => {
            removed.push({
              session_id: sessionId,
              outcome,
              at_ms: performance.now(),
            });
          },
          open: async (request, page) => {
            const apply = page.apply.bind(page);
            vi.spyOn(page, "apply").mockImplementation(async (...args) => {
              try {
                return await apply(...args);
              } catch (error) {
                if (args[0].kind === "wait-for-change")
                  waitFailures.push({
                    article_id: request.literature_id,
                    at_ms: performance.now(),
                    name: error instanceof Error ? error.name : "unknown",
                    code:
                      error instanceof Error &&
                      "code" in error &&
                      typeof error.code === "string" &&
                      /^[a-z-]{1,64}$/u.test(error.code)
                        ? error.code
                        : null,
                    frames:
                      error instanceof Error
                        ? (error.stack ?? "")
                            .split("\n")
                            .slice(1)
                            .filter((frame) => frame.includes("/apps/server/"))
                        : [],
                  });
                throw error;
              }
            });
            return {
              step: async () => {
                throw new Error(
                  "production must use its normal decision runtime",
                );
              },
              automatic: {
                canDecide: () => true,
                controlEpoch: () => 0,
                guidance: () => [],
              },
              close: async () => undefined,
            };
          },
          captured: () => undefined,
        },
      });
      for (const [index, paper] of papers.entries()) {
        await app.database.putLiterature(paper.literature);
        await app.observations.publish({
          ...parseMetadataObservation({
            observation_id: `00000000-0000-0000-0000-00000000970${index}`,
            provenance: {
              provenance_id: `00000000-0000-0000-0000-00000000980${index}`,
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
      pending = app.databaseCompletion!.run(
        {
          selector: {
            kind: "literatures",
            literature_ids: papers.map(
              (paper) => paper.literature.literature_id,
            ),
          },
          goal: "ASSET_READY",
        },
        { signal: controller.signal },
      );
      void pending
        .then((value) => {
          report = value;
          reportAt = performance.now();
        })
        .catch(() => undefined);
      await expect
        .poll(
          async () =>
            Boolean(
              (
                await app!.database.currentFacts(
                  papers[0]!.literature.literature_id,
                )
              )?.primary_asset,
            ),
          { timeout: 30_000 },
        )
        .toBe(true);
      await expect
        .poll(
          () => executions.get(papers[2]!.literature.literature_id)?.phase(),
          { timeout: 30_000 },
        )
        .toBe("waiting");
      await expect
        .poll(() => calls.find((call) => call.article === "model")?.end_ms, {
          timeout: 30_000,
        })
        .toBeNull();
      expect(executions.get(papers[1]!.literature.literature_id)?.phase()).toBe(
        "deciding",
      );
      expect(report).toBeUndefined();
      const publishedBefore = (await app.database.currentFacts(
        papers[0]!.literature.literature_id,
      ))!.primary_asset!;
      protocol = await OwnedBrowserCdpConnection.connect(join(home, "profile"));
      runtimeLostAt = performance.now();
      await protocol.send("Browser.close");
      browserCloseAcknowledged = true;
      await expect.poll(() => report, { timeout: 30_000 }).toBeDefined();
      expect(report!.completed).toHaveLength(1);
      expect(report!.failed).toHaveLength(2);
      expect(
        report!.failed.find(
          (target) =>
            target.literature_id === papers[1]!.literature.literature_id,
        )?.failure.code,
      ).toBe("pdf-browser-runtime-lost");
      // Page RPCs and the shared disconnect use separate protocol channels. A
      // page can report its own closure first; preserve that proven first cause.
      expect(["pdf-browser-runtime-lost", "pdf-browser-page-closed"]).toContain(
        report!.failed.find(
          (target) =>
            target.literature_id === papers[2]!.literature.literature_id,
        )?.failure.code,
      );
      expect(controller.signal.aborted).toBe(false);
      expect(calls.filter((call) => call.at_ms > runtimeLostAt!)).toEqual([]);
      expect(report!.interrupted).toEqual([]);
      expect(report!.skipped).toEqual([]);
      expect(
        (await app.database.currentFacts(papers[0]!.literature.literature_id))!
          .primary_asset,
      ).toEqual(publishedBefore);
      const publishedHash = await app.files.withVerified(
        publishedBefore.path,
        parseArtifactRef({
          sha256: publishedBefore.sha256,
          byte_size: publishedBefore.size_bytes,
          media_type: "application/pdf",
        }),
        async (chunks) => {
          const hash = createHash("sha256");
          for await (const chunk of chunks) hash.update(chunk);
          return hash.digest("hex");
        },
      );
      expect(publishedHash).toBe(
        createHash("sha256").update(papers[0]!.bytes).digest("hex"),
      );
      await expect
        .poll(() => calls.find((call) => call.article === "model")?.closed_ms, {
          timeout: 5000,
        })
        .not.toBeNull();
      expect(executions.size).toBe(3);
      expect(
        [...executions.values()].map((execution) => execution.phase()),
      ).toEqual(["closed", "closed", "closed"]);
      expect(removed).toHaveLength(3);
      expect(
        removed.find(
          (event) =>
            event.session_id ===
            executions.get(papers[1]!.literature.literature_id)!.session_id,
        )?.outcome,
      ).toEqual({ kind: "retained", code: "browser-runtime-lost" });
      const waitingOutcome = removed.find(
        (event) =>
          event.session_id ===
          executions.get(papers[2]!.literature.literature_id)!.session_id,
      )?.outcome;
      expect(waitingOutcome?.kind).toBe("retained");
      expect(["browser-runtime-lost", "browser-page-closed"]).toContain(
        waitingOutcome?.kind === "retained" ? waitingOutcome.code : undefined,
      );
      expect(
        app.execution!.transfers.resources.snapshot().temporary_bytes,
      ).toBe(0);
      for (const paper of papers.slice(1)) {
        expect(
          (await app.database.currentFacts(paper.literature.literature_id))!
            .primary_asset,
        ).toBeNull();
        expect(
          await app.database.hasAutomaticPdfExhaustion(
            paper.literature.literature_id,
          ),
        ).toBe(false);
        expect(
          await app.database.listCandidates(paper.literature.literature_id),
        ).toEqual([]);
      }
      expect(fixtureFailures).toEqual([]);
      passed = true;
    } finally {
      controller.abort();
      releaseModel();
      protocol?.close();
      await app?.close();
      await pending?.catch(() => undefined);
      vi.restoreAllMocks();
      await proxy.close();
      budget.close();
      origin.closeAllConnections();
      model.closeAllConnections();
      await Promise.all([
        new Promise<void>((resolve) => origin.close(() => resolve())),
        new Promise<void>((resolve) => model.close(() => resolve())),
      ]);
      await writeFile(
        join(evidenceDirectory, "evidence.json"),
        JSON.stringify(
          {
            passed,
            cloak_version: runtime.version,
            browser_close_requested_at_ms: runtimeLostAt,
            browser_close_acknowledged: browserCloseAcknowledged,
            shared_runtime_loss_observed: removed.some(
              (event) =>
                event.outcome.kind === "retained" &&
                event.outcome.code === "browser-runtime-lost",
            ),
            report_at_ms: reportAt,
            settle_after_browser_close_request_ms:
              runtimeLostAt !== undefined && reportAt !== undefined
                ? reportAt - runtimeLostAt
                : null,
            report,
            calls,
            requests,
            removed,
            final_phases: [...executions.values()].map((execution) => ({
              article_id: execution.identity.literature_id,
              phase: execution.phase(),
            })),
            resources: app?.execution?.transfers.resources.snapshot(),
            fixture_failures: fixtureFailures,
            wait_failures: waitFailures,
          },
          null,
          2,
        ),
      );
      process.stdout.write(
        `Runtime loss production evidence: ${evidenceDirectory}\n`,
      );
      await rm(home, { recursive: true, force: true });
    }
  },
  120_000,
);
