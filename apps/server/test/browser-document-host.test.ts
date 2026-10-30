import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { sha256 } from "@sciretriever/contracts";
import { chromium, type Page } from "playwright";
import { BrowserHost, type BrowserPageHandle } from "../src/browser/host.js";
import { BrowserArticleScheduler } from "../src/entry/browser-scheduler.js";
import {
  BrowserArticleClock,
  type BrowserArticleExecution,
  type BrowserArticleStepResult,
} from "../src/browser/article-session.js";
import { BrowserNetworkProxy } from "../src/network/browser-proxy.js";
import { NetworkBudgetCoordinator } from "../src/network/budget.js";
import { resolveDestination } from "../src/network/policy.js";
import { verifyInstalledCloakRuntime } from "../src/configuration/cloak-runtime.js";
import { BrowserPageTransitionError } from "../src/browser/page-runtime.js";
import type { BrowserPageSnapshot } from "../src/browser/observation.js";
import type { BrowserProtocol } from "../src/browser/cdp.js";

const executable =
  process.env.SCIRETRIEVER_BROWSER_EXECUTABLE ?? chromium.executablePath();
const bundle = process.env.SCIRETRIEVER_CLOAK_BUNDLE;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function snapshot(
  page: BrowserPageHandle,
  title: string,
): Promise<BrowserPageSnapshot> {
  let result: BrowserPageSnapshot | undefined;
  await expect
    .poll(
      async () => {
        try {
          result = await page.snapshot();
          return result.title;
        } catch (error) {
          if (error instanceof BrowserPageTransitionError) return "transition";
          throw error;
        }
      },
      { timeout: 20_000 },
    )
    .toBe(title);
  return result!;
}

it.runIf(Boolean(bundle) || existsSync(executable))(
  "gates initial redirects, OOPIF requests, old-document handoff and explicit return through the real Host and Scheduler",
  async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "sciretriever-document-host-"),
    );
    const releaseB = deferred<void>();
    const bRequested = deferred<void>();
    const liveWorkerRequested = deferred<void>();
    const liveWorkerStopped = deferred<void>();
    const counts = new Map<string, number>();
    const evidence: Record<string, unknown>[] = [];
    let port = 0;
    const url = (host: string, path: string) => `http://${host}:${port}${path}`;
    const server = createServer((request, response) => {
      const path = request.url!;
      counts.set(path, (counts.get(path) ?? 0) + 1);
      if (path === "/resolver") {
        response.writeHead(302, {
          location: url("publisher-a.test", "/article"),
        });
        response.end();
        return;
      }
      if (path === "/new") {
        bRequested.resolve();
        void releaseB.promise.then(() => {
          response.writeHead(200, { "content-type": "text/html" });
          response.end(
            `<title>B</title><main>B document</main><iframe src="${url("embed-b.test", "/frame-b")}"></iframe><script>fetch("${url("cdn.test", "/asset-b")}");new Worker("/worker-b.js")</script>`,
          );
        });
        return;
      }
      if (
        path === "/worker-a.js" ||
        path === "/worker-b.js" ||
        path === "/nested-worker.js"
      ) {
        response.writeHead(200, { "content-type": "text/javascript" });
        response.end(
          path === "/worker-a.js"
            ? 'fetch("/worker-data-a");new Worker("/nested-worker.js");onmessage=e=>fetch(e.data==="live"?"/live-worker-request":"/old-worker-request").catch(()=>{})'
            : path === "/worker-b.js"
              ? 'fetch("/worker-data-b")'
              : 'fetch("/worker-data-nested")',
        );
        return;
      }
      if (path === "/live-worker-request") {
        response.writeHead(200, { "content-type": "text/plain" });
        response.write("first bytes");
        response.once("close", () => liveWorkerStopped.resolve());
        liveWorkerRequested.resolve();
        return;
      }
      response.writeHead(200, { "content-type": "text/html" });
      if (path === "/article")
        response.end(
          `<title>A</title><main>A document</main><a target="_blank" href="${url("publisher-b.test", "/popup")}">License</a><iframe src="${url("embed-a.test", "/frame-a")}"></iframe><script>const worker=new Worker("/worker-a.js");addEventListener("message",e=>{if(e.data==="old-worker"||e.data==="live")worker.postMessage(e.data)})</script>`,
        );
      else if (path === "/popup")
        response.end(
          "<title>Popup B</title><main>Ancillary information</main>",
        );
      else if (path === "/frame-a" || path === "/frame-b")
        response.end(
          `<script>fetch("/frame-hit${path.endsWith("a") ? "-a" : "-b"}")</script>`,
        );
      else response.end("ok");
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("fixture");
    port = address.port;
    const policy = {
      allowed_schemes: ["http"] as const,
      allowed_classes: ["loopback"] as const,
      allowed_addresses: ["127.0.0.1"],
      allowed_ports: [{ scheme: "http" as const, port }],
    };
    const resolver = () => ["127.0.0.1"];
    const proxy = new BrowserNetworkProxy({
      resolver,
      policy,
      coordinator: new NetworkBudgetCoordinator(),
      limits: {
        maxConcurrency: 12,
        maxHostConcurrency: 4,
        maxResponseBytes: 1048576,
        maxRedirects: 0,
        maxRetries: 0,
      },
    });
    const connection = await proxy.start();
    const owner = new BrowserArticleScheduler({
      sessions: 2,
      workers: 1,
      platform_cooldown_ms: 0,
    });
    const finish = deferred<BrowserArticleStepResult>();
    const opened = deferred<BrowserPageHandle>();
    const runtime = bundle
      ? await verifyInstalledCloakRuntime(bundle)
      : undefined;
    const host = new BrowserHost({
      profile: join(directory, "profile"),
      ...(runtime
        ? { runtime }
        : { executablePath: executable, headless: true }),
      proxy: connection,
      admitNavigation: async (requested) =>
        (await resolveDestination(requested, resolver, policy)).url.url,
      beforeRequest: async (binding, requested, drain) => {
        const event = {
          kind: "request",
          request: binding.request_id,
          path: new URL(requested).pathname,
          document: binding.document_id,
          parent: binding.parent_document_id,
          redirect: binding.redirected_request_id,
          navigation: binding.is_navigation,
          admitted: false,
        };
        evidence.push(event);
        const admission = await owner.beforeRequest(binding, requested, drain);
        event.admitted = admission?.kind !== "retry-navigation";
        return admission;
      },
      documentCommitted: (document) => {
        evidence.push({
          kind: "commit",
          document: document.document_id,
          request: document.navigation_request_id,
          history: document.is_history_navigation === true,
        });
        owner.documentCommitted(document);
      },
      resumeDocument: (document, drain) => {
        evidence.push({ kind: "resume", document: document.document_id });
        return owner.resumeDocument(document, drain);
      },
      requestEnded: (binding) => {
        evidence.push({ kind: "ended", request: binding.request_id });
        owner.requestEnded(binding);
      },
    });
    let rootPage: BrowserPageHandle | undefined;
    let delivery: Promise<unknown> | undefined;
    try {
      await host.start();
      const protocol = (host as unknown as { protocol: BrowserProtocol })
        .protocol;
      protocol.on("Target.targetDestroyed", ({ params }) =>
        evidence.push({ kind: "target-destroyed", target: params.targetId }),
      );
      delivery = owner.deliver(
        {
          literature_id: "article-fixture",
          identifier: "doi:10.1/fixture",
          version: "published",
          start_url: url("doi.org", "/resolver"),
          metadata_snapshot: {
            revision: 1,
            sha256: await sha256(new Uint8Array()),
          },
          signal: new AbortController().signal,
          operation_id: "fixture",
          generation: 1,
        },
        async (input) => {
          const identity = input.session_identity!;
          const execution: BrowserArticleExecution = {
            identity,
            session_id: identity.session_id,
            clock: new BrowserArticleClock(),
            phase: () => "ready",
            step: () => finish.promise,
            changed: async () => {},
            transferStarted: () => {},
            transferCompleted: () => {},
            transferFailed: () => {},
            candidateRejected: () => {},
            candidateReady: () => {},
            controlEpochChanged: () => {},
            cancel: () => {},
            rateLimited: () => {},
            setNetworkAccess: (allowed) =>
              host.setSessionNetworkAccess(identity.session_id, allowed),
            close: async () => {
              await rootPage?.close();
            },
          };
          owner.attach(execution);
          rootPage = await host.openPage(input.start_url!, identity);
          opened.resolve(rootPage);
          return execution;
        },
      );
      const page = await opened.promise;
      const initial = await snapshot(page, "A");
      await expect.poll(() => counts.get("/frame-hit-a") ?? 0).toBe(1);
      await expect.poll(() => counts.get("/worker-data-a") ?? 0).toBe(1);
      await expect.poll(() => counts.get("/worker-data-nested") ?? 0).toBe(1);
      expect(evidence).toContainEqual(
        expect.objectContaining({
          kind: "request",
          path: "/resolver",
          admitted: true,
        }),
      );
      expect(evidence).toContainEqual(
        expect.objectContaining({
          kind: "request",
          path: "/article",
          redirect: expect.any(String),
          admitted: true,
        }),
      );
      const raw = (host as unknown as { pages: Map<string, Page> }).pages.get(
        page.id,
      )!;
      await raw.evaluate(
        (destination) => {
          window.open(destination, "_blank");
        },
        url("publisher-b.test", "/new"),
      );
      await bRequested.promise;
      await raw.evaluate(() => {
        window.postMessage("old-worker", location.origin);
      });
      await expect
        .poll(() =>
          evidence.some(
            (event) =>
              event.kind === "request" &&
              event.path === "/old-worker-request" &&
              event.admitted === false,
          ),
        )
        .toBe(true);
      expect(counts.get("/old-worker-request") ?? 0).toBe(0);
      await raw.evaluate(async () => {
        try {
          await fetch("/old-request");
        } catch {
          /* Fixture observes a refused old document request. */
        }
      });
      expect(counts.get("/old-request") ?? 0).toBe(0);
      expect(evidence).toContainEqual(
        expect.objectContaining({
          kind: "request",
          path: "/old-request",
          admitted: false,
        }),
      );
      releaseB.resolve();
      await expect.poll(() => counts.get("/asset-b") ?? 0).toBe(1);
      await expect.poll(() => counts.get("/frame-hit-b") ?? 0).toBe(1);
      await expect.poll(() => counts.get("/worker-data-b") ?? 0).toBe(1);
      let pendingPopup: BrowserPageHandle | null = null;
      await expect
        .poll(async () => {
          pendingPopup = await page.successor!();
          return pendingPopup !== null;
        })
        .toBe(true);
      const firstPopup = pendingPopup! as BrowserPageHandle;
      const popupB = await snapshot(firstPopup, "B");
      await firstPopup.apply(
        { kind: "go-back", revision: 1 },
        popupB.document_generation!,
        () => true,
      );
      expect((await firstPopup.successor!())!.id).toBe(page.id);
      await raw.evaluate(async () => {
        await fetch("/restored-first-parent-a");
      });
      expect(counts.get("/restored-first-parent-a")).toBe(1);
      await page.navigate!(url("publisher-b.test", "/new"));
      const b = await snapshot(page, "B");
      await page.apply(
        { kind: "go-back", revision: 1 },
        b.document_generation!,
        () => true,
      );
      await snapshot(page, "A");
      await raw.evaluate(async () => {
        await fetch("/restored-a");
      });
      expect(counts.get("/restored-a")).toBe(1);
      const parent = await snapshot(page, "A");
      const link = parent.elements!.find(
        (element) => element.name === "License",
      )!;
      await page.apply(
        { kind: "click-element", element_id: link.element_id, revision: 2 },
        parent.document_generation!,
        () => true,
      );
      let popup: BrowserPageHandle | null = null;
      await expect
        .poll(async () => {
          popup = await page.successor!();
          return popup !== null;
        })
        .toBe(true);
      const child = popup! as BrowserPageHandle;
      const childSnapshot = await snapshot(child, "Popup B");
      await child.apply(
        { kind: "go-back", revision: 1 },
        childSnapshot.document_generation!,
        () => true,
      );
      const restored = (await child.successor!())!;
      expect(restored.id).toBe(page.id);
      await raw.evaluate(async () => {
        await fetch("/restored-parent-a");
      });
      expect(counts.get("/restored-parent-a")).toBe(1);
      await raw.evaluate(() => {
        window.postMessage("live", location.origin);
      });
      await liveWorkerRequested.promise;
      const liveRequest = evidence.find(
        (event) =>
          event.kind === "request" && event.path === "/live-worker-request",
      )!;
      expect(
        evidence.some(
          (event) =>
            event.kind === "ended" && event.request === liveRequest.request,
        ),
      ).toBe(false);
      await host.stopSessionNetwork(host.sessionForPage(page.id)!);
      await liveWorkerStopped.promise;
      expect(evidence).toContainEqual({
        kind: "ended",
        request: liveRequest.request,
      });
      expect(evidence.some((event) => event.kind === "target-destroyed")).toBe(
        true,
      );
      owner.networkEnded(host.sessionForPage(page.id)!);
      evidence.push({
        kind: "network-ended",
        active: owner.snapshot().platform_active,
        initial_generation: initial.document_generation,
      });
      await writeFile(
        join(directory, "events.json"),
        JSON.stringify(
          {
            runtime: runtime?.version ?? "test-chromium",
            counts: Object.fromEntries(counts),
            evidence,
          },
          null,
          2,
        ),
      );
      if (bundle) console.info("Document Host evidence:", directory);
    } finally {
      releaseB.resolve();
      finish.resolve({ kind: "terminal", result: { kind: "exhausted" } });
      await delivery;
      await owner.close();
      await host.close();
      await proxy.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(join(directory, "profile"), { recursive: true, force: true });
      if (!bundle) await rm(directory, { recursive: true, force: true });
    }
  },
  45000,
);
