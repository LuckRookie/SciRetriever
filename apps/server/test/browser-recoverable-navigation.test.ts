import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { expect, it, vi } from "vitest";
import { sha256 } from "@sciretriever/contracts";
import { BrowserHost, type BrowserPageHandle } from "../src/browser/host.js";
import {
  BrowserProtocolError,
  type BrowserProtocol,
} from "../src/browser/cdp.js";
import {
  BrowserArticleFlowDriver,
  type SpooledArticleCandidate,
} from "../src/browser/article-flow.js";
import { BrowserArticleScheduler } from "../src/entry/browser-scheduler.js";
import { BrowserObservationStore } from "../src/browser/observation.js";
import { BrowserTransferCollector } from "../src/browser/transfer.js";
import { FileStore } from "../src/storage/files/store.js";
import {
  FIXTURE_DOI,
  workbenchPdf,
} from "../src/workbench/synthetic-fixture.js";

it.each([
  { mode: "connection", persistent: false },
  { mode: "connection", persistent: true },
  { mode: "drain", persistent: false },
  { mode: "drain", persistent: true },
  { mode: "replay", persistent: false },
  { mode: "replay", persistent: true },
] as const)(
  "returns a failed $mode navigation to the Agent (persistent=$persistent)",
  async ({ mode, persistent }) => {
    const root = await mkdtemp(
      join(tmpdir(), "sciretriever-recoverable-navigation-"),
    );
    const bytes = workbenchPdf(FIXTURE_DOI, "published");
    const collector = new BrowserTransferCollector(new FileStore(root));
    let failures = 0,
      resumes = 0,
      decisions = 0,
      downloads = 0;
    let failDrain = false;
    let candidate: SpooledArticleCandidate | null = null;
    let driver: BrowserArticleFlowDriver | undefined;
    let opened: BrowserPageHandle | undefined;
    const titles: string[] = [];
    const feedbacks: string[] = [];
    const hits: string[] = [];
    const server = createServer((request, response) => {
      const path = new URL(request.url!, "http://fixture.test").pathname;
      hits.push(path);
      if (path === "/slow") {
        response.writeHead(200, { "Content-Type": "image/png" });
        response.write(Buffer.from([137, 80, 78, 71]));
      } else if (path === "/reader") {
        if (mode === "connection" && (persistent || failures === 0)) {
          request.socket.destroy();
          return;
        }
        response.setHeader("Content-Type", "text/html");
        response.end('<title>Reader</title><script>fetch("/pdf")</script>');
      } else if (path === "/pdf") {
        downloads++;
        response.writeHead(200, {
          "Content-Type": "application/pdf",
          "Content-Disposition": "attachment; filename=fixture.pdf",
        });
        response.end(bytes);
      } else {
        response.setHeader("Content-Type", "text/html");
        response.end(
          `<title>Article</title>${mode !== "connection" ? '<img src="/slow">' : ""}<a href="/reader?private=fixture">ePDF</a>`,
        );
      }
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Missing fixture address");
    const origin = `http://127.0.0.1:${address.port}`;
    const owner = new BrowserArticleScheduler({
      sessions: 1,
      workers: 1,
      platform_cooldown_ms: 0,
    });
    const host = new BrowserHost({
      profile: join(root, "profile"),
      executablePath: chromium.executablePath(),
      headless: true,
      admitNavigation: (url) => {
        if (new URL(url).origin !== origin) throw new Error("Offline boundary");
        return url;
      },
      beforeRequest: async (identity, url, drain) => {
        const admitted = await owner.beforeRequest(identity, url, drain);
        // Force the genuine drain/replay path, without bypassing Scheduler admission.
        if (admitted?.kind === "retry-navigation") return admitted;
        if (
          mode !== "connection" &&
          identity.is_navigation &&
          new URL(url).pathname === "/reader" &&
          (persistent || failures === 0)
        ) {
          failDrain = mode === "drain";
          return drain();
        }
        return admitted;
      },
      documentCommitted: (document) => owner.documentCommitted(document),
      requestEnded: (identity) => owner.requestEnded(identity),
      resumeDocument: async (document, drain) => {
        resumes++;
        await owner.resumeDocument(document, drain);
      },
      navigationRetryFailed: (identity) => {
        failures++;
        owner.navigationRetryFailed(identity);
      },
      transfers: {
        captureContext: (page, generation, url, session) =>
          session
            ? {
                session_id: session,
                article_id: "00000000-0000-0000-0000-000000000001",
                page_id: page,
                document_generation: generation,
                source_url: url,
                captured_at: new Date().toISOString(),
              }
            : null,
        receive: async (input) => {
          const id = "recovered-transfer";
          driver!.transferStarted(id);
          await collector.begin(id, 1048576, input.capture);
          for await (const chunk of input.chunks)
            await collector.append(id, chunk);
          candidate = {
            transfer_id: id,
            candidate: await collector.complete(id),
            accepted: true,
          };
          driver!.transferCompleted(id);
          driver!.candidateReady();
        },
        failed: () => {
          throw new Error("Fixture transfer failed");
        },
      },
    });
    try {
      await host.start();
      if (mode !== "connection") {
        const protocol = Reflect.get(host, "protocol") as BrowserProtocol;
        const send = protocol.send.bind(protocol);
        vi.spyOn(protocol, "send").mockImplementation(
          async (method, ...args) => {
            if (failDrain && method === "Page.stopLoading") {
              failDrain = false;
              throw new BrowserProtocolError("timeout");
            }
            if (
              mode === "replay" &&
              method === "Page.navigate" &&
              (persistent || failures === 0)
            )
              throw new BrowserProtocolError("timeout");
            return send(method, ...args);
          },
        );
      }
      const result = await owner.deliver(
        {
          literature_id: "00000000-0000-0000-0000-000000000001",
          identifier: FIXTURE_DOI,
          version: "published",
          start_url: origin + "/article",
          metadata_snapshot: {
            revision: 1,
            sha256: await sha256(new Uint8Array()),
          },
          signal: new AbortController().signal,
          operation_id: "synthetic-recovery",
          generation: 1,
        },
        async (input) => {
          const identity = input.session_identity!;
          driver = new BrowserArticleFlowDriver({
            identity,
            session_id: identity.session_id,
            article_id: identity.literature_id,
            signal: input.signal,
            max_model_calls: 4,
            deadline_ms: 30000,
            started_at: Date.now(),
            action_cooldown_ms: 0,
            dispatch_tracking: "test-seam",
            observations: new BrowserObservationStore(),
            hasCandidate: () => candidate !== null,
            awaitCandidate: async () => candidate,
            close: async () => {
              await opened?.close();
            },
            decide: async (
              observation,
              _frame,
              _signal,
              _guidance,
              _target,
              _actions,
              feedback,
            ) => {
              decisions++;
              titles.push(observation.title);
              feedbacks.push(feedback?.join(" ") ?? "");
              const link = observation.elements.find(
                (element) => element.name === "ePDF",
              );
              if (!link)
                return {
                  kind: "wait-for-change",
                  revision: observation.observation_revision,
                  timeout_ms: 100,
                };
              if (mode !== "connection" && persistent && decisions > 1) {
                // A fresh old-document request makes the second handoff need draining too.
                const pages = Reflect.get(host, "pages") as Map<
                  string,
                  import("playwright").Page
                >;
                await pages.get(observation.page_id)!.evaluate(() => {
                  const image = new Image();
                  image.src = "/slow?attempt=2";
                  document.body.append(image);
                });
                await expect
                  .poll(() => hits.filter((path) => path === "/slow").length)
                  .toBe(2);
              }
              return {
                kind: "click-element",
                element_id: link.element_id,
                revision: observation.observation_revision,
              };
            },
          });
          owner.attach(driver);
          const page = await host.openPage(input.start_url!, identity);
          opened = page;
          driver.attachPage({
            page,
            setNetworkAccess: (allowed) =>
              host.setSessionNetworkAccess(identity.session_id, allowed),
          });
          return driver;
        },
      );
      expect(
        result,
        JSON.stringify({
          result,
          failures,
          resumes,
          titles,
          feedbacks,
          hits,
          actions: driver?.activity.snapshot(),
        }),
      ).toMatchObject(
        persistent
          ? { kind: "refused", code: "browser-navigation-retry-limit" }
          : { kind: "delivered" },
      );
      expect(failures).toBe(persistent ? 2 : 1);
      expect(
        titles.slice(0, 2),
        JSON.stringify({ resumes, titles, feedbacks, hits }),
      ).toEqual(["Article", "Article"]);
      expect(feedbacks[1]).toContain("last navigation did not complete");
      expect(decisions).toBeGreaterThanOrEqual(2);
      const actions = driver!.activity.snapshot();
      expect(
        actions.filter((action) => action.kind === "navigation-failed"),
      ).toHaveLength(persistent ? 2 : 1);
      expect(
        actions.filter((action) => action.kind === "click-element").length,
      ).toBeLessThanOrEqual(persistent ? 0 : 1);
      expect(JSON.stringify(actions)).not.toContain("private=fixture");
      expect(downloads).toBe(persistent ? 0 : 1);
      if (result.kind === "delivered") {
        expect(result.candidate.size_bytes).toBe(bytes.length);
        await result.lease?.close({
          kind: "published",
          receipt_id: "synthetic-receipt",
        });
      }
    } finally {
      await owner.close();
      await host.close();
      vi.restoreAllMocks();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  },
  60000,
);
