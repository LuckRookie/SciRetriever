import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
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
import { BrowserNetworkProxy } from "../src/network/browser-proxy.js";
import { NetworkBudgetCoordinator } from "../src/network/budget.js";
import { resolveBrowserDestination } from "../src/network/policy.js";
import {
  FIXTURE_LITERATURE,
  workbenchPdf,
} from "../src/workbench/synthetic-fixture.js";
import {
  browserModelToolCallId,
  latestBrowserObservationMessage,
} from "./browser-model-fixture.js";

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

it.runIf(Boolean(process.env.SCIRETRIEVER_CLOAK_BUNDLE))(
  "runs one production DSH article history through human control, background transfer failure and sibling publication",
  async () => {
    const home = await mkdtemp(join(tmpdir(), "sciretriever-dsh-production-"));
    const firstModel = gate();
    const slowDownload = gate();
    const papers = (["a", "b"] as const).map((name, index) => ({
      name,
      literature: parseLiterature({
        ...FIXTURE_LITERATURE,
        literature_id: `00000000-0000-0000-0000-00000000870${index}`,
        meta_literature_id: `10000000-0000-0000-0000-00000000870${index}`,
        metadata: {
          ...FIXTURE_LITERATURE.metadata,
          title: `DSH article ${name}`,
          identifiers: [{ namespace: "doi", value: `10.1000/dsh-${name}` }],
        },
      }),
      bytes: workbenchPdf(`10.1000/dsh-${name}`, "published"),
    }));
    const pageRequests: { article: string; path: string }[] = [];
    const calls: {
      article: string;
      observation: WorkbenchObservation;
      wire: {
        messages: readonly {
          role: string;
          content: unknown;
          tool_call_id?: string;
        }[];
      };
    }[] = [];
    const fixtureErrors: unknown[] = [];
    let aDownloads = 0;
    const origin = createServer((request, response) => {
      const article = (request.headers.host ?? "").startsWith("a-dsh.test:")
        ? "a"
        : "b";
      const paper = papers.find((item) => item.name === article)!;
      pageRequests.push({ article, path: request.url ?? "" });
      if (request.url === "/article") {
        response.writeHead(200, { "content-type": "text/html" });
        response.end(
          `<title>${paper.literature.metadata.title}</title><main><h1>${paper.literature.metadata.title}</h1><a href="/download-page">Open download page</a></main>`,
        );
      } else if (request.url === "/download-page") {
        response.writeHead(200, { "content-type": "text/html" });
        response.end(
          `<title>${paper.literature.metadata.title}</title><main><h1>${paper.literature.metadata.title}</h1><a href="/paper.pdf" download>Download PDF</a></main>`,
        );
      } else if (request.url === "/paper.pdf") {
        response.writeHead(200, {
          "content-type": "application/pdf",
          "content-disposition": "attachment; filename=article.pdf",
          "content-length": paper.bytes.length,
        });
        if (article === "a" && ++aDownloads === 1) {
          response.write(paper.bytes.slice(0, 100));
          void slowDownload.promise.then(() => response.destroy());
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
        const wire = JSON.parse(
          Buffer.concat(chunks).toString(),
        ) as (typeof calls)[number]["wire"];
        const observation = JSON.parse(
          latestBrowserObservationMessage(wire).content.find(
            (part) => part.type === "text",
          )!.text!,
        ) as WorkbenchObservation;
        const article = papers.find(
          (paper) => paper.literature.literature_id === observation.article_id,
        )!.name;
        calls.push({ article, observation, wire });
        if (
          article === "a" &&
          calls.filter((call) => call.article === "a").length === 1
        )
          await firstModel.promise;
        if (response.destroyed) return;
        const element =
          observation.elements.find((item) => item.name === "Download PDF") ??
          observation.elements.find(
            (item) => item.name === "Open download page",
          );
        const action = element
          ? {
              kind: "click-element",
              element_id: element.element_id,
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
                  role: "assistant",
                  content: null,
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
            usage: { prompt_tokens: 10, completion_tokens: 5 },
          }),
        );
      })().catch((error: unknown) => {
        fixtureErrors.push(error);
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
        maxResponseBytes: 16 * 1024 * 1024,
        maxRedirects: 0,
        maxRetries: 0,
      },
    });
    let seed: Application | undefined;
    let workbench:
      | Awaited<ReturnType<typeof startProductionWorkbench>>
      | undefined;
    let pending: Promise<unknown> | undefined;
    const cohort = new AbortController();
    try {
      await mkdir(join(home, ".sciretriever"), { mode: 0o700 });
      await writeFile(
        join(home, ".sciretriever", "config.toml"),
        `[paths]\ncatalog_path=${JSON.stringify(join(home, "catalog.sqlite"))}\nartifact_root=${JSON.stringify(join(home, "artifacts"))}\n` +
          `[providers.fixture]\napi = "openai-chat-completions"\nbase_url = "http://127.0.0.1:${modelPort}/v1"\n[models."fixture/browser"]\nimage = true\nstream = false\n[browser]\nenabled = true\nmodel = "fixture/browser"\nprofile = "dsh-fixture"\n[sources.acquisition]\nmode = "custom"\nproviders = []\n`,
        { mode: 0o600 },
      );
      seed = await createApplication(home, {
        executionSchema: "upgrade-synthetic",
      });
      for (const [index, paper] of papers.entries()) {
        await seed.database.putLiterature(paper.literature);
        await seed.observations.publish({
          ...parseMetadataObservation({
            observation_id: `20000000-0000-0000-0000-00000000870${index}`,
            provenance: {
              provenance_id: `30000000-0000-0000-0000-00000000870${index}`,
              source_kind: "metadata-provider",
              source_name: "fixture",
              source_record_id: paper.name,
              observed_at: "2026-10-13T00:00:00Z",
              input_sha256: "a".repeat(64),
              parameters_sha256: null,
            },
            metadata: paper.literature.metadata,
            version_role: "published",
            version_links: [],
            asset_hints: [
              {
                url: `http://${paper.name}-dsh.test:${port}/article`,
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
              body: new TextEncoder().encode(
                "<main>DSH production fixture</main>",
              ),
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
      const cookie = (await fetch(workbench.origin)).headers
        .get("set-cookie")!
        .split(";")[0]!;
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
        const result = (await response.json()) as {
          view?: unknown;
          code?: string;
        };
        const current = workbench!.session.view(client.client_id);
        const diagnostic = {
          path,
          status: response.status,
          code: result.code,
          requested: value,
          current: {
            control_epoch: current.control.epoch,
            page_id: current.observation?.page_id,
            document_generation: current.observation?.document_generation,
            observation_revision: current.observation?.observation_revision,
            viewport_revision: current.observation?.viewport_revision,
            loading: current.observation?.loading,
            partial: current.observation?.partial,
            error: current.error,
          },
        };
        expect(response.status, JSON.stringify(diagnostic, null, 2)).toBe(200);
        return parseWorkbenchView(result.view);
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
        .poll(() => calls.filter((call) => call.article === "a").length, {
          timeout: 30_000,
        })
        .toBe(1);
      const listed = await view();
      const sidA = listed.sessions!.find(
        (session) => session.article_id === papers[0]!.literature.literature_id,
      )!.session_id;
      const selected = await post("/api/sessions/select", { session_id: sidA });
      const takeover = await post("/api/control", {
        kind: "takeover",
        session_id: sidA,
        article_id: selected.article_id,
        control_epoch: selected.control.epoch,
      });
      // Takeover returns a new control binding, not a refreshed page observation.
      // Re-selecting the same session waits for its human-side observation before
      // constructing the single command; stale commands must still be rejected.
      const human = await post("/api/sessions/select", { session_id: sidA });
      expect(human).toMatchObject({
        session_id: sidA,
        article_id: selected.article_id,
        control: {
          controller_id: client.client_id,
          epoch: takeover.control.epoch,
        },
        observation: {
          page_id: takeover.observation!.page_id,
          document_generation: takeover.observation!.document_generation,
          loading: false,
          partial: false,
        },
      });
      const observed = human.observation!;
      const link = observed.elements.find(
        (element) => element.name === "Open download page",
      )!;
      expect(link).toBeDefined();
      const moved = await post("/api/action", {
        session_id: sidA,
        page_id: observed.page_id,
        document_generation: observed.document_generation,
        observation_revision: observed.observation_revision,
        viewport_revision: observed.viewport_revision,
        control_epoch: human.control.epoch,
        request_id: `human-${randomUUID()}`,
        input: {
          kind: "click-element",
          element_id: link.element_id,
          revision: observed.observation_revision,
        },
      });
      firstModel.release();
      const released = await post("/api/control", {
        kind: "release",
        session_id: sidA,
        article_id: selected.article_id,
        control_epoch: moved.control.epoch,
      });
      await post("/api/guidance", {
        session_id: sidA,
        article_id: selected.article_id,
        control_epoch: released.control.epoch,
        guidance_id: "guidance-a",
        text: "Use the visible Download PDF control on this article.",
      });
      await expect.poll(() => aDownloads, { timeout: 30_000 }).toBe(1);
      await expect
        .poll(
          async () =>
            (await app.database.currentFacts(
              papers[1]!.literature.literature_id,
            ))!.primary_asset,
          { timeout: 30_000 },
        )
        .not.toBeNull();
      expect(
        (await app.database.currentFacts(papers[0]!.literature.literature_id))!
          .primary_asset,
      ).toBeNull();
      // A's native writer is still pending while B has completed formal publication.
      expect(
        app.execution!.transfers.resources.snapshot().native_bytes,
      ).toBeGreaterThan(0);
      slowDownload.release();
      const report = (await pending) as {
        completed: readonly { literature_id: string }[];
      };
      expect(report.completed).toHaveLength(2);
      expect(aDownloads).toBe(2);
      expect(
        pageRequests.filter(
          (request) =>
            request.article === "a" && request.path === "/download-page",
        ),
      ).toHaveLength(1);
      const aCalls = calls.filter((call) => call.article === "a");
      const bCalls = calls.filter((call) => call.article === "b");
      expect(
        new Set(aCalls.map((call) => call.observation.session_id)),
      ).toEqual(new Set([sidA]));
      const aHistory = JSON.stringify(aCalls.at(-1)!.wire);
      expect(aHistory).toContain("human-action");
      expect(aHistory).toContain("transfer-failed");
      expect(aHistory).toContain("Use the visible Download PDF control");
      expect(aHistory).toContain("browser-action-applied");
      expect(aHistory).not.toContain("DSH article b");
      expect(JSON.stringify(bCalls.at(-1)!.wire)).not.toContain("guidance-a");
      expect(
        bCalls.some((call) =>
          call.wire.messages.some(
            (message) =>
              message.role === "tool" && Boolean(message.tool_call_id),
          ),
        ),
      ).toBe(true);
      expect(
        (await view()).guidance?.find(
          (guidance) => guidance.guidance_id === "guidance-a",
        )?.state,
      ).toBe("consumed");
      for (const paper of papers) {
        const asset = (await app.library.detail(paper.literature.literature_id))
          .primary_pdf!.asset;
        const actual = await app.literatureArtifacts.withArtifact(
          asset,
          async (chunks) => {
            const hash = createHash("sha256");
            for await (const chunk of chunks) hash.update(chunk);
            return hash.digest("hex");
          },
        );
        expect(actual).toBe(
          createHash("sha256").update(paper.bytes).digest("hex"),
        );
      }
      expect(fixtureErrors).toEqual([]);
    } finally {
      cohort.abort();
      firstModel.release();
      slowDownload.release();
      await workbench?.close();
      await seed?.close();
      await pending?.catch(() => undefined);
      await proxy.close();
      budget.close();
      model.closeAllConnections();
      origin.closeAllConnections();
      await Promise.all([
        new Promise<void>((resolve) => model.close(() => resolve())),
        new Promise<void>((resolve) => origin.close(() => resolve())),
      ]);
      await rm(home, { recursive: true, force: true });
    }
  },
  180_000,
);
