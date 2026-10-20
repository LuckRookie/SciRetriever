import {
  latestBrowserObservationMessage,
  browserModelToolCallId,
} from "./browser-model-fixture.js";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createReadStream } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import {
  parseLiterature,
  parseMetadataObservation,
  type WorkbenchObservation,
} from "@sciretriever/contracts";
import { CandidatePublisher } from "../src/acquisition/candidate-publication.js";
import {
  createApplication,
  type Application,
} from "../src/bootstrap/application.js";
import { BrowserHost, type BrowserPageHandle } from "../src/browser/host.js";
import { verifyInstalledCloakRuntime } from "../src/configuration/cloak-runtime.js";
import { exportArtifact } from "../src/entry/artifact-export.js";
import { BrowserArticleScheduler } from "../src/entry/browser-scheduler.js";
import { NetworkBudgetCoordinator } from "../src/network/budget.js";
import { BrowserNetworkProxy } from "../src/network/browser-proxy.js";
import { resolveBrowserDestination } from "../src/network/policy.js";
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

it
  .runIf(Boolean(process.env.SCIRETRIEVER_CLOAK_BUNDLE))
  .each(["popup-ownership", "explicit-serial"] as const)(
  "preserves %s through the production App, real model HTTP, publication and export",
  async (scenario) => {
    const home = await mkdtemp(
      join(tmpdir(), "sciretriever-final-browser-production-"),
    );
    const evidenceDirectory = await mkdtemp(
      join(tmpdir(), "sciretriever-final-browser-evidence-"),
    );
    const models = gate();
    const downloadA = gate();
    const downloadB = gate();
    const publicationReturn = gate();
    const popup = scenario === "popup-ownership";
    const papers = (["a", "b"] as const).map((name, index) => ({
      name,
      literature: parseLiterature({
        ...FIXTURE_LITERATURE,
        literature_id: `00000000-0000-0000-0000-00000000990${index}`,
        meta_literature_id: `10000000-0000-0000-0000-00000000990${index}`,
        metadata: {
          ...FIXTURE_LITERATURE.metadata,
          title: `Final ${scenario} article ${name}`,
          identifiers: [
            { namespace: "doi", value: `10.1000/final-${scenario}-${name}` },
          ],
        },
      }),
      bytes: workbenchPdf(`10.1000/final-${scenario}-${name}`, "published"),
    }));
    const requests: {
      article: string;
      host: string;
      path: string;
      at_ms: number;
    }[] = [];
    const calls: { article: string; at_ms: number; ended_ms: number | null }[] =
      [];
    const fixtureFailures: string[] = [];
    const times: Record<string, number> = {};
    let activeModels = 0;
    let peakModels = 0;
    let port = 0;
    let passed = false;
    let report:
      | Awaited<
          ReturnType<NonNullable<Application["databaseCompletion"]>["run"]>
        >
      | undefined;
    const files: {
      article: string;
      sha256: string;
      export_sha256: string;
      size_bytes: number;
      candidate_article_id: string;
      candidate_page_id: string;
    }[] = [];
    const origin = createServer((request, response) => {
      const host = (request.headers.host ?? "").split(":")[0]!;
      const source =
        host === "127.0.0.1" && request.headers.referer
          ? new URL(request.headers.referer).hostname
          : host;
      const name = /^([ab])-final\.test$/u.exec(source)?.[1];
      const paper = papers.find((item) => item.name === name);
      requests.push({
        article: name ?? "other",
        host,
        path: request.url ?? "",
        at_ms: performance.now(),
      });
      if (!paper) {
        response.writeHead(404);
        response.end();
      } else if (request.url === "/article") {
        const link = popup
          ? `href="http://127.0.0.1:${port}/same.pdf" target="_blank"`
          : 'href="/paper.pdf" download';
        response.writeHead(200, { "content-type": "text/html" });
        response.end(
          `<title>${paper.literature.metadata.title}</title><main><h1>${paper.literature.metadata.title}</h1><a ${link}>Download PDF</a></main>`,
        );
      } else if (request.url === (popup ? "/same.pdf" : "/paper.pdf")) {
        times[`download_${paper.name}_started_ms`] = performance.now();
        response.writeHead(200, {
          "content-type": "application/pdf",
          "content-disposition": "attachment; filename=final.pdf",
          "content-length": paper.bytes.length,
        });
        response.write(paper.bytes.slice(0, 100));
        const completion = paper.name === "a" ? downloadA : downloadB;
        void completion.promise.then(() => {
          if (response.destroyed) return;
          times[`download_${paper.name}_eof_ms`] = performance.now();
          response.end(paper.bytes.slice(100));
        });
      } else {
        response.writeHead(404);
        response.end();
      }
    });
    origin.listen(0, "127.0.0.1");
    await once(origin, "listening");
    port = (origin.address() as AddressInfo).port;
    const model = createServer((request, response) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of request)
          chunks.push(Buffer.from(chunk as Uint8Array));
        const wire = JSON.parse(Buffer.concat(chunks).toString()) as {
          messages: { content: { type: string; text?: string }[] }[];
        };
        const observation = JSON.parse(
          latestBrowserObservationMessage(wire).content.find(
            (part) => part.type === "text",
          )!.text!,
        ) as Pick<
          WorkbenchObservation,
          "article_id" | "observation_revision" | "elements"
        >;
        const paper = papers.find(
          (item) => item.literature.literature_id === observation.article_id,
        )!;
        const call = {
          article: paper.name,
          at_ms: performance.now(),
          ended_ms: null as number | null,
        };
        calls.push(call);
        peakModels = Math.max(peakModels, ++activeModels);
        try {
          if (popup) await models.promise;
          const element = observation.elements.find(
            (item) => item.name === "Download PDF",
          )!;
          if (response.destroyed) return;
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
                          arguments: JSON.stringify({
                            action: {
                              kind: "click-element",
                              element_id: element.element_id,
                              revision: observation.observation_revision,
                            },
                          }),
                        },
                      },
                    ],
                  },
                },
              ],
              usage: { prompt_tokens: 1, completion_tokens: 1 },
            }),
          );
          call.ended_ms = performance.now();
        } finally {
          activeModels--;
        }
      })().catch((error: unknown) => {
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
        maxResponseBytes: Number.MAX_SAFE_INTEGER,
        maxRedirects: 0,
        maxRetries: 0,
      },
    });
    const cohort = new AbortController();
    const schedulers = new Set<BrowserArticleScheduler>();
    const pages = new Map<
      string,
      { host: BrowserHost; page: BrowserPageHandle }
    >();
    const openPage = BrowserHost.prototype.openPage;
    vi.spyOn(BrowserHost.prototype, "openPage").mockImplementation(
      async function (this: BrowserHost, ...args) {
        const page = await openPage.apply(this, args);
        if (args[1]) pages.set(args[1].literature_id, { host: this, page });
        return page;
      },
    );
    const deliver = BrowserArticleScheduler.prototype.deliver;
    vi.spyOn(BrowserArticleScheduler.prototype, "deliver").mockImplementation(
      async function (this: BrowserArticleScheduler, ...args) {
        schedulers.add(this);
        const result = await deliver.apply(this, args);
        if (
          !popup &&
          args[0].literature_id === papers[0]!.literature.literature_id &&
          result.kind === "delivered" &&
          result.lease
        ) {
          const close = result.lease.close.bind(result.lease);
          vi.spyOn(result.lease, "close").mockImplementation(
            async (outcome) => {
              await close(outcome);
              times.a_lease_closed_ms = performance.now();
            },
          );
        }
        return result;
      },
    );
    const publish = CandidatePublisher.prototype.publish;
    vi.spyOn(CandidatePublisher.prototype, "publish").mockImplementation(
      async function (this: CandidatePublisher, input) {
        // The real owner commits immutable bytes and catalog facts before this
        // barrier. Only returning its actual receipt to Entry is delayed.
        const result = await publish.call(this, input);
        const name = papers.find(
          (paper) => paper.literature.literature_id === input.literature_id,
        )!.name;
        times[`publication_${name}_committed_ms`] = performance.now();
        if (!popup && name === "a") {
          await publicationReturn.promise;
          times.publication_a_returned_ms = performance.now();
        }
        return result;
      },
    );
    let app: Application | undefined;
    let pending:
      | ReturnType<NonNullable<Application["databaseCompletion"]>["run"]>
      | undefined;
    let foregroundPageId: string | undefined;
    let cloakVersion: string | undefined;
    let bExportBeforeA: string | undefined;
    let schedulerDuringPublication:
      | ReturnType<BrowserArticleScheduler["snapshot"]>
      | undefined;
    try {
      await mkdir(join(home, ".sciretriever"), { mode: 0o700 });
      await writeFile(
        join(home, ".sciretriever", "config.toml"),
        `[providers.fixture]\napi = "openai-chat-completions"\nbase_url = "http://127.0.0.1:${modelPort}/v1"\n[models."fixture/browser"]\nimage = true\nstream = false\n[browser]\nenabled = true\nmodel = "fixture/browser"\nprofile = "final-fixture"\n${popup ? "" : 'policy_overrides = [{ rate_limit_group = "browser-generic", max_concurrency = 1 }]\n'}[sources.acquisition]\nmode = "custom"\nproviders = []\n`,
        { mode: 0o600 },
      );
      const runtime = await verifyInstalledCloakRuntime(
        process.env.SCIRETRIEVER_CLOAK_BUNDLE!,
      );
      cloakVersion = runtime.version;
      app = await createApplication(home, {
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
      for (const [index, paper] of papers.entries()) {
        await app.database.putLiterature(paper.literature);
        await app.observations.publish({
          ...parseMetadataObservation({
            source_type: null,
            source_type_mapping_version: null,
            observation_id: `20000000-0000-0000-0000-00000000990${index}`,
            provenance: {
              provenance_id: `30000000-0000-0000-0000-00000000990${index}`,
              source_kind: "metadata-provider",
              source_name: "fixture",
              source_record_id: paper.name,
              observed_at: "2026-10-07T00:00:00Z",
              input_sha256: "a".repeat(64),
              parameters_sha256: null,
            },
            metadata: paper.literature.metadata,
            version_role: "published",
            version_links: [],
            asset_hints: [
              {
                url: `http://${paper.name}-final.test:${port}/article`,
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
        { signal: cohort.signal },
      );
      void pending.catch(() => undefined);
      if (popup) {
        await expect.poll(() => activeModels, { timeout: 30_000 }).toBe(2);
        models.release();
        await expect
          .poll(
            () =>
              requests.filter((request) => request.path === "/same.pdf").length,
            {
              timeout: 30_000,
            },
          )
          .toBe(2);
        const b = pages.get(papers[1]!.literature.literature_id)!;
        await b.page.activate!();
        foregroundPageId = (await b.host.listPages()).find(
          (page) => page.active,
        )!.id;
        expect(foregroundPageId).toBe(b.page.id);
        times.b_selected_foreground_ms = performance.now();
        downloadB.release();
        await expect
          .poll(() => times.publication_b_committed_ms, { timeout: 30_000 })
          .toBeDefined();
        expect(times.download_a_eof_ms).toBeUndefined();
        expect(
          (await app.database.currentFacts(
            papers[0]!.literature.literature_id,
          ))!.primary_asset,
        ).toBeNull();
        expect(
          (await app.database.currentFacts(
            papers[1]!.literature.literature_id,
          ))!.primary_asset?.sha256,
        ).toBe(createHash("sha256").update(papers[1]!.bytes).digest("hex"));
        expect(
          requests
            .filter((request) => request.path === "/same.pdf")
            .map((request) => ({
              article: request.article,
              host: request.host,
              path: request.path,
            }))
            .sort((a, b) => a.article.localeCompare(b.article)),
        ).toEqual([
          { article: "a", host: "127.0.0.1", path: "/same.pdf" },
          { article: "b", host: "127.0.0.1", path: "/same.pdf" },
        ]);
        await mkdir(join(home, "exports"));
        const firstBExport = join(home, "exports", "b-before-a.pdf");
        const bAsset = (await app.database.currentFacts(
          papers[1]!.literature.literature_id,
        ))!.primary_asset!;
        await exportArtifact(app.literatureArtifacts, bAsset, firstBExport);
        const firstBHash = createHash("sha256");
        for await (const chunk of createReadStream(firstBExport))
          firstBHash.update(chunk);
        bExportBeforeA = firstBHash.digest("hex");
        expect(bExportBeforeA).toBe(bAsset.sha256);
        expect(times.download_a_eof_ms).toBeUndefined();
        times.b_exported_before_a_ms = performance.now();
        downloadA.release();
      } else {
        await expect
          .poll(
            () => app!.execution!.transfers.resources.snapshot().native_bytes,
            {
              timeout: 30_000,
            },
          )
          .toBeGreaterThan(0);
        await expect.poll(() => [...schedulers][0]!.snapshot().queued).toBe(1);
        expect(requests.filter((request) => request.article === "b")).toEqual(
          [],
        );
        expect(calls.map((call) => call.article)).toEqual(["a"]);
        times.b_blocked_during_download_ms = performance.now();
        downloadA.release();
        await expect
          .poll(() => times.publication_a_committed_ms, { timeout: 30_000 })
          .toBeDefined();
        expect(
          (await app.database.currentFacts(
            papers[0]!.literature.literature_id,
          ))!.primary_asset?.sha256,
        ).toBe(createHash("sha256").update(papers[0]!.bytes).digest("hex"));
        schedulerDuringPublication = [...schedulers][0]!.snapshot();
        expect(schedulerDuringPublication).toEqual({
          sessions: 1,
          queued: 1,
          workers: 0,
          platform_active: 0,
        });
        expect(times.a_lease_closed_ms).toBeUndefined();
        expect(requests.filter((request) => request.article === "b")).toEqual(
          [],
        );
        times.b_blocked_after_publication_commit_ms = performance.now();
        publicationReturn.release();
        downloadB.release();
      }
      report = await pending;
      expect(report.completed.map((item) => item.literature_id).sort()).toEqual(
        papers.map((paper) => paper.literature.literature_id).sort(),
      );
      expect(report.failed).toEqual([]);
      expect(report.interrupted).toEqual([]);
      if (popup) {
        expect(peakModels).toBe(2);
        expect(times.publication_b_committed_ms!).toBeLessThan(
          times.download_a_eof_ms!,
        );
        expect(times.b_exported_before_a_ms!).toBeLessThan(
          times.download_a_eof_ms!,
        );
      } else {
        expect(times.a_lease_closed_ms).toBeDefined();
        expect(
          requests.find((request) => request.article === "b")!.at_ms,
        ).toBeGreaterThanOrEqual(times.a_lease_closed_ms!);
        expect(peakModels).toBe(1);
      }
      await mkdir(join(home, "exports"), { recursive: true });
      for (const paper of papers) {
        const facts = (await app.database.currentFacts(
          paper.literature.literature_id,
        ))!;
        const hash = createHash("sha256").update(paper.bytes).digest("hex");
        expect(facts.primary_asset?.sha256).toBe(hash);
        expect(facts.primary_asset?.size_bytes).toBe(paper.bytes.length);
        expect(
          (await app.library.detail(paper.literature.literature_id)).primary_pdf
            ?.article_identity_status,
        ).toBe("unverified");
        const candidates = await app.database.listCandidates(
          paper.literature.literature_id,
        );
        expect(candidates).toHaveLength(1);
        expect(candidates[0]!.sha256).toBe(hash);
        expect(candidates[0]!.capture?.article_id).toBe(
          paper.literature.literature_id,
        );
        if (popup)
          expect(candidates[0]!.capture?.page_id).not.toBe(
            pages.get(paper.literature.literature_id)!.page.id,
          );
        expect(
          await app.database.hasAutomaticPdfExhaustion(
            paper.literature.literature_id,
          ),
        ).toBe(false);
        const target = join(home, "exports", `${paper.name}.pdf`);
        await exportArtifact(
          app.literatureArtifacts,
          facts.primary_asset!,
          target,
        );
        const exportedHash = createHash("sha256");
        for await (const chunk of createReadStream(target))
          exportedHash.update(chunk);
        const exportSha256 = exportedHash.digest("hex");
        expect(exportSha256).toBe(hash);
        files.push({
          article: paper.name,
          sha256: hash,
          export_sha256: exportSha256,
          size_bytes: paper.bytes.length,
          candidate_article_id: candidates[0]!.capture!.article_id,
          candidate_page_id: candidates[0]!.capture!.page_id,
        });
      }
      expect(fixtureFailures).toEqual([]);
      await expect
        .poll(() => [...schedulers].map((scheduler) => scheduler.snapshot()))
        .toEqual([{ sessions: 0, queued: 0, workers: 0, platform_active: 0 }]);
      expect(app.execution!.transfers.resources.snapshot()).toMatchObject({
        temporary_bytes: 0,
        pending_write_bytes: 0,
        native_bytes: 0,
        staging_bytes: 0,
        preparation_bytes: 0,
      });
      passed = true;
    } finally {
      models.release();
      downloadA.release();
      downloadB.release();
      publicationReturn.release();
      cohort.abort();
      await app?.close();
      await pending?.catch(() => undefined);
      await proxy.close();
      budget.close();
      vi.restoreAllMocks();
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
            scenario,
            runtime: "verified-cloak",
            cloak_version: cloakVersion,
            node_version: process.version,
            calls,
            peak_model_requests: peakModels,
            requests,
            times,
            foreground_page_id: foregroundPageId,
            b_export_before_a_sha256: bExportBeforeA,
            scheduler_during_publication: schedulerDuringPublication,
            scheduler_after_close: [...schedulers].map((scheduler) =>
              scheduler.snapshot(),
            ),
            resources_after_close:
              app?.execution?.transfers.resources.snapshot(),
            report,
            files,
            fixture_failures: fixtureFailures,
          },
          null,
          2,
        ),
      );
      process.stdout.write(
        `Final Browser integration evidence: ${evidenceDirectory}\n`,
      );
      await rm(home, { recursive: true, force: true });
    }
  },
  90_000,
);
