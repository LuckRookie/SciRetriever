import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { chromium } from "playwright";
import { describe, expect, it, vi } from "vitest";
import {
  ConfigurationProbeSession,
  TypeScriptConfigurationOwner,
  type ConfigurationProbeRequest,
} from "../../server/src/configuration/owner.js";
import type {
  AgentTransport,
  AgentTransportResponse,
} from "../../server/src/agents/protocol.js";
import {
  startWorkbenchHttp,
  type WorkbenchStaticAsset,
} from "../../server/src/workbench/http.js";
import { WorkbenchSession } from "../../server/src/workbench/session.js";

function fixtureSession(): WorkbenchSession {
  return new WorkbenchSession(
    "configuration-ui-fixture",
    {
      id: "configuration-ui-page",
      title: async () => "Configuration UI fixture",
      url: () => "http://127.0.0.1/configuration-ui-fixture",
      navigate: async () => undefined,
      close: async () => undefined,
      snapshot: async () => ({
        url: "http://127.0.0.1/configuration-ui-fixture",
        title: "Configuration UI fixture",
        document_generation: 1,
        viewport: { width: 800, height: 600, device_scale_factor: 1 },
        screenshot: null,
      }),
      apply: async () => undefined,
    },
    {
      max_actions: 2,
      max_model_calls: 1,
      max_retries: 1,
      max_bytes: 1024,
      deadline_ms: 10_000,
    },
  );
}

async function assets(): Promise<Map<string, WorkbenchStaticAsset>> {
  const values = new Map<string, WorkbenchStaticAsset>();
  for (const [route, file, contentType] of [
    ["/", "live.html", "text/html"],
    ["/styles.css", "styles.css", "text/css"],
    ["/live.css", "live.css", "text/css"],
  ] as const)
    values.set(route, {
      contentType,
      body: await readFile(new URL(`../public/${file}`, import.meta.url)),
    });
  const bundled = await build({
    entryPoints: [new URL("../src/live.ts", import.meta.url).pathname],
    bundle: true,
    format: "esm",
    platform: "browser",
    write: false,
  });
  values.set("/live.js", {
    contentType: "text/javascript",
    body: bundled.outputFiles[0]!.contents,
  });
  return values;
}

describe("configuration workbench", () => {
  it("saves, preserves a conflicted draft, probes explicitly and keeps credentials out of page state", async () => {
    const home = await mkdtemp(join(tmpdir(), "sciretriever-config-ui-"));
    const owner = new TypeScriptConfigurationOwner(home);
    await owner.publish(
      '[providers.fixture]\napi = "openai-responses"\nbase_url = "https://model.example.test/v1"\n[models."fixture/vision"]\nimage = true\nstream = false\n[sources.metadata]\nmode = "custom"\nproviders = ["openalex", "crossref"]\nlimit = 500\n[sources.acquisition]\nmode = "custom"\nproviders = ["core"]\n',
      "missing",
      ["providers", "models", "sources"],
    );
    const runtimeRevision = (await owner.read()).revision;
    let armReadinessFailureAfterPublish = false;
    let failNextReadiness = false;
    const session = fixtureSession();
    await session.refresh();
    const probes = vi.fn(async (request: ConfigurationProbeRequest) => ({
      owner: request.owner,
      target: request.target,
      outcome: "passed" as const,
      method: "POST",
      endpoint: "http://127.0.0.1:1/synthetic-probe",
      provider: null,
      model: request.owner === "browser-model" ? "fixture/vision" : null,
      checks: ["synthetic-probe"],
      reason: "probe-passed",
      action: "none",
      network_performed: true,
      browser_launched: false,
      authentication: "not-attempted" as const,
      article_entitlement: "not-proven" as const,
      persisted: false as const,
      limitations: [],
      results: [],
      execution: {
        owner: request.owner,
        target: request.target,
        code: "probe-passed",
        elapsed_ms: 1,
        next_action: "none",
        network: "may-have-run" as const,
        may_consume_quota: false,
      },
    }));
    const server = await startWorkbenchHttp({
      session,
      configuration: {
        runtime_revision: runtimeRevision,
        runtime_capabilities: {
          parsing: {
            assembled: true,
            unavailable_reason: null,
          },
          metadata: [],
          acquisition: [
            {
              source_name: "core",
              selected: true,
              assembled: false,
              ready_at_startup: false,
              failure_code: "missing-credential",
            },
          ],
        },
        status: (signal) => {
          if (failNextReadiness) {
            failNextReadiness = false;
            throw new Error("synthetic temporary readiness failure");
          }
          return owner.status(signal);
        },
        read: (signal) => owner.read(signal),
        publishConfiguration: async (
          configuration,
          baseline,
          sections,
          signal,
        ) => {
          const published = await owner.publishConfiguration(
            configuration,
            baseline,
            sections,
            signal,
          );
          if (armReadinessFailureAfterPublish) {
            armReadinessFailureAfterPublish = false;
            failNextReadiness = true;
          }
          return published;
        },
        credential: (edit, baseline, signal) =>
          owner.credential(edit, baseline, signal),
        probe: probes,
      },
      assets: await assets(),
    });
    const browser = await chromium.launch({
      executablePath:
        process.env.SCIRETRIEVER_BROWSER_EXECUTABLE ??
        "/home/duanjw/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome",
      headless: true,
    });
    try {
      const page = await browser.newPage({
        viewport: { width: 1280, height: 900 },
      });
      const failures: string[] = [];
      page.on("pageerror", (error) => failures.push(error.message));
      await page.goto(`${server.origin}/?workspace=configuration`);
      await expect
        .poll(() => page.locator("#config-workspace").isVisible())
        .toBe(true);
      await expect
        .poll(() => page.locator("#config-page-status").textContent())
        .toContain("配置版本");
      await expect
        .poll(() => page.locator("#config-runtime-status").textContent())
        .toContain("core");
      expect(
        await page.locator("#config-runtime-status").getAttribute("data-state"),
      ).toBe("restart-required");

      await page.locator("#config-metadata-mode").selectOption("custom");
      await page
        .locator('#config-metadata-providers input[value="crossref"]')
        .check();
      await page.locator("#config-metadata-limit").fill("501");
      await page
        .locator("#config-browser-profile")
        .fill("draft-from-other-form");
      const beforeLimitSave = await owner.read();
      armReadinessFailureAfterPublish = true;
      const limitSaveResponse = page.waitForResponse((response) =>
        response.url().includes("/api/configuration/publish-json"),
      );
      await page.locator("#source-config-save").click();
      expect((await limitSaveResponse).status()).toBe(200);
      await expect
        .poll(() => page.locator("#config-page-status").textContent())
        .toContain("状态读取失败");
      const limitSaved = await owner.read();
      expect(limitSaved.revision).not.toBe(beforeLimitSave.revision);
      expect(limitSaved.configuration.sources.metadata).toMatchObject({
        providers: ["openalex", "crossref"],
        limit: 501,
      });
      expect(await page.locator("#config-browser-profile").inputValue()).toBe(
        "draft-from-other-form",
      );
      await expect
        .poll(() => page.locator("#source-config-save").isEnabled())
        .toBe(true);

      await page
        .locator('#config-metadata-providers input[value="web-of-science"]')
        .check();
      await page.locator("#config-metadata-limit").fill("37");
      await page.locator("#config-wos-product").selectOption("expanded");
      await page.locator("#config-wos-database").fill("WOS-Synthetic");
      await page.locator("#config-wos-edition").fill("2026");
      await page.locator("#config-acquisition-mode").selectOption("auto");
      const sourceSaveResponse = page.waitForResponse((response) =>
        response.url().includes("/api/configuration/publish-json"),
      );
      await page.locator("#source-config-save").click();
      const sourceSave = await sourceSaveResponse;
      expect(sourceSave.status(), await sourceSave.text()).toBe(200);
      await expect
        .poll(() => page.locator("#config-page-status").textContent())
        .toContain("来源配置已保存");
      const autoSources = await owner.read();
      expect(autoSources.configuration.sources).toMatchObject({
        metadata: {
          mode: "custom",
          providers: ["openalex", "crossref", "web-of-science"],
          limit: 37,
          web_of_science: {
            product: "expanded",
            database: "WOS-Synthetic",
            edition: "2026",
          },
        },
        acquisition: { mode: "auto", providers: [] },
      });

      await page.locator("#config-acquisition-mode").selectOption("custom");
      await page
        .locator('#config-acquisition-providers input[value="unpaywall"]')
        .check();
      await page
        .locator("#config-unpaywall-contact")
        .fill("research@example.org");
      const unpaywallSaveResponse = page.waitForResponse((response) =>
        response.url().includes("/api/configuration/publish-json"),
      );
      await page.locator("#source-config-save").click();
      expect((await unpaywallSaveResponse).status()).toBe(200);
      const savedSources = await owner.read();
      expect(savedSources.configuration.sources).toMatchObject({
        metadata: {
          mode: "custom",
          providers: ["openalex", "crossref", "web-of-science"],
          limit: 37,
          web_of_science: {
            product: "expanded",
            database: "WOS-Synthetic",
            edition: "2026",
          },
        },
        acquisition: {
          mode: "custom",
          providers: ["unpaywall"],
          unpaywall: { contact_email: "research@example.org" },
        },
      });
      expect(savedSources.configuration.providers).toHaveProperty("fixture");
      expect(savedSources.configuration.models).toHaveProperty(
        "fixture/vision",
      );
      await expect
        .poll(() => page.locator("#config-runtime-status").textContent())
        .toContain("普通配置已保存");
      expect(
        await page.locator("#config-runtime-status").getAttribute("data-state"),
      ).toBe("restart-required");

      const afterSourceSave = savedSources.revision;
      await page.locator("#config-wos-database").fill("");
      await page.locator("#source-config-save").click();
      await expect
        .poll(() => page.locator("#config-page-status").textContent())
        .toContain("产品和数据库");
      expect((await owner.read()).revision).toBe(afterSourceSave);
      expect((await owner.read()).configuration.sources.metadata).toMatchObject(
        {
          limit: 37,
          web_of_science: { database: "WOS-Synthetic" },
        },
      );
      await page.locator("#config-wos-database").fill("WOS-Synthetic");

      const externalSources = await owner.read();
      const changedSources = structuredClone(externalSources.configuration);
      (
        changedSources.sources as {
          metadata: { limit: number };
        }
      ).metadata.limit = 88;
      await owner.publishConfiguration(
        changedSources,
        externalSources.revision,
        ["sources"],
      );
      await page.locator("#config-metadata-limit").fill("43");
      await page.locator("#source-config-save").click();
      await expect
        .poll(() => page.locator("#config-page-status").textContent())
        .toContain("revision 冲突");
      expect(await page.locator("#config-metadata-limit").inputValue()).toBe(
        "43",
      );
      expect((await owner.read()).configuration.sources.metadata.limit).toBe(
        88,
      );
      await page.locator("#config-refresh").click();
      await expect
        .poll(() => page.locator("#config-metadata-limit").inputValue())
        .toBe("88");

      await page.locator("#config-browser-profile").fill("web-fixture");
      await page.locator("#config-parser-url").fill("http://127.0.0.1:8000");
      await page.locator("#config-parser-mode").selectOption("loopback");
      await page.locator("#config-parser-model").fill("synthetic-parser");
      await page.locator("#config-save").click();
      await expect
        .poll(() => page.locator("#config-page-status").textContent())
        .toContain("配置已保存");
      await expect
        .poll(() => page.locator("#config-runtime-status").textContent())
        .toContain("普通配置已保存");
      await expect
        .poll(async () => (await owner.read()).configuration)
        .toMatchObject({
          browser: { profile: "web-fixture" },
          parsing: {
            base_url: "http://127.0.0.1:8000",
            connection_mode: "loopback",
            model_identity: "synthetic-parser",
          },
        });

      const external = await owner.read();
      const externalConfiguration = structuredClone(external.configuration);
      (
        externalConfiguration as { browser: { profile: string | null } }
      ).browser.profile = "external-change";
      await owner.publishConfiguration(
        externalConfiguration,
        external.revision,
        ["browser"],
      );
      await page
        .locator("#config-browser-profile")
        .fill("draft-after-conflict");
      await page.locator("#config-save").click();
      await expect
        .poll(() => page.locator("#config-page-status").textContent())
        .toContain("草稿仍保留");
      expect(await page.locator("#config-browser-profile").inputValue()).toBe(
        "draft-after-conflict",
      );

      const revisionBeforeProbes = (await owner.read()).revision;
      await page.locator("#config-probe-parse").click();
      await expect
        .poll(() => page.locator("#config-page-status").textContent())
        .toContain("Parse 测试：passed");
      await page.locator("#config-probe-browser").click();
      await expect
        .poll(() => page.locator("#config-page-status").textContent())
        .toContain("Browser 模型测试：passed");
      expect(probes.mock.calls.map(([request]) => request.owner)).toEqual([
        "parse",
        "browser-model",
      ]);
      expect((await owner.read()).revision).toBe(revisionBeforeProbes);

      await page.locator("#config-refresh").click();
      await expect
        .poll(() => page.locator("#config-browser-profile").inputValue())
        .toBe("external-change");

      const secret = "synthetic-ui-secret-never-rendered";
      await page.locator("#config-credential-namespace").selectOption("model");
      await page.locator("#config-credential-target").fill("fixture");
      await page.locator("#config-credential-value").fill(secret);
      await page.locator("#config-credential-save").click();
      await expect
        .poll(() => page.locator("#config-page-status").textContent())
        .toContain("凭据已保存");
      await expect
        .poll(() => page.locator("#config-runtime-status").textContent())
        .toContain("下一次外部请求");
      const runtimeStatus = await page
        .locator("#config-runtime-status")
        .textContent();
      expect(runtimeStatus).toContain("普通配置已保存");
      expect(runtimeStatus).toContain("重启服务后生效");
      expect(
        await page.locator("#config-runtime-status").getAttribute("data-state"),
      ).toBe("restart-required");
      expect((await owner.status()).credentials.models).toContainEqual({
        target: "fixture",
        present: true,
      });
      expect(await page.locator("#config-credential-value").inputValue()).toBe(
        "",
      );
      expect(await page.content()).not.toContain(secret);
      expect(
        await page.evaluate(
          () => `${location.href}\n${JSON.stringify(history.state)}`,
        ),
      ).not.toContain(secret);

      await page.locator("#library-tab").click();
      await expect
        .poll(() => page.locator("#library-workspace").isVisible())
        .toBe(true);
      await page.goBack();
      await expect
        .poll(() => page.locator("#config-workspace").isVisible())
        .toBe(true);
      await page.setViewportSize({ width: 390, height: 844 });
      await expect
        .poll(() =>
          page.evaluate(
            () => document.documentElement.scrollWidth <= window.innerWidth,
          ),
        )
        .toBe(true);
      expect(
        await page.evaluate(() =>
          [...document.querySelectorAll<HTMLElement>("body *")]
            .filter(
              (element) =>
                !element.hidden &&
                element.getBoundingClientRect().right > window.innerWidth + 1,
            )
            .map((element) => ({
              id: element.id,
              className: element.className,
              right: Math.round(element.getBoundingClientRect().right),
            })),
        ),
      ).toEqual([]);
      expect(failures).toEqual([]);

      const fallback = await browser.newPage();
      await fallback.goto(`${server.origin}/?workspace=unknown`);
      await expect
        .poll(() => fallback.locator("#live-workspace").isVisible())
        .toBe(true);
      expect(new URL(fallback.url()).searchParams.has("workspace")).toBe(false);
      await fallback.close();
    } finally {
      await browser.close();
      await server.close();
      await session.close();
      await rm(home, { recursive: true, force: true });
    }
  });

  it("registers an empty Provider/Model catalog, binds Browser and probes the saved Model through a fake transport", async () => {
    const home = await mkdtemp(
      join(tmpdir(), "sciretriever-config-registry-ui-"),
    );
    const owner = new TypeScriptConfigurationOwner(home);
    let server: Awaited<ReturnType<typeof startWorkbenchHttp>> | undefined;
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
    const session = fixtureSession();
    const wireCalls: Array<{
      readonly endpoint: string;
      readonly model: unknown;
      readonly authorization: string | undefined;
    }> = [];
    const apiKey = "synthetic-provider-key-never-rendered";
    const transport: AgentTransport = async (
      request,
    ): Promise<AgentTransportResponse> => {
      const wire = JSON.parse(new TextDecoder().decode(request.body)) as Record<
        string,
        unknown
      >;
      wireCalls.push({
        endpoint: request.endpoint,
        model: wire.model,
        authorization: request.headers.find(
          ([name]) => name.toLowerCase() === "authorization",
        )?.[1],
      });
      return {
        status: 200,
        headers: [["content-type", "application/json"]],
        body: new TextEncoder().encode(
          JSON.stringify({
            object: "response",
            status: "completed",
            model:
              typeof wire.model === "string" ? wire.model : "remote-vision",
            output: [
              {
                type: "function_call",
                name: "sciretriever_probe_stop",
                arguments: '{"received":true}',
              },
            ],
            usage: { input_tokens: 4, output_tokens: 2 },
          }),
        ),
      };
    };
    try {
      const initial = await owner.read();
      expect(initial.configuration.providers).toEqual({});
      expect(initial.configuration.models).toEqual({});
      await session.refresh();
      server = await startWorkbenchHttp({
        session,
        configuration: {
          runtime_revision: initial.revision,
          status: (signal) => owner.status(signal),
          read: (signal) => owner.read(signal),
          publishConfiguration: (configuration, baseline, sections, signal) =>
            owner.publishConfiguration(
              configuration,
              baseline,
              sections,
              signal,
            ),
          credential: (edit, baseline, signal) =>
            owner.credential(edit, baseline, signal),
          probe: async (request, signal) => {
            const probe = await ConfigurationProbeSession.create(owner, {
              agent_transport: () => transport,
            });
            try {
              return await probe.run(request, {
                authorized: true,
                ...(signal ? { signal } : {}),
              });
            } finally {
              probe.close();
            }
          },
        },
        assets: await assets(),
      });
      browser = await chromium.launch({
        executablePath:
          process.env.SCIRETRIEVER_BROWSER_EXECUTABLE ??
          "/home/duanjw/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome",
        headless: true,
      });
      const page = await browser.newPage();
      await page.goto(`${server.origin}/?workspace=configuration`);
      await expect
        .poll(() => page.locator("#config-page-status").textContent())
        .toContain("配置版本");
      expect(await page.locator(".provider-row").count()).toBe(0);
      expect(await page.locator(".model-row").count()).toBe(0);

      await page.locator("#config-metadata-limit").fill("777");
      await page.locator("#provider-add").click();
      const providerRow = page.locator(".provider-row").first();
      await providerRow.locator(".provider-name").fill("vision-fixture");
      await providerRow
        .locator(".provider-api")
        .selectOption("openai-responses");
      await providerRow
        .locator(".provider-base-url")
        .fill("https://provider.example.test/v1");
      await page.locator("#model-add").click();
      const modelRow = page.locator(".model-row").first();
      await modelRow.locator(".model-provider").selectOption("vision-fixture");
      await modelRow.locator(".model-name").fill("remote-vision");
      await modelRow.locator(".model-reasoning").selectOption("low");
      await modelRow.locator(".model-image").check();
      await modelRow.locator(".model-stream").uncheck();
      const registrationResponse = page.waitForResponse((response) =>
        response.url().includes("/api/configuration/publish-json"),
      );
      await page.locator("#provider-model-save").click();
      expect((await registrationResponse).status()).toBe(200);
      await expect
        .poll(() => page.locator("#config-page-status").textContent())
        .toContain("Provider/Model 已保存");
      const registered = await owner.read();
      expect(registered.configuration.providers).toMatchObject({
        "vision-fixture": {
          api: "openai-responses",
          base_url: "https://provider.example.test/v1",
        },
      });
      expect(registered.configuration.models).toMatchObject({
        "vision-fixture/remote-vision": {
          reasoning: "low",
          image: true,
          stream: false,
        },
      });
      expect(await page.locator("#config-metadata-limit").inputValue()).toBe(
        "777",
      );
      expect(registered.configuration.sources.metadata.limit).toBe(500);
      expect(
        await page.locator("#config-runtime-status").getAttribute("data-state"),
      ).toBe("restart-required");

      await page
        .locator("#config-browser-model")
        .selectOption("vision-fixture/remote-vision");
      await page.locator("#config-browser-enabled").check();
      await page.locator("#config-browser-profile").fill("synthetic-profile");
      const runtimeResponse = page.waitForResponse((response) =>
        response.url().includes("/api/configuration/publish-json"),
      );
      await page.locator("#config-save").click();
      expect((await runtimeResponse).status()).toBe(200);
      await expect
        .poll(() => page.locator("#config-page-status").textContent())
        .toContain("配置已保存");
      expect((await owner.read()).configuration.browser).toMatchObject({
        enabled: true,
        profile: "synthetic-profile",
        model: "vision-fixture/remote-vision",
      });
      expect(await page.locator("#config-metadata-limit").inputValue()).toBe(
        "777",
      );

      const current = await owner.read();
      await owner.credential(
        {
          namespace: "model",
          target: "vision-fixture",
          kind: "set",
          value: apiKey,
        },
        current.revision,
      );
      await page.locator("#config-probe-browser").click();
      await expect
        .poll(() => page.locator("#config-page-status").textContent())
        .toContain("Browser 模型测试：passed");
      expect(wireCalls).toHaveLength(1);
      expect(wireCalls[0]).toMatchObject({
        endpoint: "https://provider.example.test/v1/responses",
        model: "remote-vision",
        authorization: `Bearer ${apiKey}`,
      });
      expect(await page.content()).not.toContain(apiKey);
      expect(JSON.stringify(await owner.read())).not.toContain(apiKey);

      const beforeDuplicate = (await owner.read()).revision;
      await page.locator("#provider-add").click();
      const duplicate = page.locator(".provider-row").nth(1);
      await duplicate.locator(".provider-name").fill("vision-fixture");
      await duplicate.locator(".provider-api").selectOption("openai-responses");
      await duplicate
        .locator(".provider-base-url")
        .fill("https://duplicate.example.test/v1");
      await page.locator("#provider-model-save").click();
      await expect
        .poll(() => page.locator("#config-page-status").textContent())
        .toContain("Provider 名称重复");
      expect((await owner.read()).revision).toBe(beforeDuplicate);
      await page.locator("#config-refresh").click();
      await expect.poll(() => page.locator(".provider-row").count()).toBe(1);

      await page
        .locator(".provider-base-url")
        .fill("https://provider.example.test/v2");
      const providerEditResponse = page.waitForResponse((response) =>
        response.url().includes("/api/configuration/publish-json"),
      );
      await page.locator("#provider-model-save").click();
      expect((await providerEditResponse).status()).toBe(200);
      expect((await owner.read()).configuration.providers).toMatchObject({
        "vision-fixture": { base_url: "https://provider.example.test/v2" },
      });

      await page.locator("#config-browser-model").selectOption("");
      const beforeReferencedModelEdit = (await owner.read()).revision;
      await page.locator(".model-name").fill("remote-vision-v2");
      await page.locator("#provider-model-save").click();
      await expect
        .poll(() => page.locator("#config-page-status").textContent())
        .toContain("当前保存的 Browser 配置仍引用");
      expect((await owner.read()).revision).toBe(beforeReferencedModelEdit);

      const clearTaskResponse = page.waitForResponse((response) =>
        response.url().includes("/api/configuration/publish-json"),
      );
      await page.locator("#config-save").click();
      expect((await clearTaskResponse).status()).toBe(200);
      await page.locator("#provider-model-save").click();
      await expect
        .poll(() => page.locator("#config-page-status").textContent())
        .toContain("Provider/Model 已保存");
      expect((await owner.read()).configuration.models).toHaveProperty(
        "vision-fixture/remote-vision-v2",
      );

      await page
        .locator("#config-browser-model")
        .selectOption("vision-fixture/remote-vision-v2");
      await page.locator("#config-save").click();
      await expect
        .poll(() => page.locator("#config-page-status").textContent())
        .toContain("配置已保存");
      await page.locator("#config-probe-browser").click();
      await expect
        .poll(() => page.locator("#config-page-status").textContent())
        .toContain("Browser 模型测试：passed");
      expect(wireCalls[1]).toMatchObject({
        endpoint: "https://provider.example.test/v2/responses",
        model: "remote-vision-v2",
        authorization: `Bearer ${apiKey}`,
      });
      await page.locator(".model-row button").click();
      await expect
        .poll(() => page.locator("#config-page-status").textContent())
        .toContain("先调整并保存任务模型");
      await page.locator(".provider-row button").click();
      await expect
        .poll(() => page.locator("#config-page-status").textContent())
        .toContain("Provider 仍被 Model");
      expect((await owner.read()).configuration.providers).toHaveProperty(
        "vision-fixture",
      );

      await page.locator("#config-browser-model").selectOption("");
      await page.locator("#config-save").click();
      await expect
        .poll(() => page.locator("#config-page-status").textContent())
        .toContain("配置已保存");
      await page.locator(".model-row button").click();
      expect(await page.locator(".model-row").count()).toBe(0);
      await page.locator("#provider-model-save").click();
      await expect
        .poll(() => page.locator("#config-page-status").textContent())
        .toContain("Provider/Model 已保存");
      expect((await owner.read()).configuration.models).toEqual({});
      await page.locator(".provider-row button").click();
      expect(await page.locator(".provider-row").count()).toBe(0);
      await page.locator("#provider-model-save").click();
      await expect
        .poll(() => page.locator("#config-page-status").textContent())
        .toContain("Provider/Model 已保存");
      expect((await owner.read()).configuration.providers).toEqual({});
    } finally {
      await browser?.close();
      await server?.close();
      await session.close();
      await rm(home, { recursive: true, force: true });
    }
  });
});
