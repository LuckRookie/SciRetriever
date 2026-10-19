import {
  workbenchTestAccess,
  loginWorkbenchPage,
} from "../../server/test/workbench-auth-fixture.js";
import { nextAssets, motionOptions } from "./next-workspace-fixture.js";
import { chromium } from "playwright";
import { expect, it } from "vitest";
import {
  parseDurableCandidate,
  parseLiteratureCurrentFacts,
} from "@sciretriever/contracts";
import { createBrowserArticleFlow } from "../../server/src/browser/article-flow.js";
import { BrowserCaptureBatch } from "../../server/src/browser/capture-batch.js";
import { BrowserObservationStore } from "../../server/src/browser/observation.js";
import { ProductionWorkbenchSession } from "../../server/src/workbench/production-session.js";
import { startWorkbenchHttp } from "../../server/src/workbench/http.js";
import { FIXTURE_LITERATURE } from "../../server/src/workbench/synthetic-fixture.js";

it("selects the correct live article, explicitly returns control on close, while another article downloads and retains its file", async () => {
  const aId = FIXTURE_LITERATURE.literature_id;
  const bId = "00000000-0000-0000-0000-000000000003";
  const metadata = parseLiteratureCurrentFacts({
    literature: FIXTURE_LITERATURE,
    metadata_snapshot: { revision: 1, sha256: "a".repeat(64) },
    primary_asset: null,
  }).metadata_snapshot;
  const workbench = new ProductionWorkbenchSession(aId, async () => {
    throw new Error("Unexpected second model owner");
  });
  const candidates = new Map<string, BrowserCaptureBatch>();
  let entered!: () => void;
  const dispatched = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const flow = createBrowserArticleFlow({
    session_id: "web-parallel",
    observations: new BrowserObservationStore(),
    collaboration: workbench,
    onSession: (execution) => {
      candidates.set(execution.session_id, new BrowserCaptureBatch(1));
    },
    candidateSource: (identity) => ({
      hasCandidate: () => candidates.get(identity.session_id)!.hasCandidate(),
      next: (signal) => candidates.get(identity.session_id)!.next(signal),
    }),
    decide: async (_o, _f, _s, _g, _t, _h, _feedback, lifecycle) => {
      lifecycle!.onDispatched();
      entered();
      return new Promise<never>(() => {});
    },
    pages: {
      openPage: async (incoming) => ({
        page: {
          id: `page-${incoming.session_identity!.session_id}`,
          url: () => incoming.start_url!,
          title: async () =>
            incoming.literature_id === aId
              ? "Synthetic article A"
              : "Synthetic article B",
          close: async () => undefined,
          snapshot: async () => ({
            document_generation: 1,
            url: incoming.start_url!,
            title:
              incoming.literature_id === aId
                ? "Synthetic article A"
                : "Synthetic article B",
            text: "Synthetic visible page",
            screenshot: null,
            viewport: { width: 800, height: 600, device_scale_factor: 1 },
            elements: [],
          }),
          apply: async () => undefined,
        },
        session_id: incoming.session_identity!.session_id,
        stopNetwork: async () => undefined,
        close: async () => undefined,
      }),
    },
  });
  const open = (articleId: string, sessionId: string) =>
    flow.open!({
      literature_id: articleId,
      identifier: "doi:10.5555/parallel",
      version: "published",
      start_url: "https://fixture.example.test/article",
      metadata_snapshot: metadata,
      signal: new AbortController().signal,
      generation: 1,
      session_identity: {
        session_id: sessionId,
        operation_id: "web-parallel-operation",
        generation: 1,
        literature_id: articleId,
        metadata_snapshot: metadata,
      },
    });
  const a = await open(aId, "web-session-a");
  const b = await open(bId, "web-session-b");
  const assets = await nextAssets();
  const http = await startWorkbenchHttp({
    access: workbenchTestAccess,
    session: workbench,
    assets,
  });
  const browser = await chromium.launch({
    ...(process.env.SCIRETRIEVER_BROWSER_EXECUTABLE
      ? { executablePath: process.env.SCIRETRIEVER_BROWSER_EXECUTABLE }
      : {}),
    headless: true,
  });
  try {
    const context = await browser.newContext(motionOptions());
    const failures: string[] = [];
    await context.route("**/*", async (route) => {
      if (new URL(route.request().url()).origin !== http.origin) {
        failures.push("External request attempted");
        await route.abort();
      } else await route.continue();
    });
    const page = await context.newPage();
    page.on("pageerror", (error) => failures.push(error.message));
    await loginWorkbenchPage(page, http.origin);
    await page.goto(`${http.origin}/?view=web`);
    await expect
      .poll(() =>
        page
          .locator(".browser-sessions [data-session] > section > button")
          .count(),
      )
      .toBe(2);
    expect(
      await page.getByRole("button", { name: "人工接管", exact: true }).count(),
    ).toBe(0);
    await page
      .locator('[data-session="web-session-a"]')
      .getByRole("button", { name: "观看 Agent", exact: true })
      .click();
    await expect
      .poll(() => page.locator(".browser-document-title").textContent())
      .toBe("Synthetic article A");
    await page.getByText("页面文字与可选指导", { exact: true }).click();
    await page.getByRole("button", { name: "人工接管", exact: true }).click();
    await expect
      .poll(() => page.locator(".browser-watch-header .ui-badge").textContent())
      .toBe("你正在操作 · Agent 已暂停");
    const client = workbench.view().control.controller_id!;
    const aEpoch = workbench.view().control.epoch;
    const step = b.step();
    await dispatched;
    b.transferStarted("web-transfer-b");
    expect(await step).toMatchObject({ kind: "suspended" });
    await expect
      .poll(() => page.locator('[data-session="web-session-b"]').textContent())
      .toContain("下载中");
    await page
      .getByLabel("给当前文章的指导", { exact: true })
      .fill("This draft only belongs to article A.");
    await page
      .getByRole("button", { name: "返回会话列表", exact: true })
      .click();
    await expect
      .poll(() => workbench.view().control.controller_id)
      .not.toBe(client);
    await page
      .locator('[data-session="web-session-b"]')
      .getByRole("button", { name: "观看 Agent", exact: true })
      .click();
    await expect
      .poll(() => page.locator(".browser-document-title").textContent())
      .toBe("Synthetic article B");
    expect(
      await page.getByLabel("给当前文章的指导", { exact: true }).inputValue(),
    ).toBe("");
    await expect
      .poll(() => page.locator(".browser-log").textContent())
      .toContain("下载中");
    expect(
      await page.locator(".browser-log > .ui-description").textContent(),
    ).toContain("29 次模型调用");
    expect(
      await page.locator(".browser-log > .ui-description").textContent(),
    ).not.toContain("次动作");
    await expect
      .poll(() => workbench.view().control.controller_id)
      .not.toBe(client);
    expect(workbench.view().control.epoch).toBeGreaterThan(aEpoch);
    const candidate = parseDurableCandidate({
      transfer_id: "web-transfer-b",
      state: "durable-ready",
      source_name: "browser",
      source_record_id: null,
      capture: null,
      reference: `.candidates/${"b".repeat(64)}.bin`,
      sha256: "b".repeat(64),
      size_bytes: 32,
    });
    b.transferCompleted(candidate.transfer_id);
    candidates
      .get(b.session_id)!
      .add({ transfer_id: candidate.transfer_id, candidate, accepted: true });
    workbench.captured(
      bId,
      {
        transfer_id: candidate.transfer_id,
        sha256: candidate.sha256,
        size_bytes: 32,
        page_count: 1,
        disposition: "accepted",
        publication: null,
      },
      b.session_id,
    );
    b.candidateReady();
    expect(await b.step()).toMatchObject({ kind: "candidate", candidate });
    await b.close({ kind: "retained", code: "publication-disk-full" });
    await page.getByRole("button", { name: /下载与接纳 · 1/ }).click();
    await expect
      .poll(() => page.locator(".browser-log .ui-card").count())
      .toBe(1);
    await expect
      .poll(() => page.locator(".browser-log").textContent())
      .toContain("publication-disk-full");
    await page
      .getByRole("button", { name: "返回会话列表", exact: true })
      .click();
    await page
      .locator('[data-session="web-session-a"]')
      .getByRole("button", { name: "观看 Agent", exact: true })
      .click();
    await expect
      .poll(() => page.locator(".browser-document-title").textContent())
      .toBe("Synthetic article A");
    expect(await page.locator(".browser-log .ui-card").count()).toBe(0);
    await page.getByText("页面文字与可选指导", { exact: true }).click();
    await page.getByRole("button", { name: "人工接管", exact: true }).click();
    await expect
      .poll(() => page.locator(".browser-watch-header .ui-badge").textContent())
      .toBe("你正在操作 · Agent 已暂停");
    expect(
      await page.locator(".browser-log > .ui-description").textContent(),
    ).toContain("30 次模型调用");
    const candidateA = parseDurableCandidate({
      ...candidate,
      transfer_id: "web-transfer-a",
      sha256: "a".repeat(64),
      reference: `.candidates/${"a".repeat(64)}.bin`,
    });
    candidates.get(a.session_id)!.add({
      transfer_id: candidateA.transfer_id,
      candidate: candidateA,
      accepted: true,
    });
    workbench.captured(
      aId,
      {
        transfer_id: candidateA.transfer_id,
        sha256: candidateA.sha256,
        size_bytes: candidateA.size_bytes,
        page_count: 1,
        disposition: "accepted",
        publication: null,
      },
      a.session_id,
    );
    a.candidateReady();
    expect(await a.step()).toMatchObject({
      kind: "candidate",
      candidate: candidateA,
    });
    await a.close({ kind: "published", receipt_id: "publication-web-a" });
    workbench.removed(a.session_id, {
      kind: "retained",
      code: "browser-network-drain-timeout",
    });
    await expect
      .poll(() => page.locator(".browser-log").textContent())
      .toContain("PDF 已入库");
    await expect
      .poll(() => page.locator(".browser-log").textContent())
      .toContain("资源清理未完成：browser-network-drain-timeout");
    expect(workbench.view().session_outcome).toEqual({
      kind: "published",
      receipt_id: "publication-web-a",
    });
    expect(failures).toEqual([]);
  } finally {
    await browser.close();
    await http.close();
    await workbench.close();
    await Promise.all([
      a.close({ kind: "cancelled" }),
      b.close({ kind: "cancelled" }),
    ]);
  }
}, 60000);
