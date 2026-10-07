import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { build } from "esbuild";
import { chromium, type Browser } from "playwright";
import {
  parseLiterature,
  parseMetadataObservation,
  parseWorkbenchView,
} from "@sciretriever/contracts";
import {
  createApplication,
  createQueryApplication,
} from "../src/bootstrap/application.js";
import { startProductionWorkbench } from "../src/bootstrap/workbench.js";
import { BrowserNetworkProxy } from "../src/network/browser-proxy.js";
import { NetworkBudgetCoordinator } from "../src/network/budget.js";
import { resolveDestination } from "../src/network/policy.js";
import { verifyInstalledCloakRuntime } from "../src/configuration/cloak-runtime.js";
import {
  FIXTURE_LITERATURE,
  startWorkbenchFixture,
} from "../src/workbench/synthetic-fixture.js";

const SECOND_LITERATURE = parseLiterature({
  ...FIXTURE_LITERATURE,
  literature_id: "00000000-0000-0000-0000-000000000003",
  meta_literature_id: "00000000-0000-0000-0000-000000000004",
});

it.runIf(!!process.env.SCIRETRIEVER_CLOAK_BUNDLE)(
  "connects explicit HTTP acquisition, live control and human capture to the same production article flow",
  async () => {
    const runtime = await verifyInstalledCloakRuntime(
      process.env.SCIRETRIEVER_CLOAK_BUNDLE!,
    );
    const home = await mkdtemp(join(tmpdir(), "sciretriever-collaboration-"));
    const configHome = join(home, ".sciretriever");
    await mkdir(configHome, { mode: 0o700 });
    await writeFile(
      join(configHome, "config.toml"),
      '[providers.fixture]\napi = "openai-chat-completions"\nbase_url = "http://127.0.0.1:9/v1"\n[models."fixture/browser-model"]\nimage = true\nstream = false\n[browser]\nenabled = true\nmodel = "fixture/browser-model"\nprofile = "synthetic"\n[sources.acquisition]\nmode = "custom"\nproviders = []\n',
      { mode: 0o600 },
    );
    const fixture = await startWorkbenchFixture();
    const port = Number(new URL(fixture.origin).port);
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
        maxConcurrency: 4,
        maxHostConcurrency: 4,
        maxResponseBytes: 16 * 1024 * 1024,
        maxRedirects: 0,
        maxRetries: 0,
      },
    });
    let workbench:
      | Awaited<ReturnType<typeof startProductionWorkbench>>
      | undefined;
    let uiBrowser: Browser | undefined;
    let seed: Awaited<ReturnType<typeof createApplication>> | undefined;
    let finishModel!: () => void;
    const modelGate = new Promise<void>((resolve) => {
      finishModel = resolve;
    });
    let finishSecondModel!: () => void;
    const secondModelGate = new Promise<void>((resolve) => {
      finishSecondModel = resolve;
    });
    let finishThirdModel!: () => void;
    const thirdModelGate = new Promise<void>((resolve) => {
      finishThirdModel = resolve;
    });
    let modelCalls = 0;
    try {
      const connection = await proxy.start();
      seed = await createApplication(home, {
        executionSchema: "upgrade-synthetic",
        browserHost: () => null,
      });
      for (const [index, literature] of [
        FIXTURE_LITERATURE,
        SECOND_LITERATURE,
      ].entries()) {
        await seed.database.putLiterature(literature);
        await seed.observations.publish({
          ...parseMetadataObservation({
            observation_id: `00000000-0000-0000-0000-00000000020${index * 2 + 1}`,
            provenance: {
              provenance_id: `00000000-0000-0000-0000-00000000020${index * 2 + 2}`,
              source_kind: "metadata-provider",
              source_name: "fixture",
              source_record_id: "fixture-article",
              observed_at: "2026-09-10T00:00:00Z",
              input_sha256: "a".repeat(64),
              parameters_sha256: null,
            },
            metadata: literature.metadata,
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
          literature_id: literature.literature_id,
        });
      }
      await seed.close();
      seed = undefined;
      const assets = new Map<
        string,
        { contentType: string; body: Uint8Array }
      >();
      for (const [route, file, contentType] of [
        ["/", "live.html", "text/html"],
        ["/styles.css", "styles.css", "text/css"],
        ["/live.css", "live.css", "text/css"],
      ] as const)
        assets.set(route, {
          contentType,
          body: await readFile(
            new URL(`../../web/public/${file}`, import.meta.url),
          ),
        });
      const bundled = await build({
        entryPoints: [
          new URL("../../web/src/live.ts", import.meta.url).pathname,
        ],
        bundle: true,
        format: "esm",
        platform: "browser",
        write: false,
      });
      assets.set("/live.js", {
        contentType: "text/javascript",
        body: bundled.outputFiles[0]!.contents,
      });
      workbench = await startProductionWorkbench({
        home,
        literature_id: FIXTURE_LITERATURE.literature_id,
        assets,
        configurationProbeSeams: { browser_site_factory: async () => null },
        applicationOptions: {
          browserRuntime: runtime,
          browserProxy: connection,
          browserAdmitNavigation: async (url) =>
            (await resolveDestination(url, resolver, policy)).url.url,
          acquisitionAssembly: {
            doiLandingSource: {
              source_name: "doi-landing",
              ready: true,
              discover: async () => [],
            },
          },
          agentTransportFactory:
            () =>
            async ({ body }) => {
              modelCalls += 1;
              const wire = JSON.parse(new TextDecoder().decode(body)) as {
                messages: Array<{
                  content: Array<{ type: string; text?: string }>;
                }>;
              };
              const text = wire.messages[1]?.content.find(
                (part) => part.type === "text",
              )?.text;
              const observation = JSON.parse(text ?? "{}") as {
                observation_revision?: number;
                elements?: Array<{ element_id: string; name: string }>;
              };
              // Both calls intentionally ignore AbortSignal. Their stale returns
              // must never dispatch after a human takes control.
              await (modelCalls === 1
                ? modelGate
                : modelCalls === 2
                  ? secondModelGate
                  : thirdModelGate);
              const download = observation.elements?.find(
                (item) => item.name === "Download PDF",
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
        },
      });
      const origin = workbench.origin;
      uiBrowser = await chromium.launch({
        ...(process.env.SCIRETRIEVER_BROWSER_EXECUTABLE
          ? { executablePath: process.env.SCIRETRIEVER_BROWSER_EXECUTABLE }
          : {}),
        headless: true,
      });
      const ui = await uiBrowser.newPage({
        viewport: { width: 1440, height: 900 },
      });
      const pageErrors: string[] = [];
      ui.on("pageerror", (error) => pageErrors.push(error.message));
      await ui.goto(origin);
      await expect
        .poll(() => ui.locator("#config-status").innerText())
        .not.toContain("不可用");
      await ui.waitForFunction(() => {
        const button =
          document.querySelector<HTMLButtonElement>("#acquisition-start");
        return button && !button.disabled;
      });
      expect(await ui.locator("#acquisition-form").isVisible()).toBe(true);
      expect(
        (
          await workbench.application.library.detail(
            FIXTURE_LITERATURE.literature_id,
          )
        ).primary_pdf,
      ).toBeNull();
      const root = await fetch(origin);
      const cookie = root.headers.get("set-cookie")?.split(";")[0];
      expect(cookie).toBeTruthy();
      const post = async (
        path: string,
        body: unknown,
        client?: { id: string; csrf: string },
      ) => {
        const payload =
          path === "/api/control"
            ? {
                session_id: workbench!.session.view().session_id,
                article_id: workbench!.session.view().article_id,
                ...(body as Record<string, unknown>),
              }
            : body;
        const response = await fetch(
          `${origin}${path}${client ? `?client_id=${client.id}` : ""}`,
          {
            method: "POST",
            headers: {
              Cookie: cookie!,
              Origin: origin,
              "Content-Type": "application/json",
              ...(client
                ? { "X-Workbench-Csrf": client.csrf }
                : { "X-Workbench-Init": "1" }),
            },
            body: JSON.stringify(payload),
          },
        );
        return {
          status: response.status,
          body: (await response.json()) as Record<string, unknown>,
        };
      };
      const a = await post("/api/clients", {}),
        b = await post("/api/clients", {});
      expect(a.status).toBe(201);
      expect(b.status).toBe(201);
      const c1 = {
        id: a.body.client_id as string,
        csrf: a.body.csrf as string,
      };
      const c2 = {
        id: b.body.client_id as string,
        csrf: b.body.csrf as string,
      };
      expect(parseWorkbenchView(a.body.view).observation).toBeNull();
      expect(
        (
          await workbench.application.library.detail(
            FIXTURE_LITERATURE.literature_id,
          )
        ).primary_pdf,
      ).toBeNull();
      await ui.locator("#acquisition-start").click();
      await vi.waitFor(
        () => {
          expect(modelCalls).toBe(1);
          expect(workbench!.session.view().observation).not.toBeNull();
        },
        { timeout: 30_000 },
      );
      const before = workbench.session.view();
      expect(before.control.viewers).toBe(3);
      expect(
        parseWorkbenchView(before).operation_feedback?.targets,
      ).toMatchObject({ total: 1, running: 1, not_started: 0 });
      const secondView = await fetch(`${origin}/api/view?client_id=${c2.id}`, {
        headers: { Cookie: cookie! },
      });
      expect(
        parseWorkbenchView(await secondView.json()).observation?.page_id,
      ).toBe(before.observation?.page_id);
      const frame = await fetch(
        `${origin}/api/frame?client_id=${c2.id}&frame_seq=${before.observation!.frame_seq}`,
        { headers: { Cookie: cookie! } },
      );
      expect(frame.status).toBe(200);
      expect(frame.headers.get("content-type")).toBe("image/jpeg");
      expect((await frame.arrayBuffer()).byteLength).toBeGreaterThan(0);
      const assisted = await post(
        "/api/guidance",
        {
          guidance_id: "human-hint-1",
          session_id: before.session_id,
          article_id: before.article_id,
          control_epoch: before.control.epoch,
          text: "Use the visible PDF button",
        },
        c2,
      );
      expect(assisted.status).toBe(200);
      expect((assisted.body.guidance as { state: string }).state).toBe(
        "accepted",
      );
      const takeover = await post(
        "/api/control",
        {
          kind: "takeover",
          control_epoch: workbench.session.view().control.epoch,
        },
        c1,
      );
      expect(takeover.status).toBe(200);
      finishModel();
      await vi.waitFor(() =>
        expect(workbench!.session.view().guidance?.[0]?.state).toBe("expired"),
      );
      const released = await post(
        "/api/control",
        {
          kind: "release",
          control_epoch: workbench.session.view().control.epoch,
        },
        c1,
      );
      expect(released.status).toBe(200);
      await vi.waitFor(() => expect(modelCalls).toBeGreaterThanOrEqual(2));
      const returned = await post(
        "/api/control",
        {
          kind: "takeover",
          control_epoch: workbench.session.view().control.epoch,
        },
        c1,
      );
      expect(returned.status).toBe(200);
      finishSecondModel();
      const watched = parseWorkbenchView(workbench.session.view());
      expect(watched.control.controller_id).toBe(c1.id);
      expect(
        (
          await workbench.application.library.detail(
            FIXTURE_LITERATURE.literature_id,
          )
        ).primary_pdf,
      ).toBeNull();
      const download = watched.observation?.elements.find(
        (element) => element.name === "Download PDF",
      );
      expect(download).toBeDefined();
      const action = await post(
        "/api/action",
        {
          session_id: watched.session_id,
          page_id: watched.observation!.page_id,
          document_generation: watched.observation!.document_generation,
          observation_revision: watched.observation!.observation_revision,
          viewport_revision: watched.observation!.viewport_revision,
          control_epoch: watched.control.epoch,
          request_id: "human-download-1",
          input: {
            kind: "click-element",
            element_id: download!.element_id,
            revision: watched.observation!.observation_revision,
          },
        },
        c1,
      );
      expect(action.status).toBe(200);
      const finished = await workbench.session.waitForCompletion();
      expect(finished.state).toBe("finished");
      expect(
        parseWorkbenchView(finished).operation_feedback?.report?.completed,
      ).toHaveLength(1);
      expect(finished.operation_feedback?.targets).toMatchObject({
        total: 1,
        completed: 1,
        running: 0,
      });
      expect(finished.operation_feedback?.primary_pdf_status).toBe("verified");
      expect(finished.candidates).toHaveLength(1);
      expect(finished.candidates[0]?.disposition).toBe("accepted");
      expect(finished.operation_feedback?.primary_pdf?.sha256).toBe(
        finished.candidates[0]?.sha256,
      );
      expect(
        (
          await workbench.application.library.detail(
            FIXTURE_LITERATURE.literature_id,
          )
        ).primary_pdf,
      ).not.toBeNull();
      const artifact = await fetch(
        `${origin}/api/library/artifact?client_id=${c1.id}`,
        {
          method: "POST",
          headers: {
            Cookie: cookie!,
            Origin: origin,
            "Content-Type": "application/json",
            "X-Workbench-Csrf": c1.csrf,
          },
          body: JSON.stringify({
            literature_id: FIXTURE_LITERATURE.literature_id,
            kind: "primary-pdf",
          }),
        },
      );
      expect(artifact.status).toBe(200);
      expect(artifact.headers.get("content-type")).toBe("application/pdf");
      expect((await artifact.arrayBuffer()).byteLength).toBeGreaterThan(100);
      await ui.locator("#operation-read").click();
      await expect
        .poll(() => ui.url())
        .toContain(`literature=${FIXTURE_LITERATURE.literature_id}`);
      expect(new URL(ui.url()).searchParams.get("workspace")).toBe("library");
      const completionRun = vi.spyOn(
        workbench.application.databaseCompletion!,
        "run",
      );
      await ui.reload();
      await ui.locator("#library-detail h2").waitFor();
      await ui
        .locator(
          `#library-results button[data-literature-id="${SECOND_LITERATURE.literature_id}"]`,
        )
        .click();
      await ui.getByRole("button", { name: "在 Browser 中打开" }).click();
      await ui.waitForTimeout(2300);
      expect(await ui.locator("#acquisition-literature").inputValue()).toBe(
        SECOND_LITERATURE.literature_id,
      );
      expect(completionRun).not.toHaveBeenCalled();
      completionRun.mockRestore();
      expect(
        await workbench.application.database.hasAutomaticPdfExhaustion(
          FIXTURE_LITERATURE.literature_id,
        ),
      ).toBe(false);
      await ui.locator("#library-toggle").click();
      await ui.locator("#acquisition-start").click();
      await vi.waitFor(() => expect(modelCalls).toBeGreaterThanOrEqual(3), {
        timeout: 30_000,
      });
      const secondArticle = workbench.session.view();
      expect(secondArticle.article_id).toBe(SECOND_LITERATURE.literature_id);
      expect(secondArticle.session_id).not.toBe(finished.session_id);
      expect(
        (
          await post(
            "/api/control",
            {
              kind: "takeover",
              control_epoch: secondArticle.control.epoch,
              session_id: finished.session_id,
              article_id: finished.article_id,
            },
            c1,
          )
        ).status,
      ).toBe(409);
      expect(workbench.session.view().control.controller_id).not.toBe(c1.id);
      expect(
        (
          await post(
            "/api/control",
            { kind: "takeover", control_epoch: secondArticle.control.epoch },
            c1,
          )
        ).status,
      ).toBe(200);
      finishThirdModel();
      expect(
        (
          await post(
            "/api/control",
            {
              kind: "cancel",
              control_epoch: workbench.session.view().control.epoch,
            },
            c1,
          )
        ).status,
      ).toBe(200);
      const cancelled = await workbench.session.waitForCompletion();
      expect(cancelled.state).toBe("cancelled");
      expect(cancelled.operation_feedback?.report?.interrupted).toHaveLength(1);
      expect(
        (
          await workbench.application.library.detail(
            SECOND_LITERATURE.literature_id,
          )
        ).primary_pdf,
      ).toBeNull();
      expect(
        (
          await workbench.application.library.detail(
            FIXTURE_LITERATURE.literature_id,
          )
        ).primary_pdf?.asset.sha256,
      ).toBe(finished.operation_feedback?.primary_pdf?.sha256);
      await ui.locator("#config-tab").click();
      await expect
        .poll(() => ui.locator("#config-runtime-status").innerText())
        .toContain("当前普通配置");
      await ui.locator("#config-browser-enabled").uncheck();
      await ui.locator("#config-save").click();
      await expect
        .poll(() => ui.locator("#config-page-status").innerText())
        .toContain("需要重启");
      expect(await ui.locator("#config-runtime-status").innerText()).toContain(
        "需重启服务后生效",
      );
      expect(pageErrors).toEqual([]);
      const closingWorkbench = workbench;
      const closeApplication = closingWorkbench.application.close.bind(
        closingWorkbench.application,
      );
      const sessionClose = vi.spyOn(closingWorkbench.session, "close");
      const appClose = vi
        .spyOn(closingWorkbench.application, "close")
        .mockImplementationOnce(() => {
          throw new Error("synchronous application close failure");
        });
      const firstClose = closingWorkbench.close();
      expect(closingWorkbench.close()).toBe(firstClose);
      await expect(firstClose).rejects.toThrow(
        "production workbench shutdown failed",
      );
      expect(sessionClose).toHaveBeenCalledTimes(1);
      expect(appClose).toHaveBeenCalledTimes(1);
      expect(
        (
          await closingWorkbench.application.library.detail(
            FIXTURE_LITERATURE.literature_id,
          )
        ).primary_pdf?.asset.sha256,
      ).toBe(finished.operation_feedback?.primary_pdf?.sha256);
      appClose.mockRestore();
      await closeApplication();
      const agentQuery = await createQueryApplication(home);
      try {
        const agentDetail = await agentQuery.query!.detail(
          FIXTURE_LITERATURE.literature_id,
        );
        expect(agentDetail.primary_pdf?.asset.sha256).toBe(
          finished.operation_feedback?.primary_pdf?.sha256,
        );
        const bytes: Uint8Array[] = [];
        await agentQuery.literatureArtifacts!.withArtifact(
          agentDetail.primary_pdf!.asset,
          async (chunks) => {
            for await (const chunk of chunks) bytes.push(chunk);
          },
        );
        expect(
          createHash("sha256").update(Buffer.concat(bytes)).digest("hex"),
        ).toBe(finished.operation_feedback?.primary_pdf?.sha256);
      } finally {
        await agentQuery.close();
      }
      workbench = undefined;
    } finally {
      finishModel();
      finishSecondModel();
      finishThirdModel();
      await uiBrowser?.close();
      await workbench?.close();
      await seed?.close();
      await proxy.close();
      budget.close();
      await fixture.close();
      await rm(home, { recursive: true, force: true });
    }
  },
  90_000,
);
