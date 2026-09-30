import { BrowserNetworkProxy } from "../src/network/browser-proxy.js";
import { NetworkBudgetCoordinator } from "../src/network/budget.js";
import { resolveDestination } from "../src/network/policy.js";
import { createServer, type Server } from "node:http";
import { existsSync } from "node:fs";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BrowserHost, BrowserHostError } from "../src/browser/host.js";
import { BrowserPageRuntimeError } from "../src/browser/page-runtime.js";
import { createBrowserArticleFlow } from "../src/browser/article-flow.js";
import { BrowserObservationStore } from "../src/browser/observation.js";
import { WorkbenchSession } from "../src/workbench/session.js";
import { sha256 } from "@sciretriever/contracts";

const cachedBrowser =
  process.env.SCIRETRIEVER_BROWSER_EXECUTABLE ??
  "/home/duanjw/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome";
const browserAvailable = existsSync(cachedBrowser);
const created: string[] = [];
const servers: Server[] = [];

async function profile(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "sciretriever-browser-profile-"));
  created.push(value);
  return value;
}

async function fixture(): Promise<string> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<title>synthetic browser page</title><main>fixture</main>");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("fixture failed");
  return `http://127.0.0.1:${address.port}/article`;
}

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
  );
  await Promise.all(
    created.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("persistent browser profile host", () => {
  it.skipIf(!browserAvailable)(
    "rejects a late production model action after real Browser navigation",
    async () => {
      const url = await fixture();
      const host = new BrowserHost({
        profile: await profile(),
        executablePath: cachedBrowser,
        headless: true,
        admitNavigation: async (requested) => requested,
      });
      await host.start();
      try {
        const page = await host.openPage(url);
        let finishModel: ((action: unknown) => void) | undefined;
        const session = new WorkbenchSession(
          "article-1",
          page,
          {
            max_actions: 3,
            max_model_calls: 3,
            max_retries: 3,
            max_bytes: 10000,
            deadline_ms: 30000,
          },
          () =>
            new Promise((resolve) => {
              finishModel = resolve;
            }),
          "session-real-navigation",
          async () => {},
          undefined,
          undefined,
          undefined,
          true,
        );
        await session.refresh();
        const pending = session.runAutomaticStep(new AbortController().signal);
        await vi.waitFor(() => expect(finishModel).toBeDefined());
        const observation = session.view().observation!;
        await page.navigate!(`${url}?new-document=1`);
        await expect
          .poll(async () => (await page.snapshot()).document_generation)
          .toBeGreaterThan(observation.document_generation);
        finishModel!({
          kind: "go-back",
          revision: observation.observation_revision,
        });
        await expect(pending).rejects.toBeInstanceOf(BrowserPageRuntimeError);
        await session.close();
      } finally {
        await host.close();
      }
    },
    30_000,
  );
  it.skipIf(!browserAvailable)(
    "opens an admitted loopback page and closes before profile reuse",
    async () => {
      const root = await profile();
      const url = await fixture();
      const admitted: string[] = [];
      const host = new BrowserHost({
        profile: root,
        executablePath: cachedBrowser,
        headless: true,
        admitNavigation: (requested) => {
          admitted.push(requested);
          return requested;
        },
      });
      await host.start();
      const page = await host.openPage(`${url}?secret=must-not-be-navigated`);
      expect(
        admitted.filter((value) => value === url).length,
      ).toBeGreaterThanOrEqual(2);
      await expect(page.title()).resolves.toBe("synthetic browser page");
      expect(page.url()).toBe(url);
      await page.navigate!(url);
      expect(
        admitted.filter((value) => value === url).length,
      ).toBeGreaterThanOrEqual(3);
      expect(host.diagnostics()).toMatchObject({
        status: "ready",
        service_workers: "blocked",
      });
      await page.close();
      await expect(page.snapshot()).rejects.toBeDefined();
      await host.close();
      expect(host.diagnostics()).toMatchObject({
        status: "closed",
        page_count: 0,
      });

      const reopened = new BrowserHost({
        profile: root,
        executablePath: cachedBrowser,
        headless: true,
      });
      await reopened.start();
      expect(reopened.bootId).not.toBe(host.bootId);
      expect(reopened.diagnostics().boot_id).toBe(reopened.bootId);
      await reopened.close();
    },
    30_000,
  );

  it.skipIf(!browserAvailable)(
    "holds one lock for a profile across independent hosts",
    async () => {
      const root = await profile();
      const first = new BrowserHost({
        profile: root,
        executablePath: cachedBrowser,
        headless: true,
      });
      await first.start();
      const second = new BrowserHost({
        profile: root,
        executablePath: cachedBrowser,
        headless: true,
      });
      await expect(second.start()).rejects.toBeInstanceOf(BrowserHostError);
      expect(second.diagnostics()).toMatchObject({
        status: "failed",
        code: "profile-lock",
      });
      await first.close();
    },
    30_000,
  );

  it("rejects a symlink profile and an invalid executable before browser actions", async () => {
    const real = await profile();
    const linkParent = await mkdtemp(
      join(tmpdir(), "sciretriever-browser-link-"),
    );
    created.push(linkParent);
    const link = join(linkParent, "profile");
    await symlink(real, link);
    const host = new BrowserHost({ profile: link, headless: true });
    await expect(host.start()).rejects.toBeInstanceOf(BrowserHostError);
    expect(host.diagnostics()).toMatchObject({ status: "failed" });

    const invalidHost = new BrowserHost({
      profile: await profile(),
      executablePath: "/does/not/exist",
      headless: true,
    });
    await expect(invalidHost.start()).rejects.toBeInstanceOf(BrowserHostError);
    expect(invalidHost.diagnostics()).toMatchObject({
      status: "failed",
      code: "launch",
    });
  });

  it.skipIf(!browserAvailable)(
    "rejects credentials, fragments and non-http navigation",
    async () => {
      const host = new BrowserHost({
        profile: await profile(),
        executablePath: cachedBrowser,
        headless: true,
      });
      await host.start();
      await expect(
        host.openPage("https://user:password@example.test/a"),
      ).rejects.toBeInstanceOf(BrowserHostError);
      await expect(
        host.openPage("https://example.test/a#fragment"),
      ).rejects.toBeInstanceOf(BrowserHostError);
      await expect(host.openPage("file:///tmp/secret")).rejects.toBeInstanceOf(
        BrowserHostError,
      );
      await host.close();
    },
  );
  it("uses the admitted proxy for real snapshots and rejects stale element or control inputs", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(
        '<title>Runtime fixture</title><main><input aria-label="Search"><button>Apply</button><output>idle</output><a href="/article">Reload</a><input type="file"></main><script>document.querySelector("button").onclick=()=>document.querySelector("output").textContent="clicked"</script>',
      );
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    servers.push(server);
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("fixture");
    const resolver = () => ["127.0.0.1"];
    const policy = {
      allowed_schemes: ["http"] as const,
      allowed_classes: ["loopback"] as const,
      allowed_addresses: ["127.0.0.1"],
      allowed_ports: [{ scheme: "http" as const, port: address.port }],
    };
    const proxy = new BrowserNetworkProxy({
      resolver,
      policy,
      coordinator: new NetworkBudgetCoordinator(),
      limits: {
        maxConcurrency: 4,
        maxHostConcurrency: 4,
        maxResponseBytes: 1000000,
        maxRedirects: 0,
        maxRetries: 0,
      },
    });
    const connection = await proxy.start();
    const host = new BrowserHost({
      profile: await profile(),
      executablePath: cachedBrowser,
      headless: true,
      proxy: connection,
      admitNavigation: async (url) =>
        (await resolveDestination(url, resolver, policy)).url.url,
    });
    try {
      await host.start();
      const page = await host.openPage(
        `http://fixture.test:${address.port}/article`,
      );
      const first = await page.snapshot();
      expect(first.screenshot!.byteLength).toBeGreaterThan(100);
      expect(first.text).toContain("idle");
      const button = first.elements?.find(
        (element) => element.name === "Apply",
      );
      expect(button).toBeDefined();
      const generation = first.document_generation!;
      await expect(
        page.apply(
          {
            kind: "click-element",
            element_id: button!.element_id,
            revision: 1,
          },
          generation,
          () => false,
        ),
      ).rejects.toBeDefined();
      await page.apply(
        { kind: "click-element", element_id: button!.element_id, revision: 1 },
        generation,
        () => true,
      );
      const second = await page.snapshot();
      expect(second.text).toContain("clicked");
      await expect(
        page.apply(
          {
            kind: "click-element",
            element_id: button!.element_id,
            revision: 1,
          },
          generation,
          () => true,
        ),
      ).rejects.toBeDefined();
      const reload = second.elements!.find(
        (element) => element.name === "Reload",
      )!;
      await page.apply(
        { kind: "click-element", element_id: reload.element_id, revision: 2 },
        generation,
        () => true,
      );
      await expect
        .poll(async () => (await page.snapshot()).document_generation)
        .toBeGreaterThan(generation);
      await expect(
        page.apply(
          { kind: "press-key", key: "Enter", revision: 2 },
          generation,
          () => true,
        ),
      ).rejects.toBeDefined();
    } finally {
      await host.close();
      await proxy.close();
    }
  }, 30000);

  it.skipIf(!browserAvailable)(
    "ignores a blocked third-party iframe but fails a blocked article navigation",
    async () => {
      const requests: string[] = [];
      const server = createServer((request, response) => {
        requests.push(request.url ?? "");
        response.writeHead(200, { "content-type": "text/html" });
        response.end(
          "<title>Article</title><main><button>Open PDF</button></main>" +
            '<iframe src="http://blocked.test/advert"></iframe>' +
            '<script>document.querySelector("button").onclick=()=>{location.href="http://blocked.test/document"}</script>',
        );
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      servers.push(server);
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("fixture");
      const resolver = () => ["127.0.0.1"];
      const policy = {
        allowed_schemes: ["http"] as const,
        allowed_classes: ["loopback"] as const,
        allowed_addresses: ["127.0.0.1"],
        allowed_ports: [{ scheme: "http" as const, port: address.port }],
      };
      const proxy = new BrowserNetworkProxy({
        resolver,
        policy,
        coordinator: new NetworkBudgetCoordinator(),
        limits: {
          maxConcurrency: 4,
          maxHostConcurrency: 4,
          maxResponseBytes: 1_000_000,
          maxRedirects: 0,
          maxRetries: 0,
        },
      });
      const connection = await proxy.start();
      const host = new BrowserHost({
        profile: await profile(),
        executablePath: cachedBrowser,
        headless: true,
        proxy: connection,
        admitNavigation: async (url) => {
          if (new URL(url).hostname !== "fixture.test")
            throw new Error("outside article origin");
          return (await resolveDestination(url, resolver, policy)).url.url;
        },
      });
      try {
        await host.start();
        const articleUrl = `http://fixture.test:${address.port}/article`;
        const page = await host.openPage(articleUrl);
        await new Promise((resolve) => setTimeout(resolve, 100));
        const first = await page.snapshot();
        expect(first.title).toBe("Article");
        expect(requests).toContain("/article");
        expect(requests).not.toContain("/advert");
        const button = first.elements?.find(
          (element) => element.name === "Open PDF",
        );
        expect(button).toBeDefined();
        await page
          .apply(
            {
              kind: "click-element",
              element_id: button!.element_id,
              revision: 1,
            },
            first.document_generation!,
            () => true,
          )
          .catch(() => undefined);
        await expect
          .poll(async () => {
            try {
              await page.snapshot();
              return false;
            } catch {
              return true;
            }
          })
          .toBe(true);
        const flow = createBrowserArticleFlow({
          pages: {
            openPage: async () => ({ page, close: () => page.close() }),
          },
          decide: async () => ({ kind: "stop", reason: "user" }),
          observations: new BrowserObservationStore(),
          session_id: "blocked-navigation-test",
          awaitCandidate: async () => null,
        });
        await expect(
          flow.deliver({
            literature_id: "00000000-0000-0000-0000-000000000001",
            identifier: "doi:10.5555/fixture",
            version: "published",
            start_url: articleUrl,
            metadata_snapshot: {
              revision: 1,
              sha256: await sha256(new Uint8Array()),
            },
            signal: new AbortController().signal,
          }),
        ).resolves.toMatchObject({
          kind: "refused",
          code: "browser-flow-failed",
        });
      } finally {
        await host.close();
        await proxy.close();
      }
    },
    30_000,
  );
});
