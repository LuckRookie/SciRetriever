import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { BrowserHost } from "../src/browser/host.js";
import { BrowserTransferCollector } from "../src/browser/transfer.js";
import { FileStore } from "../src/storage/files/store.js";
import { NetworkBudgetCoordinator } from "../src/network/budget.js";
import { BrowserNetworkProxy } from "../src/network/browser-proxy.js";
import { resolveDestination } from "../src/network/policy.js";
import { startWorkbenchFixture } from "../src/workbench/synthetic-fixture.js";

const executable =
  process.env.SCIRETRIEVER_BROWSER_EXECUTABLE ??
  "/home/duanjw/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome";

it("captures popup, data and blob downloads under the owning page context", async () => {
  const root = await mkdtemp(join(tmpdir(), "sciretriever-browser-complex-"));
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
      maxConcurrency: 8,
      maxHostConcurrency: 8,
      maxResponseBytes: 2 * 1024 * 1024,
      maxRedirects: 0,
      maxRetries: 0,
    },
  });
  const connection = await proxy.start();
  const files = new FileStore(join(root, "files"));
  const captures: { source: string; page: string; bytes: number }[] = [];
  const failures: string[] = [];
  const collector = new BrowserTransferCollector(files);
  const host = new BrowserHost({
    profile: join(root, "profile"),
    executablePath: executable,
    headless: true,
    proxy: connection,
    admitNavigation: async (url) =>
      (await resolveDestination(url, resolver, policy)).url.url,
    transfers: {
      captureContext: (pageId, generation, sourceUrl) => ({
        session_id: "complex-session",
        article_id: "complex-article",
        page_id: pageId,
        document_generation: generation,
        source_url: sourceUrl,
        captured_at: new Date().toISOString(),
      }),
      receive: async (input) => {
        const transfer = await collector.begin(
          input.transfer_id,
          2 * 1024 * 1024,
          input.capture,
        );
        expect(transfer.state).toBe("capturing");
        for await (const chunk of input.chunks)
          await collector.append(input.transfer_id, chunk);
        const candidate = await collector.complete(input.transfer_id);
        captures.push({
          source: candidate.capture!.source_url,
          page: candidate.capture!.page_id,
          bytes: candidate.size_bytes,
        });
      },
      failed: (id) => failures.push(id),
    },
  });
  try {
    await host.start();
    const page = await host.openPage(`${fixture.origin}/article`);
    let snapshot = await page.snapshot();
    for (const name of ["Data PDF", "Blob PDF", "Popup PDF"]) {
      const element = snapshot.elements!.find((item) => item.name === name);
      expect(element, `missing ${name}`).toBeDefined();
      await page.apply(
        { kind: "click-element", element_id: element!.element_id, revision: 1 },
        snapshot.document_generation!,
        () => true,
      );
      snapshot = await page.snapshot();
    }
    const tabs = await host.listPages();
    expect(tabs.length).toBeGreaterThanOrEqual(2);
    expect(tabs.filter((tab) => tab.active)).toHaveLength(1);
    expect(tabs.some((tab) => tab.opener_id === page.id)).toBe(true);
    const popup = tabs.find((tab) => tab.opener_id === page.id);
    expect(popup?.url).toContain(fixture.origin);
    if (popup) {
      const popupPage = await host.activatePage(popup.id);
      expect(popupPage.id).toBe(popup.id);
      expect(
        (await host.listPages()).find((tab) => tab.id === popup.id)?.active,
      ).toBe(true);
      await page.activate?.();
    }
    await expect.poll(() => captures.length, { timeout: 10000 }).toBe(3);
    expect(failures).toEqual([]);
    expect(captures).toHaveLength(3);
    expect(captures.every((item) => item.bytes > 100)).toBe(true);
    expect(
      captures.every((item) => item.source.startsWith(fixture.origin)),
    ).toBe(true);
    expect(
      new Set(captures.map((item) => item.page)).size,
    ).toBeGreaterThanOrEqual(2);
    await page.close();
  } finally {
    await host.close();
    await files.close();
    await proxy.close();
    await fixture.close();
    await rm(root, { recursive: true, force: true });
  }
}, 60000);
