import { createHash } from "node:crypto";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256 } from "@sciretriever/contracts";
import { chromium, type Page } from "playwright";
import { expect, it } from "vitest";
import {
  BrowserArticleClock,
  type BrowserArticleExecution,
  type BrowserArticleSessionIdentity,
  type BrowserArticleStepResult,
} from "../src/browser/article-session.js";
import type { BrowserProtocol } from "../src/browser/cdp.js";
import type { BrowserCdpOwner } from "../src/browser/cdp-owner.js";
import { BrowserHost, type BrowserPageHandle } from "../src/browser/host.js";
import { BrowserPageTransitionError } from "../src/browser/page-runtime.js";
import { BrowserDownloadResources } from "../src/browser/resources.js";
import { verifyInstalledCloakRuntime } from "../src/configuration/cloak-runtime.js";
import { BrowserArticleScheduler } from "../src/entry/browser-scheduler.js";
import { NetworkBudgetCoordinator } from "../src/network/budget.js";
import { BrowserNetworkProxy } from "../src/network/browser-proxy.js";
import { resolveDestination } from "../src/network/policy.js";

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

it
  .runIf(Boolean(bundle) || existsSync(executable))
  .each([
    "host-get",
    "javascript-get",
    "form-post",
    "host-get-after-commit",
    "host-get-after-commit-xhr",
    "host-get-after-commit-image",
    "host-get-after-commit-stylesheet",
    "host-get-after-commit-font",
    "host-get-after-commit-keepalive",
    "host-get-after-commit-keepalive-streaming",
    "host-get-after-commit-keepalive-headers",
    "host-get-after-commit-keepalive-cancel",
  ] as const)(
  "recovers a held old script before cross-platform GET while preserving an original POST (%s)",
  async (intervention) => {
    const afterCommit = intervention.startsWith("host-get-after-commit");
    const keepalive = intervention.includes("keepalive");
    const keepaliveCancel = intervention.endsWith("keepalive-cancel");
    const earlyHeaders = intervention.endsWith("keepalive-headers");
    const streaming =
      intervention.endsWith("keepalive-streaming") || keepaliveCancel;
    const documentBound = afterCommit && !keepalive;
    const resource = intervention.endsWith("-xhr")
      ? "xhr"
      : intervention.endsWith("-image")
        ? "image"
        : intervention.endsWith("-stylesheet")
          ? "stylesheet"
          : intervention.endsWith("-font")
            ? "font"
            : "script";
    const directory = await mkdtemp(
      join(tmpdir(), "sciretriever-document-handoff-"),
    );
    const scriptRequested = deferred<void>();
    const scriptStopped = deferred<void>();
    const releaseScript = deferred<void>();
    const releaseHeaders = deferred<void>();
    const drainEntered = deferred<void>();
    const finish = deferred<BrowserArticleStepResult>();
    const articleAbort = new AbortController();
    const opened = deferred<BrowserPageHandle>();
    const evidence: Record<string, unknown>[] = [];
    const record = (kind: string, data: Record<string, unknown> = {}) => {
      evidence.push({ kind, at_ms: performance.now(), ...data });
    };
    let runtimeVersion: string | undefined;
    let port = 0;
    let bRequested = false;
    let oldScriptClosed = false;
    let oldScriptNetwork: string | undefined;
    let activeReads = 0;
    let identity: BrowserArticleSessionIdentity | undefined;
    const bMethods: string[] = [];
    let capturedHash: string | undefined;
    const bytes = Buffer.from("%PDF-synthetic-handoff\n" + "B".repeat(8192));
    const resources = new BrowserDownloadResources({
      available_bytes: async () => 10 * 1024 ** 3,
    });
    const url = (hostname: string, path: string) =>
      `http://${hostname}:${port}${path}`;
    const server = createServer((request, response) => {
      const path = request.url!;
      record("server-request", { path });
      if (path === "/held-script.js") {
        const sendHeaders = () => {
          const mime =
            resource === "image"
              ? "image/png"
              : resource === "stylesheet"
                ? "text/css"
                : resource === "font"
                  ? "font/woff2"
                  : "text/javascript";
          response.writeHead(200, {
            "content-type": mime,
            "access-control-allow-origin": "*",
          });
          response.write(
            resource === "image"
              ? Buffer.from("89504e470d0a1a0a", "hex")
              : resource === "font"
                ? "wOF2"
                : "/* A document resource remains in flight until fixture EOF. */\n",
          );
          record("fixture-headers");
        };
        if (!keepalive || earlyHeaders) sendHeaders();
        else if (streaming)
          void releaseHeaders.promise.then(() => {
            if (!response.destroyed) sendHeaders();
          });
        response.once("close", () => {
          oldScriptClosed = true;
          record("script-socket-closed");
          scriptStopped.resolve();
        });
        scriptRequested.resolve();
        void releaseScript.promise.then(() => {
          if (response.destroyed) return;
          if (!response.headersSent)
            response.writeHead(200, {
              "content-type": "text/javascript",
              "access-control-allow-origin": "*",
            });
          response.end("void 0;\n");
        });
        return;
      }
      if (path === "/b.pdf") {
        response.writeHead(200, {
          "content-type": "application/pdf",
          "content-disposition": 'attachment; filename="b.pdf"',
          "content-length": bytes.length,
        });
        response.end(bytes);
        return;
      }
      response.writeHead(200, { "content-type": "text/html" });
      if (path === "/a")
        response.end("<title>A</title><main>A document</main>");
      else if (path === "/a2")
        response.end("<title>A2</title><main>A second document</main>");
      else if (path === "/b") {
        bRequested = true;
        bMethods.push(request.method!);
        response.end(
          '<title>B</title><main>B document <a href="/b.pdf">PDF</a></main>',
        );
      } else response.end("ok");
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
        maxConcurrency: 8,
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
        record("request", {
          request: binding.request_id,
          path: new URL(requested).pathname,
          document: binding.document_id,
          source: binding.source_document_id,
          navigation: binding.is_navigation,
          resource_type: binding.resource_type,
        });
        const admission = await owner.beforeRequest(
          binding,
          requested,
          async () => {
            record("drain-enter", { request: binding.request_id });
            drainEntered.resolve();
            const result = await drain();
            record("drain-exit", {
              request: binding.request_id,
              result: result?.kind ?? "continue",
            });
            return result;
          },
        );
        record("admission-result", {
          request: binding.request_id,
          result: admission?.kind ?? "continue",
        });
        return admission;
      },
      navigationRetryFailed: (binding) => owner.navigationRetryFailed(binding),
      documentCommitted: (document) => {
        record("commit", {
          frame: document.frame_id,
          document: document.document_id,
          request: document.navigation_request_id,
        });
        owner.documentCommitted(document);
      },
      requestEnded: (binding) => {
        record("ended", { request: binding.request_id });
        owner.requestEnded(binding);
      },
      transfers: {
        resources: () => resources,
        captureContext: (page, generation, requested, session) =>
          identity && session === identity.session_id
            ? {
                session_id: identity.session_id,
                article_id: identity.literature_id,
                page_id: page,
                document_generation: generation,
                source_url: requested,
                captured_at: "2026-10-05T00:00:00Z",
              }
            : null,
        receive: async (input) => {
          const hash = createHash("sha256");
          for await (const chunk of input.chunks) hash.update(chunk);
          capturedHash = hash.digest("hex");
        },
        failed: (_transfer, _capture, code) =>
          record("transfer-failed", { code }),
      },
    });
    let page: BrowserPageHandle | undefined;
    let delivery: Promise<unknown> | undefined;
    try {
      await host.start();
      const protocol = Reflect.get(host, "protocol") as BrowserProtocol;
      const version = await protocol.send("Browser.getVersion");
      runtimeVersion = runtime?.version ?? String(version.product);
      record("browser-version", {
        product: version.product,
        protocol: version.protocolVersion,
      });
      const cdp = Reflect.get(host, "cdp") as BrowserCdpOwner;
      const send = protocol.send.bind(protocol);
      protocol.send = async (method, params, session, timeout, signal) => {
        if (
          [
            "Fetch.failRequest",
            "Page.stopLoading",
            "Fetch.takeResponseBodyAsStream",
            "IO.read",
            "IO.close",
          ].includes(method)
        )
          record("command", {
            method,
            request: params?.requestId,
            handle: params?.handle,
            reason: params?.errorReason,
            session,
          });
        if (method === "IO.read") activeReads++;
        try {
          const result = await send(method, params, session, timeout, signal);
          if (method === "IO.read")
            record("io-read", {
              handle: params?.handle,
              eof: result.eof,
              data_length:
                typeof result.data === "string" ? result.data.length : null,
            });
          if (method === "Fetch.takeResponseBodyAsStream")
            record("command-completed", {
              method,
              request: params?.requestId,
              handle: result.stream,
            });
          if (["IO.close", "Fetch.failRequest"].includes(method))
            record("command-completed", {
              method,
              request: params?.requestId,
              handle: params?.handle,
            });
          return result;
        } finally {
          if (method === "IO.read") {
            activeReads--;
            record("io-read-settled", { handle: params?.handle, activeReads });
          }
        }
      };
      protocol.on("Fetch.requestPaused", ({ params }) => {
        if (params.responseStatusCode !== undefined)
          record("response-pause", {
            request: params.requestId,
            network: params.networkId,
            status: params.responseStatusCode,
          });
        if (params.responseErrorReason !== undefined)
          record("failed-response", {
            request: params.requestId,
            network: params.networkId,
            reason: params.responseErrorReason,
          });
      });
      protocol.on("Network.requestWillBeSent", ({ params, session_id }) => {
        const request = params.request as { url: string };
        if (new URL(request.url).pathname === "/held-script.js")
          oldScriptNetwork = params.requestId as string;
        record("network-request", {
          network: params.requestId,
          session: session_id,
          frame: params.frameId,
          document: params.loaderId,
          path: new URL(request.url).pathname,
          resource_type: params.type,
        });
      });
      for (const method of ["Network.loadingFinished", "Network.loadingFailed"])
        protocol.on(method, ({ params, session_id }) =>
          record(method, {
            network: params.requestId,
            session: session_id,
            error: params.errorText,
            canceled: params.canceled,
          }),
        );
      protocol.on(
        "Runtime.executionContextCreated",
        ({ params, session_id }) => {
          const context = params.context as {
            id: number;
            auxData?: { frameId?: string; isDefault?: boolean };
          };
          if (context.auxData?.isDefault)
            record("default-context", {
              context: context.id,
              frame: context.auxData.frameId,
              document: evidence
                .slice()
                .reverse()
                .find(
                  (event) =>
                    event.kind === "commit" &&
                    event.frame === context.auxData?.frameId,
                )?.document,
              session: session_id,
            });
        },
      );
      for (const method of [
        "Runtime.executionContextDestroyed",
        "Runtime.executionContextsCleared",
      ])
        protocol.on(method, ({ params, session_id }) =>
          record(method, {
            context: params.executionContextId,
            session: session_id,
          }),
        );
      for (const method of [
        "Target.attachedToTarget",
        "Target.detachedFromTarget",
        "Target.targetDestroyed",
      ])
        protocol.on(method, ({ params }) => {
          const info = params.targetInfo as
            | { targetId?: string; type?: string }
            | undefined;
          record(method, {
            target: params.targetId ?? info?.targetId,
            session: params.sessionId,
            type: info?.type,
          });
        });
      delivery = owner.deliver(
        {
          literature_id: "article-fixture",
          identifier: "doi:10.1/fixture",
          version: "published",
          start_url: url("publisher-a.test", "/a"),
          metadata_snapshot: {
            revision: 1,
            sha256: await sha256(new Uint8Array()),
          },
          signal: articleAbort.signal,
          operation_id: "fixture",
          generation: 1,
        },
        async (input) => {
          identity = input.session_identity!;
          const bound = identity;
          const settleHeldStep = () => {
            if (keepalive)
              finish.resolve({
                kind: "terminal",
                result: { kind: "exhausted" },
              });
          };
          const execution: BrowserArticleExecution = {
            identity: bound,
            session_id: bound.session_id,
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
            cancel: settleHeldStep,
            rateLimited: () => {},
            setNetworkAccess: (allowed) =>
              host.setSessionNetworkAccess(bound.session_id, allowed),
            close: async () => {
              settleHeldStep();
              await page?.close();
            },
          };
          owner.attach(execution);
          page = await host.openPage(input.start_url!, bound);
          opened.resolve(page);
          return execution;
        },
      );
      page = await opened.promise;
      await expect
        .poll(
          async () => {
            try {
              return (await page!.snapshot()).title;
            } catch (error) {
              if (error instanceof BrowserPageTransitionError)
                return "transition";
              throw error;
            }
          },
          { timeout: 15000 },
        )
        .toBe("A");
      const raw = (Reflect.get(host, "pages") as Map<string, Page>).get(
        page.id,
      )!;
      await raw.evaluate(
        ({ source, resource, keep }) => {
          if (resource === "xhr") {
            const request = new XMLHttpRequest();
            request.open("GET", source);
            request.send();
          } else if (keep) {
            void fetch(source, { keepalive: true })
              .then((response) => response.text())
              .catch(() => undefined);
          } else if (resource === "image") {
            const image = document.createElement("img");
            image.src = source;
            document.body.append(image);
          } else if (resource === "stylesheet") {
            const stylesheet = document.createElement("link");
            stylesheet.rel = "stylesheet";
            stylesheet.href = source;
            document.head.append(stylesheet);
          } else if (resource === "font") {
            const font = new FontFace("Held", `url("${source}")`);
            document.fonts.add(font);
            void font.load().catch(() => undefined);
          } else {
            const script = document.createElement("script");
            script.src = source;
            document.head.append(script);
          }
        },
        {
          source: url("cdn-a.test", "/held-script.js"),
          resource,
          keep: keepalive,
        },
      );
      await scriptRequested.promise;
      expect(oldScriptNetwork).toBeDefined();
      const original = evidence.find(
        (event) => event.kind === "request" && event.path === "/held-script.js",
      )!;
      const originalNetwork = evidence.find(
        (event) =>
          event.kind === "network-request" &&
          event.network === oldScriptNetwork,
      )!;
      const originalProtocolTerminal = () =>
        evidence.find(
          (event) =>
            ((event.kind === "Network.loadingFinished" ||
              event.kind === "Network.loadingFailed") &&
              event.network === oldScriptNetwork &&
              event.session === originalNetwork.session) ||
            (event.kind === "failed-response" &&
              event.request === original.request &&
              event.network === oldScriptNetwork),
        );
      const originalEnded = () =>
        evidence.some(
          (event) =>
            event.kind === "ended" && event.request === original.request,
        );
      const originalStreamHandle = () =>
        evidence.find(
          (event) =>
            event.kind === "command-completed" &&
            event.method === "Fetch.takeResponseBodyAsStream" &&
            event.request === original.request,
        )?.handle;
      const originalReadStarted = () => {
        const handle = originalStreamHandle();
        return (
          handle !== undefined &&
          evidence.some(
            (event) =>
              event.kind === "command" &&
              event.method === "IO.read" &&
              event.handle === handle,
          )
        );
      };
      if (afterCommit) {
        await page.navigate!(url("publisher-a.test", "/a2"));
        if (documentBound)
          await expect
            .poll(() => oldScriptClosed, { timeout: 10000 })
            .toBe(true);
        await expect
          .poll(async () => (await page!.snapshot()).title, { timeout: 10000 })
          .toBe("A2");
      }
      if (streaming) {
        releaseHeaders.resolve();
        await expect
          .poll(
            () =>
              originalReadStarted() ||
              (originalProtocolTerminal() !== undefined && originalEnded()),
            { timeout: 10000 },
          )
          .toBe(true);
      }
      const destination = url("publisher-b.test", "/b");
      let navigation: Promise<void> | undefined;
      if (intervention.startsWith("host-get")) {
        navigation = page.navigate!(destination);
        void navigation.catch(() => undefined);
      } else {
        await raw.evaluate(
          ({ target, post }) => {
            if (post) {
              const form = document.createElement("form");
              form.action = target;
              form.method = "POST";
              document.body.append(form);
              form.submit();
            } else location.href = target;
          },
          { target: destination, post: intervention === "form-post" },
        );
      }
      await drainEntered.promise;
      record("handoff-state", {
        bRequested,
        oldScriptClosed,
        platform: owner.snapshot(),
      });
      const terminalBeforeHandoff = originalProtocolTerminal();
      if (intervention === "form-post" || (keepalive && !earlyHeaders)) {
        expect(bRequested).toBe(false);
        const terminal = keepalive ? terminalBeforeHandoff : undefined;
        if (terminal) {
          // Chromium 140 explicitly aborts this Fetch during document unload;
          // Cloak 146 leaves the same original response alive for IO cleanup.
          expect(originalEnded()).toBe(true);
          expect(
            (Reflect.get(cdp, "requests") as Map<string, unknown>).has(
              original.request as string,
            ),
          ).toBe(false);
          record("keepalive-protocol-terminal", {
            request: original.request,
            network: oldScriptNetwork,
            terminal: terminal.kind,
            error: terminal.error ?? terminal.reason,
          });
        } else {
          expect(oldScriptClosed).toBe(false);
          if (keepalive) {
            expect(originalEnded()).toBe(false);
            expect(originalProtocolTerminal()).toBeUndefined();
            expect(
              (Reflect.get(cdp, "requests") as Map<string, unknown>).has(
                original.request as string,
              ),
            ).toBe(true);
          }
        }
        if (keepalive) {
          expect(owner.snapshot().platform_active).toBe(1);
        }
        if (!keepaliveCancel) {
          record("fixture-eof");
          releaseScript.resolve();
        }
      }
      if (keepaliveCancel) {
        const target = (
          Reflect.get(host, "pageTargets") as Map<string, string>
        ).get(page.id)!;
        record("article-cancel-requested", { target });
        articleAbort.abort();
        await delivery;
        await navigation?.catch(() => undefined);
        await scriptStopped.promise;
        await expect.poll(() => activeReads, { timeout: 2000 }).toBe(0);
        if (terminalBeforeHandoff) {
          expect(originalEnded()).toBe(true);
        } else {
          const handle = originalStreamHandle();
          expect(handle).toBeDefined();
          expect(originalReadStarted()).toBe(true);
          expect(
            evidence.some(
              (event) =>
                event.kind === "command-completed" &&
                event.method === "IO.close" &&
                event.handle === handle,
            ),
          ).toBe(true);
          expect(
            evidence.some(
              (event) =>
                event.kind === "command-completed" &&
                event.method === "Fetch.failRequest" &&
                event.request === original.request,
            ),
          ).toBe(true);
          expect(
            evidence.some(
              (event) =>
                event.kind === "io-read-settled" &&
                event.handle === handle &&
                event.activeReads === 0,
            ),
          ).toBe(true);
          expect(originalEnded()).toBe(true);
        }
        await expect
          .poll(
            () =>
              evidence.some(
                (event) =>
                  event.kind === "Target.targetDestroyed" &&
                  event.target === target,
              ),
            { timeout: 5000 },
          )
          .toBe(true);
        expect(
          (Reflect.get(cdp, "requests") as Map<string, unknown>).size,
        ).toBe(0);
        expect(resources.snapshot().temporary_bytes).toBe(0);
        await expect
          .poll(() => owner.snapshot(), { timeout: 5000 })
          .toEqual({
            sessions: 0,
            queued: 0,
            workers: 0,
            platform_active: 0,
          });
        expect(bMethods).toEqual([]);
        record("keepalive-owned-close", {
          target,
          resources: resources.snapshot(),
          scheduler: owner.snapshot(),
        });
        return;
      }
      await expect.poll(() => bRequested, { timeout: 10000 }).toBe(true);
      await navigation;
      await scriptStopped.promise;
      await expect
        .poll(
          async () => {
            try {
              return (await page!.snapshot()).title;
            } catch (error) {
              if (error instanceof BrowserPageTransitionError)
                return "transition";
              throw error;
            }
          },
          { timeout: 10000 },
        )
        .toBe("B");
      expect(bMethods).toEqual([intervention === "form-post" ? "POST" : "GET"]);
      const pageSnapshot = await page.snapshot();
      const link = pageSnapshot.elements!.find(
        (element) => element.name === "PDF",
      )!;
      await page.apply(
        { kind: "click-element", element_id: link.element_id, revision: 1 },
        pageSnapshot.document_generation!,
        () => true,
      );
      await expect
        .poll(
          () =>
            evidence.some(
              (event) =>
                event.kind === "server-request" && event.path === "/b.pdf",
            ),
          { timeout: 10000 },
        )
        .toBe(true);
      await expect
        .poll(() => capturedHash, { timeout: 10000 })
        .toBe(createHash("sha256").update(bytes).digest("hex"));
      await page.settleCaptures!();
      await host.stopSessionNetwork(identity!.session_id);
      owner.networkEnded(identity!.session_id);
      expect(resources.snapshot().temporary_bytes).toBe(0);
      expect(evidence.some((event) => event.kind === "transfer-failed")).toBe(
        false,
      );
      const firstB = evidence.findIndex(
        (event) => event.kind === "server-request" && event.path === "/b",
      );
      const oldRequest = original;
      const failedResponse = evidence.findIndex(
        (event) =>
          event.kind === "failed-response" &&
          event.request === oldRequest.request &&
          event.network === oldScriptNetwork,
      );
      const oldEnded = evidence.findIndex(
        (event) =>
          event.kind === "ended" && event.request === oldRequest.request,
      );
      let oldTerminal = evidence.findIndex(
        (event) =>
          (event.kind === "Network.loadingFinished" ||
            event.kind === "Network.loadingFailed") &&
          event.network === oldScriptNetwork &&
          event.session === originalNetwork.session,
      );
      const originalStream = evidence.find(
        (event) =>
          event.kind === "command" &&
          event.method === "Fetch.takeResponseBodyAsStream" &&
          event.request === oldRequest.request,
      );
      const originalHandle = originalStreamHandle();
      const orphanEof = evidence.findIndex(
        (event) =>
          event.kind === "io-read" &&
          event.handle === originalHandle &&
          event.eof === true,
      );
      const originalIoClosed = evidence.find(
        (event) =>
          event.kind === "command-completed" &&
          event.method === "IO.close" &&
          event.handle === originalHandle,
      );
      const originalReadSettled = evidence.findIndex(
        (event) =>
          event.kind === "io-read-settled" &&
          event.handle === originalIoClosed?.handle,
      );
      const originalIoCancelled = evidence.findIndex(
        (event) =>
          event.kind === "command-completed" &&
          event.method === "Fetch.failRequest" &&
          event.request === oldRequest.request,
      );
      const confirmedIoCancel =
        originalHandle !== undefined &&
        originalIoClosed !== undefined &&
        originalReadSettled >= 0 &&
        originalIoCancelled >= 0 &&
        oldScriptClosed;
      if (
        oldTerminal < 0 &&
        (documentBound ||
          failedResponse >= 0 ||
          orphanEof >= 0 ||
          confirmedIoCancel)
      )
        oldTerminal = oldEnded;
      expect(oldTerminal).toBeGreaterThanOrEqual(0);
      expect(oldTerminal).toBeLessThan(firstB);
      if (failedResponse >= 0) expect(oldEnded).toBeGreaterThan(failedResponse);
      if (keepalive && !earlyHeaders) {
        if (terminalBeforeHandoff) {
          expect(oldEnded).toBeGreaterThanOrEqual(0);
        } else {
          expect(originalStream).toBeDefined();
          expect(originalHandle).toBeDefined();
          if (streaming) expect(orphanEof >= 0 || confirmedIoCancel).toBe(true);
          else {
            expect(orphanEof).toBeGreaterThanOrEqual(0);
            expect(orphanEof).toBeLessThan(oldEnded);
          }
          expect(oldTerminal).toBeGreaterThan(
            evidence.findIndex((event) => event.kind === "fixture-eof"),
          );
        }
      }
      if (documentBound) {
        const oldNetworkRequest = evidence.find(
          (event) =>
            event.kind === "network-request" &&
            event.network === oldScriptNetwork,
        )!;
        expect(String(oldNetworkRequest.resource_type).toLowerCase()).toBe(
          oldRequest.resource_type,
        );
        expect(oldRequest.resource_type).toBe(
          resource === "script" ? "script" : resource,
        );
        const context = evidence.find(
          (event) =>
            event.kind === "default-context" &&
            event.document ===
              evidence.find(
                (request) =>
                  request.kind === "request" &&
                  request.path === "/held-script.js",
              )?.document,
        )!;
        expect(context).toBeDefined();
        const lost = evidence.findIndex(
          (event) =>
            event.kind === "Runtime.executionContextsCleared" &&
            event.session === context.session &&
            Number(event.at_ms) > Number(context.at_ms),
        );
        const second = evidence.findIndex(
          (event) =>
            event.kind === "commit" &&
            event.frame === context.frame &&
            Number(event.at_ms) > Number(context.at_ms) &&
            event.document !==
              evidence.find(
                (request) =>
                  request.kind === "request" &&
                  request.path === "/held-script.js",
              )?.document,
        );
        expect(lost).toBeGreaterThanOrEqual(0);
        expect(second).toBeGreaterThanOrEqual(0);
        expect(lost).toBeLessThan(firstB);
        expect(second).toBeLessThan(firstB);
      } else if (keepalive && !earlyHeaders && terminalBeforeHandoff) {
        // The old request is already terminal, so this original GET proceeds
        // directly instead of being canceled and retried for a live response.
        const requests = evidence.filter(
          (event) => event.kind === "request" && event.path === "/b",
        );
        expect(requests).toHaveLength(1);
        expect(
          evidence.some(
            (event) =>
              event.kind === "drain-exit" &&
              event.request === requests[0]!.request &&
              event.result === "continue",
          ),
        ).toBe(true);
        expect(
          evidence.some(
            (event) =>
              event.kind === "command" &&
              event.method === "Fetch.failRequest" &&
              event.request === requests[0]!.request,
          ),
        ).toBe(false);
        expect(
          evidence
            .slice(0, firstB)
            .some(
              (event) =>
                event.kind === "command" && event.method === "Page.stopLoading",
            ),
        ).toBe(false);
      } else if (intervention !== "form-post" && !earlyHeaders) {
        const original = evidence.find(
          (event) => event.kind === "request" && event.path === "/b",
        )!;
        const originalNetwork = evidence.find(
          (event) => event.kind === "network-request" && event.path === "/b",
        )!.network;
        const cancel = evidence.findIndex(
          (event) =>
            event.kind === "command" &&
            event.method === "Fetch.failRequest" &&
            event.request === original.request &&
            event.reason === "Aborted",
        );
        const canceled = evidence.findIndex(
          (event) =>
            event.kind === "Network.loadingFailed" &&
            event.network === originalNetwork,
        );
        const stop = evidence.findIndex(
          (event) =>
            event.kind === "command" && event.method === "Page.stopLoading",
        );
        expect(cancel).toBeGreaterThanOrEqual(0);
        expect(canceled).toBeGreaterThan(cancel);
        expect(stop).toBeGreaterThan(canceled);
        expect(
          evidence.filter(
            (event) =>
              event.kind === "command" &&
              event.method === "Fetch.failRequest" &&
              event.request === original.request,
          ),
        ).toHaveLength(1);
      }
      expect((Reflect.get(cdp, "requests") as Map<string, unknown>).size).toBe(
        0,
      );
      expect(
        evidence.some(
          (event) =>
            ((event.kind === "Network.loadingFinished" ||
              event.kind === "Network.loadingFailed") &&
              event.network === oldScriptNetwork) ||
            (documentBound && event.kind === "script-socket-closed") ||
            (event.kind === "failed-response" &&
              event.request === oldRequest.request &&
              event.network === oldScriptNetwork &&
              oldEnded >= 0) ||
            (originalStream !== undefined &&
              (orphanEof >= 0 || confirmedIoCancel) &&
              oldEnded >= 0),
        ),
      ).toBe(true);
    } finally {
      releaseScript.resolve();
      releaseHeaders.resolve();
      finish.resolve({ kind: "terminal", result: { kind: "exhausted" } });
      await delivery;
      await owner.close();
      await host.close();
      await proxy.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await writeFile(
        join(directory, "events.json"),
        JSON.stringify(
          {
            runtime: runtimeVersion,
            intervention,
            oldScriptNetwork,
            bMethods,
            captured_hash: capturedHash,
            resources: resources.snapshot(),
            evidence,
          },
          null,
          2,
        ),
      );
      console.info("Document handoff evidence:", directory);
      await rm(join(directory, "profile"), { recursive: true, force: true });
    }
  },
  45000,
);
