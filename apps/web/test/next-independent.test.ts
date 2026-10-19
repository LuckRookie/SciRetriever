import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { expect, it } from "vitest";
import { startQueryOnlyWorkbench } from "../../server/src/bootstrap/workbench.js";
import { startQueryOnlyHttp } from "../../server/src/workbench/http.js";
import { createQueryApplication } from "../../server/src/bootstrap/application.js";
import { coreProcessingFixture } from "../../server/test/core-processing-fixture.js";
import {
  independentNextAssets,
  motionOptions,
} from "./next-workspace-fixture.js";
import { readingAssets } from "./reading-assets-fixture.js";
const launch = () =>
  chromium.launch({
    ...(process.env.SCIRETRIEVER_BROWSER_EXECUTABLE
      ? { executablePath: process.env.SCIRETRIEVER_BROWSER_EXECUTABLE }
      : {}),
    headless: true,
  });

it("shows an uninitialized React query entry without creating any database or obtaining a Browser grant", async () => {
  const parent = await mkdtemp(
    join(tmpdir(), "sciretriever-react-query-empty-"),
  );
  const workbench = await startQueryOnlyWorkbench({
    home: join(parent, "not-created"),
    assets: await independentNextAssets("query"),
  });
  const browser = await launch();
  try {
    const page = await browser.newPage(motionOptions());
    const paths: string[] = [],
      errors: string[] = [];
    page.on("request", (request) =>
      paths.push(new URL(request.url()).pathname),
    );
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${workbench.origin}/`);
    await page.getByText(/文献库尚未初始化/).waitFor();
    expect(await readdir(parent)).toEqual([]);
    expect(paths).not.toContain("/api/clients");
    expect(paths).not.toContain("/auth/status");
    expect(paths.some((path) => path.startsWith("/api/v1/maintenance/"))).toBe(
      false,
    );
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
    await workbench.close();
    await rm(parent, { recursive: true, force: true });
  }
}, 60000);

it("reuses a fixed parsed material from the React maintenance entry under its original cookie and CSRF contract", async () => {
  const env = await coreProcessingFixture();
  await env.app.documentProcessing.parseDocuments(env.parseRequest);
  const query = await createQueryApplication(env.home);
  const assets = new Map([
    ...(await readingAssets()),
    ...(await independentNextAssets("maintenance")),
  ]);
  const server = await startQueryOnlyHttp({
    application: query,
    maintenance: env.app.maintenance!,
    assets,
  });
  const browser = await launch();
  try {
    const page = await browser.newPage(motionOptions());
    const paths: string[] = [],
      errors: string[] = [];
    page.on("request", (request) =>
      paths.push(new URL(request.url()).pathname),
    );
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${server.origin}/?view=set`);
    await page
      .getByLabel("文献编号", { exact: true })
      .fill(env.parseRequest.literature_id);
    await page
      .getByRole("button", { name: "从文献库读取当前 PDF", exact: true })
      .click();
    await page
      .getByText("已选择当前 PDF 与默认文档版本。", { exact: true })
      .waitFor();
    await page
      .getByRole("button", { name: "发布可读表示", exact: true })
      .click();
    await page
      .getByRole("dialog", { name: "发布可读表示？" })
      .getByRole("button", { name: "发布可读表示", exact: true })
      .click();
    await expect
      .poll(() =>
        page
          .getByRole("status")
          .filter({ hasText: /解析表示已保存/ })
          .count(),
      )
      .toBe(1);
    expect(env.modelCalls).toBe(0);
    expect(paths).not.toContain("/api/clients");
    expect(paths).not.toContain("/api/tasks");
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
    await server.close();
    await query.close();
    await env.close();
  }
}, 60000);
