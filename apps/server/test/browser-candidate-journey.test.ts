import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BrowserHost } from "../src/browser/host.js";
import { BrowserTransferCollector } from "../src/browser/transfer.js";
import {
  BrowserCandidateIntake,
  type AssessedCandidate,
} from "../src/acquisition/browser-intake.js";
import { FileStore } from "../src/storage/files/store.js";
import { SqliteWorker } from "../src/storage/sqlite/worker.js";
import { BrowserNetworkProxy } from "../src/network/browser-proxy.js";
import { NetworkBudgetCoordinator } from "../src/network/budget.js";
import { resolveDestination } from "../src/network/policy.js";
import {
  FIXTURE_DOI,
  startWorkbenchFixture,
} from "../src/workbench/synthetic-fixture.js";
import { verifyInstalledCloakRuntime } from "../src/configuration/cloak-runtime.js";

const stock =
  process.env.SCIRETRIEVER_BROWSER_EXECUTABLE ??
  "/home/duanjw/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome";

describe("Browser to durable Candidate journey", () => {
  it("captures admitted download and response bytes, survives page close, and preserves the original article after restart", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "sciretriever-browser-candidate-"),
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
    const proxy = new BrowserNetworkProxy({
      resolver,
      policy,
      coordinator: new NetworkBudgetCoordinator(),
      limits: {
        maxConcurrency: 4,
        maxHostConcurrency: 4,
        maxResponseBytes: 1048576,
        maxRedirects: 0,
        maxRetries: 0,
      },
    });
    const connection = await proxy.start();
    const files = new FileStore(join(root, "files"));
    const db = new SqliteWorker(join(root, "catalog.sqlite"));
    await db.upgradeExecutionSchema();
    const collector = new BrowserTransferCollector(files, db);
    const intake = new BrowserCandidateIntake(collector, {
      article_id: "article-1",
      identifier: `doi:${FIXTURE_DOI}`,
      version: "published",
    });
    const candidates: AssessedCandidate[] = [];
    const failures: string[] = [];
    const admittedUrls: string[] = [];
    let articleId = "article-1";
    let started = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runtime = process.env.SCIRETRIEVER_CLOAK_BUNDLE
      ? await verifyInstalledCloakRuntime(process.env.SCIRETRIEVER_CLOAK_BUNDLE)
      : null;
    const host = new BrowserHost({
      profile: join(root, "profile"),
      ...(runtime ? { runtime } : { executablePath: stock, headless: true }),
      proxy: connection,
      admitNavigation: async (url) =>
        (await resolveDestination(url, resolver, policy)).url.url,
      transfers: {
        captureContext: (pageId, generation, sourceUrl) => {
          admittedUrls.push(sourceUrl);
          return {
            session_id: "session-1",
            article_id: articleId,
            page_id: pageId,
            document_generation: generation,
            source_url: sourceUrl,
            captured_at: new Date().toISOString(),
          };
        },
        receive: async (input) => {
          started++;
          if (started === 2) await gate;
          candidates.push(await intake.receive(input));
        },
        failed: (id) => {
          failures.push(id);
        },
      },
    });
    try {
      await host.start();
      const page = await host.openPage(`${fixture.origin}/article`);
      let snapshot = await page.snapshot();
      const response = snapshot.elements!.find(
        (element) => element.name === "Capture response PDF",
      )!;
      await page.apply(
        { kind: "click-element", element_id: response.element_id, revision: 1 },
        snapshot.document_generation!,
        () => true,
      );
      await expect.poll(() => candidates.length).toBe(1);
      snapshot = await page.snapshot();
      const download = snapshot.elements!.find(
        (element) => element.name === "Download PDF",
      )!;
      await page.apply(
        { kind: "click-element", element_id: download.element_id, revision: 2 },
        snapshot.document_generation!,
        () => true,
      );
      await expect
        .poll(() => ({ started, admittedUrls, failures }))
        .toEqual({
          started: 2,
          admittedUrls: [
            `${fixture.origin}/article`,
            `${fixture.origin}/inline.pdf`,
            `${fixture.origin}/paper.pdf`,
          ],
          failures: [],
        });
      snapshot = await page.snapshot();
      const ranged = snapshot.elements!.find(
        (element) => element.name === "Range PDF",
      )!;
      await page.apply(
        { kind: "click-element", element_id: ranged.element_id, revision: 3 },
        snapshot.document_generation!,
        () => true,
      );
      await expect.poll(() => failures.length).toBe(1);
      articleId = "article-2";
      const closing = page.close();
      release();
      await closing;
      expect(failures).toHaveLength(1);
      expect(candidates).toHaveLength(2);
      expect(
        candidates.every(
          (item) => item.assessment.verdict.disposition === "accepted",
        ),
      ).toBe(true);
      expect(
        candidates.map((item) => item.candidate.capture?.article_id),
      ).toEqual(["article-1", "article-1"]);
      await host.close();
      await files.close();
      await db.close();
      const reopened = new SqliteWorker(join(root, "catalog.sqlite"));
      const reopenedFiles = new FileStore(join(root, "files"));
      try {
        const recovered = new BrowserTransferCollector(reopenedFiles, reopened);
        for (const item of candidates)
          expect(await recovered.recover(item.candidate.transfer_id)).toEqual(
            item.candidate,
          );
      } finally {
        await reopenedFiles.close();
        await reopened.close();
      }
    } finally {
      release();
      await host.close();
      await files.close();
      await db.close();
      await proxy.close();
      await fixture.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 60000);
});
