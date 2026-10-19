import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { parseLiterature } from "@sciretriever/contracts";
import { FIXTURE_LITERATURE } from "../../server/src/workbench/synthetic-fixture.js";
import { workspace } from "./processor-workspace-fixture.js";

it("preserves library pages, selection and scroll across reading and history, and keeps dialogs and tabs keyboard accessible", async () => {
  const w = await workspace(true, async (env) => {
    for (let i = 0; i < 105; i++)
      await env.app.database.putLiterature(
        parseLiterature({
          ...FIXTURE_LITERATURE,
          literature_id: randomUUID(),
          meta_literature_id: randomUUID(),
          metadata: {
            ...FIXTURE_LITERATURE.metadata,
            title: `Paper ${i}: &lt;i&gt;S&lt;/i&gt; &amp; spectra`,
            identifiers: [],
          },
        }),
      );
  });
  const { page } = w;
  try {
    await page.locator("#library-more").click();
    await expect.poll(() => page.locator(".prow").count()).toBe(100);
    const row = page.locator(".prow").nth(70);
    const id = (await row.getAttribute("data-id"))!;
    expect(await row.textContent()).toContain("S & spectra");
    expect(await row.textContent()).not.toContain("&lt;");
    await row.locator("[data-ck]").check();
    await row.scrollIntoViewIfNeeded();
    const scroll = await page
      .locator('[data-page="lib"] .pg')
      .evaluate((el) => el.scrollTop);
    await row.click();
    await page.locator("#reader-info").waitFor();
    await expect
      .poll(() => page.locator(`[data-paper="${id}"]`).getAttribute("title"))
      .toContain("S & spectra");
    await page.goBack();
    await expect.poll(() => page.locator(".prow").count()).toBe(100);
    expect(await page.locator(`[data-ck="${id}"]`).isChecked()).toBe(true);
    expect(
      await page
        .locator('[data-page="lib"] .pg')
        .evaluate((el) => el.scrollTop),
    ).toBeCloseTo(scroll, -1);
    await page.locator(`[data-id="${id}"]`).click();
    await page.locator("#reader-info").waitFor();
    await page.locator("[data-module]").click();
    await expect.poll(() => page.locator(".prow").count()).toBe(100);
    expect(
      await page
        .locator('[data-page="lib"] .pg')
        .evaluate((el) => el.scrollTop),
    ).toBeCloseTo(scroll, -1);
    await page.locator("#capSel").click();
    await expect
      .poll(() =>
        page.locator('#overlay [role="dialog"]').getAttribute("aria-modal"),
      )
      .toBe("true");
    for (let i = 0; i < 12; i++) {
      expect(
        await page.evaluate(
          () => !!document.activeElement?.closest('#overlay [role="dialog"]'),
        ),
      ).toBe(true);
      await page.keyboard.press("Tab");
    }
    expect(
      await page.locator(".app").evaluate((el) => (el as HTMLElement).inert),
    ).toBe(true);
    await page.keyboard.press("Escape");
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.id))
      .toBe("capSel");
    await page.locator("#gsearch").click();
    await page.locator("#global-search input").waitFor();
    await page.keyboard.press("Escape");
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.id))
      .toBe("gsearch");
    const close = page.locator(`[data-close-tab="${id}"]`);
    await close.focus();
    await page.keyboard.press("Enter");
    await expect.poll(() => close.count()).toBe(0);
    expect(
      await page.locator(".app").evaluate((el) => (el as HTMLElement).inert),
    ).toBe(false);
    await page.locator("#q").fill("nonexistent title");
    await expect.poll(() => page.locator(".prow").count()).toBe(0);
    expect(w.errors).toEqual([]);
    expect(w.env.modelCalls).toBe(0);
  } finally {
    await w.close();
  }
}, 60000);

it("retains synthesis question and policy while invalidating prepared inputs after a scope change", async () => {
  const w = await workspace();
  try {
    const p = w.page;
    await p.locator(`[data-ck="${w.env.parseRequest.literature_id}"]`).check();
    await p.locator('[data-go="syn"]').click();
    await p.locator("#new-synthesis").click();
    await p
      .locator("#workspace-synthesis-question")
      .fill("Which evidence agrees?");
    await p
      .locator("#workspace-synthesis-policy")
      .selectOption("allow-partial");
    await p.locator("#workspace-synthesis-prepare").click();
    await expect
      .poll(() => p.locator("#workspace-synthesis-start").isEnabled())
      .toBe(true);
    await p.locator('[data-go="lib"]').click();
    await p.locator("#ckAll").check();
    await p.locator('[data-go="syn"]').click();
    await expect
      .poll(() => p.locator("#workspace-synthesis-question").inputValue())
      .toBe("Which evidence agrees?");
    expect(await p.locator("#workspace-synthesis-policy").inputValue()).toBe(
      "allow-partial",
    );
    expect(await p.locator("#workspace-synthesis-start").isDisabled()).toBe(
      true,
    );
    expect(await p.locator("#synthesis-composer").textContent()).toContain(
      "2 篇文献",
    );
    expect(w.env.modelCalls).toBe(0);
  } finally {
    await w.close();
  }
}, 30000);

it("retries a failed range pre-read in place, without claiming a task was submitted or discarding the draft", async () => {
  const w = await workspace();
  try {
    let injected = false;
    await w.page.route("**/api/v1/query/processors?*", async (route) => {
      if (!injected && route.request().postDataJSON().operation === "list") {
        injected = true;
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({
            protocol_version: 1,
            code: "service-unavailable",
          }),
        });
      } else await route.continue();
    });
    await w.page.locator('[data-go="ext"]').click();
    await w.page.locator("#processor-meaning").fill("A retained draft");
    await expect
      .poll(() => w.page.locator("#processor-scope-status").textContent())
      .toContain("尚未提交任务");
    await w.page
      .getByRole("button", { name: "重新读取范围", exact: true })
      .click();
    await expect
      .poll(() => w.page.locator("#processor-submit").isEnabled())
      .toBe(true);
    expect(await w.page.locator("#processor-meaning").inputValue()).toBe(
      "A retained draft",
    );
    expect(w.submissions).toHaveLength(0);
    expect(w.env.modelCalls).toBe(0);
  } finally {
    await w.close();
  }
}, 30000);

it("publishes an explicit reparse as the new default and shows its default receipt", async () => {
  const w = await workspace();
  try {
    const id = w.env.parseRequest.literature_id;
    w.env.setText("# Revised fixture\nThe NEWLY PARSED text is different.\n");
    await w.page.locator(`[data-ck="${id}"]`).check();
    await w.page.locator('#selectionHost [data-op="parse"]').click();
    await w.page.locator("#op-confirm").click();
    await expect
      .poll(() => w.page.locator("#op-status").textContent())
      .toContain("已提交 1 项");
    const job = (await w.env.app.jobs!.listJobs(10))[0]!;
    await expect
      .poll(
        async () =>
          (await w.env.app.processingTasks!.read(job.job_id)).job.status,
      )
      .toBe("completed");
    const current = await w.env.app.documentRead.default({
      literature_id: id,
      asset_id: w.env.asset.asset_id,
      asset_sha256: w.env.asset.sha256,
    });
    expect(current.default!.document_version_id).not.toBe(
      w.parsed.document.document_version_id,
    );
    await w.page.locator("[data-task]").last().click();
    await expect
      .poll(() => w.page.locator(".parse-default-status").textContent())
      .toContain("已设为默认全文");
    await w.page.locator('[data-go="lib"]').click();
    await w.page.locator(`[data-id="${id}"]`).click();
    await w.page.locator('[data-rm="doc"]').click();
    await expect
      .poll(() => w.page.locator(".reading-article").textContent())
      .toContain("NEWLY PARSED");
  } finally {
    await w.close();
  }
}, 30000);

it("explains missing analysis configuration with a recovery action while retaining the machine failure", async () => {
  const w = await workspace(false);
  try {
    await w.page
      .locator(`[data-ck="${w.env.parseRequest.literature_id}"]`)
      .check();
    await w.page.locator('#selectionHost [data-op="analyze"]').click();
    await w.page.locator("#op-confirm").click();
    await expect
      .poll(() => w.page.locator("#op-status").textContent())
      .toContain("已提交 1 项");
    const job = (await w.env.app.jobs!.listJobs(10))[0]!;
    await expect
      .poll(
        async () =>
          (await w.env.app.processingTasks!.read(job.job_id)).job.status,
      )
      .toBe("failed");
    await w.page.locator("[data-task]").last().click();
    await expect
      .poll(() => w.page.locator("#task-content").textContent())
      .toContain("保存后重启 Web 服务");
    expect(await w.page.locator("#task-content").textContent()).toContain(
      "knowledge-unconfigured",
    );
    await w.page
      .getByRole("button", { name: "前往模型设置", exact: true })
      .click();
    expect(new URL(w.page.url()).searchParams.get("setting")).toBe("models");
    expect(w.env.modelCalls).toBe(0);
  } finally {
    await w.close();
  }
}, 30000);
