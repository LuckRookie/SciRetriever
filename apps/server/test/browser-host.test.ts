import { BrowserNetworkProxy } from "../src/network/browser-proxy.js";
import { NetworkBudgetCoordinator } from "../src/network/budget.js";
import { resolveDestination } from "../src/network/policy.js";
import { createServer, type Server } from "node:http";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { chromium, type BrowserContext } from "playwright";

import {
  BrowserHost,
  BrowserHostError,
  BrowserHostNavigationError,
} from "../src/browser/host.js";
import {
  BrowserPageRuntimeError,
  BrowserPageTransitionError,
} from "../src/browser/page-runtime.js";
import { createBrowserArticleFlow } from "../src/browser/article-flow.js";
import { createProductionBrowserHostFactory } from "../src/browser/production-host.js";
import type {
  BrowserArticleFlowPageSource,
  BrowserDeliveryRequest,
} from "../src/browser/boundary.js";
import { BrowserObservationStore } from "../src/browser/observation.js";
import { WorkbenchSession } from "../src/workbench/session.js";
import { sha256 } from "@sciretriever/contracts";
import { verifyInstalledCloakRuntime } from "../src/configuration/cloak-runtime.js";

const bundle = process.env.SCIRETRIEVER_CLOAK_BUNDLE;
async function fixtureLaunch() {
  const runtime = bundle
    ? await verifyInstalledCloakRuntime(bundle)
    : undefined;
  return {
    options: runtime
      ? { runtime }
      : { executablePath: cachedBrowser, headless: true },
    version: runtime?.version ?? "stock-chromium",
  };
}
async function saveHostEvidence(
  evidence: Record<string, unknown>,
): Promise<void> {
  if (!bundle) return;
  const directory = await mkdtemp(
    join(tmpdir(), "sciretriever-browser-host-evidence-"),
  );
  await writeFile(
    join(directory, "events.json"),
    JSON.stringify(evidence, null, 2),
  );
  console.info("Synthetic Host navigation evidence:", directory);
}

const cachedBrowser =
  process.env.SCIRETRIEVER_BROWSER_EXECUTABLE ?? chromium.executablePath();
const browserAvailable = existsSync(cachedBrowser);
const created: string[] = [];
const servers: Server[] = [];

async function profile(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "sciretriever-browser-profile-"));
  created.push(value);
  return value;
}

async function fixture(requests?: string[]): Promise<string> {
  const server = createServer((request, response) => {
    requests?.push(request.url ?? "");
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
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
          // These servers are owned fixtures; do not leave keep-alive sockets
          // behind after a failed or interrupted browser action.
          server.closeAllConnections();
        }),
    ),
  );
  await Promise.all(
    created.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("persistent browser profile host", () => {
  it.skipIf(!browserAvailable && !bundle)(
    "uses the observed context terminal when a concurrent close command rejects",
    async () => {
      const launch = await fixtureLaunch();
      const launchContext = chromium.launchPersistentContext.bind(chromium);
      let context: BrowserContext | undefined;
      const launchSpy = vi
        .spyOn(chromium, "launchPersistentContext")
        .mockImplementationOnce(async (...args) => {
          context = await launchContext(...args);
          return context;
        });
      const host = new BrowserHost({
        profile: await profile(),
        ...launch.options,
      });
      try {
        await host.start();
      } finally {
        launchSpy.mockRestore();
      }
      const closeContext = context!.close.bind(context);
      let terminalObserved = false;
      context!.once("close", () => {
        terminalObserved = true;
      });
      const closeSpy = vi
        .spyOn(context!, "close")
        .mockImplementation(async () => {
          await closeContext();
          expect(terminalObserved).toBe(true);
          throw new Error(
            "Synthetic close RPC rejected after context terminal",
          );
        });
      try {
        await host.close();
        expect(terminalObserved).toBe(true);
        expect(host.diagnostics().status).toBe("closed");
        await host.close();
        expect(closeSpy).toHaveBeenCalledTimes(1);
      } finally {
        closeSpy.mockRestore();
        await closeContext();
      }
    },
    30_000,
  );

  it.skipIf(!browserAvailable && !bundle)(
    "closes a hung initial production page open at its budget while another article remains usable",
    async () => {
      const launch = await fixtureLaunch();
      const requests: string[] = [];
      const server = createServer((request, response) => {
        requests.push(request.url ?? "");
        if (request.url === "/pending") return;
        response.writeHead(200, { "content-type": "text/html" });
        response.end(
          "<title>Healthy article</title><main>Independent session</main>",
        );
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      servers.push(server);
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("fixture");
      const origin = `http://127.0.0.1:${address.port}`;
      let host: BrowserHost | undefined;
      let source: BrowserArticleFlowPageSource | undefined;
      const decide = vi.fn(
        async () => ({ kind: "stop", reason: "user" }) as const,
      );
      const factory = createProductionBrowserHostFactory({
        runtime:
          "runtime" in launch.options ? launch.options.runtime : undefined,
        admitNavigation: (url) => {
          if (new URL(url).origin !== origin) throw new BrowserHostError();
          return url;
        },
        host_seam: (options) => {
          host = new BrowserHost({ ...options, ...launch.options });
          return host;
        },
        article_flow_factory: (pages) => {
          source = pages;
          return createBrowserArticleFlow({
            pages,
            decide,
            session_id: "opening-a",
            deadline_ms: 500,
          });
        },
      });
      const production = factory({ profile: await profile() })!;
      const ownerSignal = new AbortController().signal;
      const metadata = {
        revision: 1,
        sha256: await sha256(new Uint8Array([1])),
      };
      const makeRequest = (
        name: string,
        path: string,
      ): BrowserDeliveryRequest => {
        const literatureId =
          name === "a"
            ? "00000000-0000-0000-0000-000000000031"
            : "00000000-0000-0000-0000-000000000032";
        return {
          literature_id: literatureId,
          identifier: `doi:10.5555/opening-${name}`,
          version: "published",
          metadata_snapshot: metadata,
          start_url: origin + path,
          signal: ownerSignal,
          operation_id: "opening-budget-fixture",
          generation: 1,
          session_identity: {
            session_id: "opening-" + name,
            operation_id: "opening-budget-fixture",
            literature_id: literatureId,
            generation: 1,
            metadata_snapshot: metadata,
          },
        };
      };
      try {
        const healthy = await source!.openPage(makeRequest("b", "/healthy"));
        const healthyTitle = async () => {
          try {
            return (await healthy.page.snapshot()).title;
          } catch (error) {
            if (error instanceof BrowserPageTransitionError) return null;
            throw error;
          }
        };
        // Cloak can commit before its visible surface exists. Establish a real
        // readable baseline, then verify the independent session after A closes.
        await expect
          .poll(healthyTitle, { timeout: 15_000 })
          .toBe("Healthy article");
        const delivery = production.deliverCandidate(
          makeRequest("a", "/pending"),
        );
        await expect.poll(() => requests.includes("/pending")).toBe(true);
        await expect(delivery).resolves.toMatchObject({
          kind: "refused",
          code: "browser-flow-budget-exhausted",
        });
        expect(decide).not.toHaveBeenCalled();
        expect(ownerSignal.aborted).toBe(false);
        await expect
          .poll(healthyTitle, { timeout: 15_000 })
          .toBe("Healthy article");
        const pages = await host!.listPages();
        expect(
          pages
            .filter((page) => page.session_id !== undefined)
            .map((page) => page.session_id),
        ).toEqual(["opening-b"]);
        await (
          healthy.page as { navigate(url: string): Promise<void> }
        ).navigate(origin + "/healthy-again");
        expect(requests).toContain("/healthy-again");
        await healthy.close();
        expect(
          (await host!.listPages()).filter(
            (page) => page.session_id !== undefined,
          ),
        ).toEqual([]);
        await saveHostEvidence({
          runtime: launch.version,
          scenario: "initial-open-budget-isolated-close",
          final_code: "browser-flow-budget-exhausted",
          model_calls: decide.mock.calls.length,
          owner_signal_aborted: ownerSignal.aborted,
          retained_session_usable: true,
          final_owned_page_count: 0,
        });
      } finally {
        await production.close();
        server.closeAllConnections();
      }
    },
    30000,
  );

  it.skipIf(!browserAvailable).each([6, 7, 8])(
    "honors an explicitly configured capacity of %s owned sessions",
    async (capacity) => {
      const host = new BrowserHost({
        profile: await profile(),
        executablePath: cachedBrowser,
        headless: true,
        maxSessions: capacity,
      });
      try {
        await host.start();
        const pages = [];
        for (let index = 0; index < capacity; index++)
          pages.push(await host.openPage());
        await expect(host.openPage()).rejects.toBeInstanceOf(BrowserHostError);
        await pages[0]!.close();
        await expect(host.openPage()).resolves.toBeDefined();
      } finally {
        await host.close();
      }
    },
    // Launching Chromium and up to eight pages exceeds the 5 s default under Full load.
    30000,
  );

  it.skipIf(!browserAvailable && !bundle)(
    "keeps platform admission outside the default 30 second page navigation timeout",
    async () => {
      const url = await fixture();
      const launch = await fixtureLaunch();
      let release!: () => void;
      let paused!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const held = new Promise<void>((resolve) => {
        paused = resolve;
      });
      const host = new BrowserHost({
        profile: await profile(),
        ...launch.options,
        admitNavigation: (requested) => requested,
        beforeRequest: async (binding) => {
          if (binding.is_navigation) {
            paused();
            await gate;
          }
        },
      });
      let terminal = false;
      let opening: ReturnType<BrowserHost["openPage"]> | undefined;
      try {
        await host.start();
        opening = host.openPage(url);
        void opening.then(
          () => {
            terminal = true;
          },
          () => {
            terminal = true;
          },
        );
        await held;
        await new Promise<void>((resolve) => setTimeout(resolve, 31000));
        expect(terminal).toBe(false);
        release();
        const page = await opening;
        await expect
          .poll(() => page.title(), { timeout: 10_000 })
          .toBe("synthetic browser page");
        await saveHostEvidence({
          runtime: launch.version,
          scenario: "platform-admission-over-30s",
          held_ms: 31000,
          terminal_at_30s: false,
          final_title: "synthetic browser page",
        });
      } finally {
        release();
        await opening?.catch(() => undefined);
        await host.close();
      }
    },
    45000,
  );

  it.skipIf(!browserAvailable && !bundle)(
    "retries one transient real navigation to the same admitted URL",
    async () => {
      const launch = await fixtureLaunch();
      const server = createServer((_request, response) => {
        response.end("<title>Recovered</title><main>Ready</main>");
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("fixture");
      const port = address.port;
      await new Promise<void>((resolve) => server.close(() => resolve()));
      servers.push(server);
      const url = `http://127.0.0.1:${port}/article`;
      let navigations = 0;
      const host = new BrowserHost({
        profile: await profile(),
        ...launch.options,
        admitNavigation: (requested) => {
          if (new URL(requested).origin !== new URL(url).origin)
            throw new Error("offline boundary");
          return requested;
        },
        beforeRequest: async (binding) => {
          if (binding.is_navigation && ++navigations === 2) {
            server.listen(port, "127.0.0.1");
            await once(server, "listening");
          }
        },
      });
      try {
        await host.start();
        const page = await host.openPage(url);
        await expect.poll(() => page.title()).toBe("Recovered");
        expect(navigations).toBe(2);
        await saveHostEvidence({
          runtime: launch.version,
          scenario: "same-url-transient-retry",
          admitted_navigations: navigations,
          final_title: "Recovered",
        });
      } finally {
        await host.close();
      }
    },
    15000,
  );

  it.skipIf(!browserAvailable && !bundle)(
    "reports a stable navigation failure after its one controlled retry",
    async () => {
      const launch = await fixtureLaunch();
      const reservation = createServer();
      reservation.listen(0, "127.0.0.1");
      await once(reservation, "listening");
      const address = reservation.address();
      if (!address || typeof address === "string") throw new Error("fixture");
      await new Promise<void>((resolve) => reservation.close(() => resolve()));
      let navigations = 0;
      const host = new BrowserHost({
        profile: await profile(),
        ...launch.options,
        admitNavigation: (requested) => requested,
        beforeRequest: async (binding) => {
          if (binding.is_navigation) navigations++;
        },
      });
      try {
        await host.start();
        await expect(
          host.openPage(`http://127.0.0.1:${address.port}/article`),
        ).rejects.toBeInstanceOf(BrowserHostNavigationError);
        expect(navigations).toBe(2);
        await saveHostEvidence({
          runtime: launch.version,
          scenario: "same-url-repeated-connection-refused",
          admitted_navigations: navigations,
          final_code: "browser-navigation-failed",
        });
      } finally {
        await host.close();
      }
    },
    15000,
  );
  it.skipIf(!browserAvailable && !bundle)(
    "retains one owned page after an initial transport failure and admits its alternate normally",
    async () => {
      const launch = await fixtureLaunch();
      const reservation = createServer();
      reservation.listen(0, "127.0.0.1");
      await once(reservation, "listening");
      const address = reservation.address();
      if (!address || typeof address === "string") throw new Error("fixture");
      await new Promise<void>((resolve) => reservation.close(() => resolve()));
      const failed = `http://127.0.0.1:${address.port}/missing`;
      const healthy = (await fixture()) + "?version=2";
      const admissions: string[] = [];
      const host = new BrowserHost({
        profile: await profile(),
        ...launch.options,
        admitNavigation: (url) => {
          if (
            url !== failed &&
            url !== healthy &&
            new URL(url).pathname !== "/favicon.ico"
          )
            throw new Error("offline boundary");
          admissions.push(url);
          return url;
        },
      });
      try {
        await host.start();
        const initialPages = host.diagnostics().page_count;
        const page = await host.openPage(failed, undefined, undefined, {
          retainNavigationFailure: true,
        });
        expect(page.initial_navigation_failure).toEqual({ recoverable: true });
        expect(page.navigationUrl?.()).toBe(failed);
        expect(host.diagnostics().page_count).toBe(initialPages + 1);
        await page.navigate!(healthy);
        await expect.poll(() => page.title()).toBe("synthetic browser page");
        expect(page.navigationUrl?.()).toBe(healthy);
        expect(page.url()).not.toContain("?version");
        expect(admissions).toContain(failed);
        expect(admissions).toContain(healthy);
        expect(host.diagnostics().page_count).toBe(initialPages + 1);
        await page.close();
        expect(host.diagnostics().page_count).toBe(initialPages);
      } finally {
        await host.close();
      }
    },
    15000,
  );
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
      const requests: string[] = [];
      const url = await fixture(requests);
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
      const initialUrl = `${url}?id=10.5555/fixture&token=synthetic-private`;
      const page = await host.openPage(initialUrl);
      expect(admitted.filter((value) => value === initialUrl).length).toBe(1);
      expect(requests).toContain(
        "/article?id=10.5555/fixture&token=synthetic-private",
      );
      await expect(page.title()).resolves.toBe("synthetic browser page");
      expect(page.url()).toBe(url);
      expect(
        (await host.listPages()).find((item) => item.id === page.id)?.url,
      ).toBe(url);
      const observation = await new BrowserObservationStore().observe(
        "article-1",
        page.id,
        page,
      );
      expect(observation.url).toBe(url);
      const nextUrl = `${url}?id=10.5555/next&token=synthetic-next`;
      await page.navigate!(nextUrl);
      expect(admitted.filter((value) => value === nextUrl).length).toBe(1);
      expect(requests).toContain(
        "/article?id=10.5555/next&token=synthetic-next",
      );
      expect(page.url()).toBe(url);
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

  it("preserves existing Profile preferences and refuses malformed preferences before launch", async () => {
    const root = await profile();
    await mkdir(join(root, "Default"), { mode: 0o700 });
    const path = join(root, "Default", "Preferences");
    const preferences = {
      plugins: { always_open_pdf_externally: false, unrelated: "retained" },
      download: { prompt_for_download: false },
    };
    await writeFile(path, JSON.stringify(preferences), { mode: 0o600 });
    const host = new BrowserHost({
      profile: root,
      executablePath: "/does/not/exist",
      headless: true,
    });
    await expect(host.start()).rejects.toBeInstanceOf(BrowserHostError);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      ...preferences,
      plugins: { ...preferences.plugins, always_open_pdf_externally: true },
    });

    const malformed = '{"plugins":';
    await writeFile(path, malformed);
    const invalidHost = new BrowserHost({
      profile: root,
      executablePath: "/does/not/exist",
      headless: true,
    });
    await expect(invalidHost.start()).rejects.toBeInstanceOf(BrowserHostError);
    expect(await readFile(path, "utf8")).toBe(malformed);
  });

  // Real Chromium work reached 3.8 s under Full (36/12) load, too close to the 5 s default.
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
    30_000,
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
      let initial: Awaited<ReturnType<typeof page.snapshot>> | undefined;
      await expect
        .poll(async () => {
          try {
            initial = await page.snapshot();
            return true;
          } catch (error) {
            if (error instanceof BrowserPageTransitionError) return false;
            throw error;
          }
        })
        .toBe(true);
      const first = initial!;
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
    "refuses a background page request after its session loses network access",
    async () => {
      const requests: string[] = [];
      const admitted: string[] = [];
      let releaseGate: (() => void) | undefined;
      const server = createServer((request, response) => {
        requests.push(request.url ?? "");
        if (request.url === "/gate") {
          releaseGate = () => response.end("ready");
          return;
        }
        response.writeHead(200, { "Content-Type": "text/html" });
        response.end(
          request.url === "/background"
            ? '<title>waiting</title><script>fetch("/gate").then(()=>fetch("/off-workspace")).then(()=>document.title="escaped",()=>document.title="blocked")</script>'
            : "<title>active article</title>",
        );
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      servers.push(server);
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("fixture");
      const origin = `http://127.0.0.1:${address.port}`;
      const host = new BrowserHost({
        profile: await profile(),
        executablePath: cachedBrowser,
        headless: true,
        admitNavigation: (url) => {
          admitted.push(url);
          return url;
        },
      });
      try {
        await host.start();
        const background = await host.openPage(`${origin}/background`);
        await vi.waitFor(() => expect(releaseGate).toBeDefined());
        await host.openPage(`${origin}/active`);
        host.setSessionNetworkAccess(background.session_id!, false);
        releaseGate!();
        await expect.poll(() => background.title()).toBe("blocked");
        expect(requests).not.toContain("/off-workspace");
        expect(admitted).not.toContain(`${origin}/off-workspace`);
      } finally {
        releaseGate?.();
        await host.close();
      }
    },
    30_000,
  );

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

// Real Chromium work reached 3.5 s under Full (36/12) load, too close to the 5 s default.
it.runIf(browserAvailable)(
  "returns from a popup without history to its article opener",
  async () => {
    const server = createServer((req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(
        req.url === "/popup"
          ? "<title>Ancillary information</title><main>License details</main>"
          : '<title>Article</title><a target="_blank" href="/popup">License</a>',
      );
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    servers.push(server);
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("fixture");
    const origin = `http://127.0.0.1:${address.port}`;
    const host = new BrowserHost({
      profile: await profile(),
      executablePath: cachedBrowser,
      headless: true,
      admitNavigation: (url) => {
        if (new URL(url).origin !== origin) throw new Error("offline");
        return url;
      },
    });
    try {
      await host.start();
      const root = await host.openPage(origin + "/article");
      const initialPageCount = (await host.listPages()).length;
      const initial = await root.snapshot();
      const link = initial.elements!.find(
        (element) => element.name === "License",
      )!;
      await root.apply(
        { kind: "click-element", element_id: link.element_id, revision: 1 },
        initial.document_generation!,
        () => true,
      );
      await expect
        .poll(async () => (await host.listPages()).length)
        .toBe(initialPageCount + 1);
      await expect.poll(() => root.successor!()).not.toBeNull();
      const child = (await root.successor!())!;
      await expect.poll(() => child.title()).toBe("Ancillary information");
      const snapshot = await child.snapshot();
      await child.apply(
        { kind: "go-back", revision: 1 },
        snapshot.document_generation!,
        () => true,
      );
      const restored = (await child.successor!())!;
      expect(await restored.title()).toBe("Article");
      expect(await host.listPages()).toHaveLength(initialPageCount);
    } finally {
      await host.close();
    }
  },
  30_000,
);

it.runIf(browserAvailable)(
  "allows page-generated multipart forms through the ordinary browser boundary",
  async () => {
    let receivedType = "";
    let receivedBody = "";
    const server = createServer((req, res) => {
      if (req.url === "/verify") {
        receivedType = req.headers["content-type"] ?? "";
        req.setEncoding("utf8");
        req.on("data", (part) => {
          receivedBody += String(part);
        });
        req.on("end", () => {
          res.end("Verification complete");
        });
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end(
        `<title>Generic verification form</title><button onclick="const data=new FormData();data.append('proof','synthetic-browser-proof');fetch('/verify',{method:'POST',body:data}).then(r=>r.text()).then(t=>document.body.innerText=t)">Verify</button><input type="file">`,
      );
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    servers.push(server);
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("fixture");
    const origin = `http://127.0.0.1:${address.port}`;
    const host = new BrowserHost({
      profile: await profile(),
      executablePath: cachedBrowser,
      headless: true,
      admitNavigation: (url) => {
        if (new URL(url).origin !== origin) throw new Error("offline");
        return url;
      },
    });
    try {
      await host.start();
      const page = await host.openPage(origin + "/article");
      let snapshot: Awaited<ReturnType<typeof page.snapshot>> | undefined;
      await expect
        .poll(async () => {
          try {
            snapshot = await page.snapshot();
            return true;
          } catch (error) {
            if (error instanceof BrowserPageTransitionError) return false;
            throw error;
          }
        })
        .toBe(true);
      if (!snapshot) throw new Error("Missing settled form snapshot");
      const button = snapshot.elements!.find(
        (element) => element.name === "Verify",
      )!;
      await page.apply(
        { kind: "click-element", element_id: button.element_id, revision: 1 },
        snapshot.document_generation!,
        () => true,
      );
      await expect
        .poll(async () => (await page.snapshot()).text, { timeout: 15_000 })
        .toContain("Verification complete");
      expect(receivedType).toContain("multipart/form-data; boundary=");
      expect(receivedBody).toContain("synthetic-browser-proof");
    } finally {
      await host.close();
    }
  },
  30000, // Covers browser startup plus the explicit 15-second response wait.
);
