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
import {
  createApplication,
  type Application,
} from "../src/bootstrap/application.js";
import { browserDecisionFixture } from "./browser-decision-fixture.js";
import { exportArtifact } from "../src/entry/artifact-export.js";
import { BrowserArticleScheduler } from "../src/entry/browser-scheduler.js";
import { verifyInstalledCloakRuntime } from "../src/configuration/cloak-runtime.js";
import { NetworkBudgetCoordinator } from "../src/network/budget.js";
import { BrowserNetworkProxy } from "../src/network/browser-proxy.js";
import { resolveBrowserDestination } from "../src/network/policy.js";
import { ProductionWorkbenchSession } from "../src/workbench/production-session.js";
import {
  FIXTURE_LITERATURE,
  workbenchPdf,
} from "../src/workbench/synthetic-fixture.js";

type Scenario = "cooldown" | "retry-after" | "no-retry-after";
const delay = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
async function until(at: number): Promise<void> {
  await delay(Math.max(0, at - performance.now()));
}

it
  .runIf(Boolean(process.env.SCIRETRIEVER_CLOAK_BUNDLE))
  .each<Scenario>(["cooldown", "retry-after", "no-retry-after"])(
  "enforces real shared platform %s through the formal Application and Cloak",
  async (scenario) => {
    const home = await mkdtemp(
      join(tmpdir(), "sciretriever-policy-production-"),
    );
    const papers = (["a", "b", "c"] as const).map((name, index) => ({
      name,
      host: name === "c" ? "independent-policy.test" : "publisher-policy.test",
      literature: parseLiterature({
        ...FIXTURE_LITERATURE,
        literature_id: `00000000-0000-0000-0000-00000000970${index}`,
        meta_literature_id: `10000000-0000-0000-0000-00000000970${index}`,
        metadata: {
          ...FIXTURE_LITERATURE.metadata,
          title: `Policy article ${name}`,
          identifiers: [{ namespace: "doi", value: `10.1000/policy-${name}` }],
        },
      }),
      bytes: workbenchPdf(`10.1000/policy-${name}`, "published"),
    }));
    const requests: { article: string; path: string; at_ms: number }[] = [];
    const calls: { article: string; at_ms: number }[] = [];
    const nativeTerminals = new Map<string, number>();
    const schedulers = new Set<BrowserArticleScheduler>();
    const deliver = BrowserArticleScheduler.prototype.deliver;
    const deliverySpy = vi
      .spyOn(BrowserArticleScheduler.prototype, "deliver")
      .mockImplementation(function (this: BrowserArticleScheduler, ...args) {
        schedulers.add(this);
        return deliver.apply(this, args);
      });
    const fixtureFailures: string[] = [];
    let throttleAt: number | undefined;
    let sourceEof: number | undefined;
    let releaseSlow!: () => void;
    const slow = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    const origin = createServer((request, response) => {
      const path = request.url ?? "";
      const name = /^\/(?:article|paper)\/([abc])(?:\.pdf)?$/u.exec(path)?.[1];
      const paper = papers.find((item) => item.name === name);
      requests.push({
        article: name ?? "other",
        path,
        at_ms: performance.now(),
      });
      if (!paper) {
        response.writeHead(404);
        response.end();
        return;
      }
      if (path.startsWith("/article/")) {
        const first =
          requests.filter((item) => item.path === path).length === 1;
        if (paper.name === "a" && scenario !== "cooldown" && first) {
          throttleAt = performance.now();
          response.writeHead(429, {
            "content-type": "text/html",
            ...(scenario === "retry-after" ? { "retry-after": "1" } : {}),
          });
          response.end("<title>Busy</title><main>Try later.</main>");
          return;
        }
        response.writeHead(200, { "content-type": "text/html" });
        response.end(
          `<title>${paper.literature.metadata.title}</title><main><h1>${paper.literature.metadata.title}</h1><a href="/paper/${paper.name}.pdf" download>Download PDF</a></main>`,
        );
        return;
      }
      response.writeHead(200, {
        "content-type": "application/pdf",
        "content-disposition": "attachment; filename=policy.pdf",
        "content-length": paper.bytes.length,
      });
      if (scenario === "cooldown" && paper.name === "a") {
        response.write(paper.bytes.slice(0, 100));
        void slow.then(() => {
          if (response.destroyed) return;
          sourceEof = performance.now();
          response.end(paper.bytes.slice(100));
        });
      } else response.end(paper.bytes);
    });
    origin.listen(0, "127.0.0.1");
    await once(origin, "listening");
    const port = (origin.address() as AddressInfo).port;
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
        calls.push({ article: paper.name, at_ms: performance.now() });
        const pdf = observation.elements.find(
          (element) => element.name === "Download PDF",
        );
        const action = pdf
          ? {
              kind: "click-element",
              element_id: pdf.element_id,
              revision: observation.observation_revision,
            }
          : { kind: "stop", reason: "user" };
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
    let app: Application | undefined;
    let pending:
      | ReturnType<NonNullable<Application["databaseCompletion"]>["run"]>
      | undefined;
    const cancel = new AbortController();
    const workbench = new ProductionWorkbenchSession(
      papers[0]!.literature.literature_id,
      (o, f, s, g, t, h, feedback, lifecycle) =>
        browserDecisionFixture(app!.agents)(
          o,
          f,
          s,
          g,
          t,
          h,
          feedback,
          lifecycle,
        ),
    );
    const registered = workbench.registered.bind(workbench);
    vi.spyOn(workbench, "registered").mockImplementation((execution, input) => {
      const completed = execution.transferCompleted.bind(execution);
      vi.spyOn(execution, "transferCompleted").mockImplementation((id) => {
        nativeTerminals.set(input.literature_id, performance.now());
        completed(id);
      });
      return registered(execution, input);
    });
    try {
      await mkdir(join(home, ".sciretriever"), { mode: 0o700 });
      await writeFile(
        join(home, ".sciretriever", "config.toml"),
        `[providers.fixture]\napi = "openai-chat-completions"\nbase_url = "http://127.0.0.1:${modelPort}/v1"\n[models."fixture/browser"]\nimage = true\nstream = false\n[browser]\nenabled = true\nmodel = "fixture/browser"\nprofile = "policy-fixture"\n[sources.acquisition]\nmode = "custom"\nproviders = []\n`,
        { mode: 0o600 },
      );
      app = await createApplication(home, {
        browserRuntime: await verifyInstalledCloakRuntime(
          process.env.SCIRETRIEVER_CLOAK_BUNDLE!,
        ),
        browserProxy: await proxy.start(),
        browserAdmitNavigation: async (url) =>
          (await resolveBrowserDestination(url, resolver, policy)).url.url,
        browserCollaboration: workbench,
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
            observation_id: `20000000-0000-0000-0000-00000000970${index}`,
            provenance: {
              provenance_id: `30000000-0000-0000-0000-00000000970${index}`,
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
                url: `http://${paper.host}:${port}/article/${paper.name}`,
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
        { signal: cancel.signal },
      );
      void pending.catch(() => undefined);
      const bRequests = () => requests.filter((item) => item.article === "b");
      const asset = async (name: string) =>
        (await app!.database.currentFacts(
          papers.find((paper) => paper.name === name)!.literature.literature_id,
        ))!.primary_asset;
      await expect.poll(() => asset("c"), { timeout: 30_000 }).not.toBeNull();
      expect(bRequests()).toEqual([]);
      let boundary: number;
      if (scenario === "cooldown") {
        await expect
          .poll(() => requests.some((item) => item.path === "/paper/a.pdf"), {
            timeout: 30_000,
          })
          .toBe(true);
        expect(await asset("a")).toBeNull();
        expect(nativeTerminals.has(papers[0]!.literature.literature_id)).toBe(
          false,
        );
        releaseSlow();
        await expect
          .poll(
            () => nativeTerminals.has(papers[0]!.literature.literature_id),
            { timeout: 20_000 },
          )
          .toBe(true);
        boundary = nativeTerminals.get(papers[0]!.literature.literature_id)!;
        await until(boundary + 29_900);
        expect(bRequests()).toEqual([]);
        expect(sourceEof).toBeDefined();
      } else {
        expect(throttleAt).toBeDefined();
        boundary = throttleAt!;
        await until(boundary + 59_900);
        expect(bRequests()).toEqual([]);
        expect(
          requests.filter((item) => item.path === "/article/a"),
        ).toHaveLength(1);
      }
      await expect
        .poll(() => bRequests().length, { timeout: 20_000 })
        .toBeGreaterThan(0);
      const firstB = bRequests()[0]!.at_ms;
      expect(firstB - boundary).toBeGreaterThanOrEqual(
        scenario === "cooldown" ? 30_000 : 60_000,
      );
      const report = await pending;
      const expectedNames =
        scenario === "no-retry-after" ? ["b", "c"] : ["a", "b", "c"];
      expect(report.completed).toHaveLength(expectedNames.length);
      if (scenario === "no-retry-after") {
        expect(report.failed).toMatchObject([
          {
            literature_id: papers[0]!.literature.literature_id,
            failure: { code: "pdf-browser-rate-limited" },
          },
        ]);
        expect(
          requests.filter((item) => item.path === "/article/a"),
        ).toHaveLength(1);
        expect(calls.some((item) => item.article === "a")).toBe(false);
      } else expect(report.failed).toEqual([]);
      if (scenario === "retry-after") {
        const retries = requests.filter((item) => item.path === "/article/a");
        expect(retries).toHaveLength(2);
        expect(retries[1]!.at_ms - throttleAt!).toBeGreaterThanOrEqual(60_000);
      }
      await mkdir(join(home, "exports"));
      for (const paper of papers) {
        expect(
          await app.database.hasAutomaticPdfExhaustion(
            paper.literature.literature_id,
          ),
        ).toBe(false);
        if (!expectedNames.includes(paper.name)) continue;
        const primary = (await asset(paper.name))!;
        const hash = createHash("sha256").update(paper.bytes).digest("hex");
        expect(primary.sha256).toBe(hash);
        expect(
          (await app.library.detail(paper.literature.literature_id)).primary_pdf
            ?.article_identity_status,
        ).toBe("unverified");
        const target = join(home, "exports", `${paper.name}.pdf`);
        await exportArtifact(app.literatureArtifacts, primary, target);
        const exported = createHash("sha256");
        for await (const chunk of createReadStream(target))
          exported.update(chunk);
        expect(exported.digest("hex")).toBe(hash);
      }
      expect(
        app.execution!.transfers.resources.snapshot().temporary_bytes,
      ).toBe(0);
      await expect
        .poll(() => [...schedulers].map((scheduler) => scheduler.snapshot()), {
          timeout: 20_000,
        })
        .toEqual([{ sessions: 0, queued: 0, workers: 0, platform_active: 0 }]);
      await app.close();
      expect([...schedulers].map((scheduler) => scheduler.snapshot())).toEqual([
        { sessions: 0, queued: 0, workers: 0, platform_active: 0 },
      ]);
      const resourcesAfterClose = app.execution!.transfers.resources.snapshot();
      expect(resourcesAfterClose).toMatchObject({
        temporary_bytes: 0,
        pending_write_bytes: 0,
        native_bytes: 0,
        staging_bytes: 0,
        preparation_bytes: 0,
      });
      expect(fixtureFailures).toEqual([]);
      const evidence = await mkdtemp(
        join(tmpdir(), "sciretriever-policy-evidence-"),
      );
      await writeFile(
        join(evidence, "evidence.json"),
        JSON.stringify(
          {
            passed: true,
            scenario,
            requests,
            calls,
            source_eof_ms: sourceEof ?? null,
            native_terminals: [...nativeTerminals],
            throttle_at_ms: throttleAt ?? null,
            first_b_ms: firstB,
            wait_after_boundary_ms: firstB - boundary,
            report,
            resources: app.execution!.transfers.resources.snapshot(),
            scheduler_after_close: [...schedulers][0]!.snapshot(),
            resources_after_close: resourcesAfterClose,
            fixture_failures: fixtureFailures,
          },
          null,
          2,
        ),
      );
      process.stdout.write(`Browser policy evidence: ${evidence}\n`);
    } finally {
      releaseSlow();
      cancel.abort();
      await app?.close();
      await pending?.catch(() => undefined);
      await workbench.close();
      deliverySpy.mockRestore();
      await proxy.close();
      budget.close();
      origin.closeAllConnections();
      model.closeAllConnections();
      await Promise.all([
        new Promise<void>((resolve) => origin.close(() => resolve())),
        new Promise<void>((resolve) => model.close(() => resolve())),
      ]);
      await rm(home, { recursive: true, force: true });
    }
  },
  240_000,
);
