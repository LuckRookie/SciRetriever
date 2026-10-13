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
  parseWorkbenchView,
  type WorkbenchObservation,
  type WorkbenchView,
} from "@sciretriever/contracts";
import {
  createApplication,
  type Application,
} from "../src/bootstrap/application.js";
import { startProductionWorkbench } from "../src/bootstrap/workbench.js";
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
  .each(["model-control", "candidate-ready", "model-failure"] as const)(
  "isolates A's %s outcome from B's production native download and publication",
  async (scenario) => {
    const home = await mkdtemp(
      join(tmpdir(), "sciretriever-control-production-"),
    );
    const modelA = gate();
    const downloadB = gate();
    const acceptanceA = gate();
    const acceptanceEntered = gate();
    const papers = (["a", "b"] as const).map((name, index) => ({
      name,
      literature: parseLiterature({
        ...FIXTURE_LITERATURE,
        literature_id: `00000000-0000-0000-0000-00000000980${index}`,
        meta_literature_id: `10000000-0000-0000-0000-00000000980${index}`,
        metadata: {
          ...FIXTURE_LITERATURE.metadata,
          title: `Control article ${name}`,
          identifiers: [{ namespace: "doi", value: `10.1000/control-${name}` }],
        },
      }),
      bytes: workbenchPdf(`10.1000/control-${name}`, "published"),
    }));
    const requests: { article: string; path: string; at_ms: number }[] = [];
    const calls: {
      article: string;
      at_ms: number;
      closed_ms: number | null;
    }[] = [];
    const fixtureFailures: string[] = [];
    let bEndedAt: number | null = null;
    let acceptanceSignal: AbortSignal | undefined;
    const origin = createServer((request, response) => {
      const name = /^([ab])-control\.test$/u.exec(
        (request.headers.host ?? "").split(":")[0]!,
      )?.[1];
      const paper = papers.find((item) => item.name === name);
      requests.push({
        article: name ?? "other",
        path: request.url ?? "",
        at_ms: performance.now(),
      });
      if (!paper) {
        response.writeHead(404);
        response.end();
        return;
      }
      if (request.url === "/article") {
        response.writeHead(200, { "content-type": "text/html" });
        response.end(
          `<title>${paper.literature.metadata.title}</title><main><h1>${paper.literature.metadata.title}</h1><a href="/paper.pdf" download>Download PDF</a></main>`,
        );
      } else if (request.url === "/paper.pdf") {
        response.writeHead(200, {
          "content-type": "application/pdf",
          "content-disposition": "attachment; filename=control.pdf",
          "content-length": paper.bytes.length,
        });
        if (paper.name === "b") {
          response.write(paper.bytes.slice(0, 100));
          void downloadB.promise.then(() => {
            if (response.destroyed) return;
            bEndedAt = performance.now();
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
    const model = createServer((request, response) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of request)
          chunks.push(Buffer.from(chunk as Uint8Array));
        const wire = JSON.parse(Buffer.concat(chunks).toString()) as {
          messages: { content: { type: string; text?: string }[] }[];
        };
        const observation = JSON.parse(
          wire.messages[1]!.content.find((part) => part.type === "text")!.text!,
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
          closed_ms: null as number | null,
        };
        calls.push(call);
        response.once("close", () => {
          call.closed_ms = performance.now();
        });
        if (scenario === "model-control" && paper.name === "a")
          await modelA.promise;
        if (scenario === "model-failure" && paper.name === "a") {
          response.writeHead(503, { "content-type": "application/json" });
          response.end(
            JSON.stringify({ error: { message: "Fixture unavailable" } }),
          );
          return;
        }
        const element = observation.elements.find(
          (item) => item.name === "Download PDF",
        )!;
        const action = {
          kind: "click-element",
          element_id: element.element_id,
          revision: observation.observation_revision,
        };
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
    let seed: Application | undefined;
    let workbench:
      | Awaited<ReturnType<typeof startProductionWorkbench>>
      | undefined;
    let pending:
      | ReturnType<NonNullable<Application["databaseCompletion"]>["run"]>
      | undefined;
    const cohort = new AbortController();
    const schedulers = new Set<BrowserArticleScheduler>();
    const deliver = BrowserArticleScheduler.prototype.deliver;
    const deliverySpy = vi
      .spyOn(BrowserArticleScheduler.prototype, "deliver")
      .mockImplementation(function (this: BrowserArticleScheduler, ...args) {
        schedulers.add(this);
        return deliver.apply(this, args);
      });
    let controlEvidence: {
      cancelled_article_id: string;
      control_epoch_after_takeover: number;
      budget_before_cancel: WorkbenchObservation["remaining"];
    } | null = null;
    try {
      await mkdir(join(home, ".sciretriever"), { mode: 0o700 });
      await writeFile(
        join(home, ".sciretriever", "config.toml"),
        `[providers.fixture]\napi = "openai-chat-completions"\nbase_url = "http://127.0.0.1:${modelPort}/v1"\n[models."fixture/browser"]\nimage = true\nstream = false\n[browser]\nenabled = true\nmodel = "fixture/browser"\nprofile = "control-fixture"\n[sources.acquisition]\nmode = "custom"\nproviders = []\n`,
        { mode: 0o600 },
      );
      seed = await createApplication(home, {
        executionSchema: "upgrade-synthetic",
        browserHost: () => null,
      });
      for (const [index, paper] of papers.entries()) {
        await seed.database.putLiterature(paper.literature);
        await seed.observations.publish({
          ...parseMetadataObservation({
            observation_id: `20000000-0000-0000-0000-00000000980${index}`,
            provenance: {
              provenance_id: `30000000-0000-0000-0000-00000000980${index}`,
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
                url: `http://${paper.name}-control.test:${port}/article`,
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
      await seed.close();
      seed = undefined;
      workbench = await startProductionWorkbench({
        home,
        literature_id: papers[0]!.literature.literature_id,
        assets: new Map([
          [
            "/",
            {
              contentType: "text/html",
              body: new TextEncoder().encode("<main>Control fixture</main>"),
            },
          ],
        ]),
        configurationProbeSeams: { browser_site_factory: async () => null },
        applicationOptions: {
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
        },
      });
      const app = workbench.application;
      if (scenario === "candidate-ready") {
        const accept = app.execution!.acceptance.accept.bind(
          app.execution!.acceptance,
        );
        vi.spyOn(app.execution!.acceptance, "accept").mockImplementation(
          async (intent, signal) => {
            if (intent.literature_id === papers[0]!.literature.literature_id) {
              acceptanceSignal = signal;
              acceptanceEntered.release();
              await acceptanceA.promise;
            }
            return accept(intent, signal);
          },
        );
      }
      const homeResponse = await fetch(workbench.origin);
      const cookie = homeResponse.headers.get("set-cookie")!.split(";")[0]!;
      const clientResponse = await fetch(`${workbench.origin}/api/clients`, {
        method: "POST",
        headers: {
          Cookie: cookie,
          Origin: workbench.origin,
          "Content-Type": "application/json",
          "X-Workbench-Init": "1",
        },
        body: "{}",
      });
      const client = (await clientResponse.json()) as {
        client_id: string;
        csrf: string;
      };
      const view = async () =>
        parseWorkbenchView(
          await (
            await fetch(
              `${workbench!.origin}/api/view?client_id=${client.client_id}`,
              { headers: { Cookie: cookie } },
            )
          ).json(),
        );
      const post = async (
        path: string,
        value: unknown,
      ): Promise<WorkbenchView> => {
        const response = await fetch(
          `${workbench!.origin}${path}?client_id=${client.client_id}`,
          {
            method: "POST",
            headers: {
              Cookie: cookie,
              Origin: workbench!.origin,
              "Content-Type": "application/json",
              "X-Workbench-CSRF": client.csrf,
            },
            body: JSON.stringify(value),
          },
        );
        expect(response.status).toBe(200);
        return parseWorkbenchView(
          ((await response.json()) as { view: unknown }).view,
        );
      };
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
      await expect
        .poll(() => [...new Set(calls.map((call) => call.article))].sort(), {
          timeout: 30_000,
        })
        .toEqual(["a", "b"]);
      await expect
        .poll(
          () =>
            requests.some(
              (request) =>
                request.article === "b" && request.path === "/paper.pdf",
            ),
          { timeout: 30_000 },
        )
        .toBe(true);
      expect(bEndedAt).toBeNull();
      if (scenario === "candidate-ready") await acceptanceEntered.promise;
      const listed = await view();
      const sidB = listed.sessions!.find(
        (session) => session.article_id === papers[1]!.literature.literature_id,
      )!.session_id;
      if (scenario !== "model-failure") {
        const sidA = listed.sessions!.find(
          (session) =>
            session.article_id === papers[0]!.literature.literature_id,
        )!.session_id;
        const a = await post("/api/sessions/select", { session_id: sidA });
        expect(a.observation?.article_id).toBe(
          papers[0]!.literature.literature_id,
        );
        const takeover = await post("/api/control", {
          kind: "takeover",
          session_id: sidA,
          article_id: a.article_id,
          control_epoch: a.control.epoch,
        });
        expect(takeover.control.controller_id).toBe(client.client_id);
        controlEvidence = {
          cancelled_article_id: a.article_id!,
          control_epoch_after_takeover: takeover.control.epoch,
          budget_before_cancel: takeover.observation!.remaining,
        };
        if (scenario === "model-control") {
          modelA.release();
          await expect
            .poll(() => calls.find((call) => call.article === "a")!.closed_ms)
            .not.toBeNull();
          expect(
            requests.filter(
              (request) =>
                request.article === "a" && request.path === "/paper.pdf",
            ),
          ).toEqual([]);
        } else {
          expect(takeover.session_phase).toBe("candidate-ready");
          expect(takeover.candidates).toHaveLength(1);
        }
        const cancelled = await post("/api/control", {
          kind: "cancel",
          session_id: sidA,
          article_id: a.article_id,
          control_epoch: takeover.control.epoch,
        });
        expect(cancelled.state).toBe("cancelled");
        expect(cohort.signal.aborted).toBe(false);
      }
      acceptanceA.release();
      const b = await post("/api/sessions/select", { session_id: sidB });
      expect(b.state).not.toBe("cancelled");
      expect(b.session_phase).toBe("downloading");
      expect(b.observation?.article_id).toBe(
        papers[1]!.literature.literature_id,
      );
      downloadB.release();
      const report = await pending;
      const factsA = (await app.database.currentFacts(
        papers[0]!.literature.literature_id,
      ))!;
      const factsB = (await app.database.currentFacts(
        papers[1]!.literature.literature_id,
      ))!;
      const candidatesA = await app.database.listCandidates(
        papers[0]!.literature.literature_id,
      );
      expect(factsA.primary_asset).toBeNull();
      expect(report.completed).toMatchObject([
        { literature_id: papers[1]!.literature.literature_id },
      ]);
      if (scenario === "model-failure") {
        expect(report.interrupted).toEqual([]);
        expect(report.failed).toMatchObject([
          {
            literature_id: papers[0]!.literature.literature_id,
            failure: { code: "pdf-browser-flow-failed" },
          },
        ]);
        expect(
          requests.filter(
            (request) =>
              request.article === "a" && request.path === "/paper.pdf",
          ),
        ).toEqual([]);
      } else {
        expect(report.interrupted).toMatchObject([
          { literature_id: papers[0]!.literature.literature_id },
        ]);
      }
      if (scenario === "candidate-ready") {
        expect(candidatesA).toHaveLength(1);
        expect(
          await app.execution!.transfers.recover(candidatesA[0]!.transfer_id),
        ).toEqual(candidatesA[0]);
      } else expect(candidatesA).toEqual([]);
      const hashB = createHash("sha256").update(papers[1]!.bytes).digest("hex");
      expect(factsB.primary_asset?.sha256).toBe(hashB);
      expect(
        (await app.library.detail(papers[1]!.literature.literature_id))
          .primary_pdf?.article_identity_status,
      ).toBe("unverified");
      await mkdir(join(home, "exports"));
      const exportedPath = join(home, "exports", "b.pdf");
      await exportArtifact(
        app.literatureArtifacts,
        factsB.primary_asset!,
        exportedPath,
      );
      const exportedHash = createHash("sha256");
      for await (const chunk of createReadStream(exportedPath))
        exportedHash.update(chunk);
      expect(exportedHash.digest("hex")).toBe(hashB);
      expect(
        await app.database.hasAutomaticPdfExhaustion(
          papers[0]!.literature.literature_id,
        ),
      ).toBe(false);
      expect(
        app.execution!.transfers.resources.snapshot().temporary_bytes,
      ).toBe(0);
      await expect
        .poll(() => [...schedulers].map((scheduler) => scheduler.snapshot()), {
          timeout: 5000,
        })
        .toEqual([{ sessions: 0, queued: 0, workers: 0, platform_active: 0 }]);
      const finalB = await view();
      expect(finalB.session_outcome).toMatchObject({ kind: "published" });
      expect(fixtureFailures).toEqual([]);
      const evidence = await mkdtemp(
        join(tmpdir(), "sciretriever-control-evidence-"),
      );
      await writeFile(
        join(evidence, "evidence.json"),
        JSON.stringify(
          {
            passed: true,
            scenario,
            requests,
            calls,
            b_ended_ms: bEndedAt,
            report,
            ...controlEvidence,
            candidate_count_a: candidatesA.length,
            acceptance_signal_aborted: acceptanceSignal?.aborted ?? null,
            primary_a: factsA.primary_asset,
            primary_b_sha256: hashB,
            final_b_outcome: finalB.session_outcome,
            resources: app.execution!.transfers.resources.snapshot(),
            scheduler: [...schedulers][0]!.snapshot(),
            fixture_failures: fixtureFailures,
          },
          null,
          2,
        ),
      );
      process.stdout.write(`Browser control evidence: ${evidence}\n`);
    } finally {
      modelA.release();
      downloadB.release();
      acceptanceA.release();
      cohort.abort();
      await workbench?.close();
      await pending?.catch(() => undefined);
      await seed?.close();
      await proxy.close();
      deliverySpy.mockRestore();
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
  90_000,
);
