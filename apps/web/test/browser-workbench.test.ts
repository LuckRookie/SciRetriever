import { once } from "node:events";
import { type Server } from "node:http";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from "playwright";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";

import { createPreviewServer } from "../src/preview-server.js";

let server: Server;
let browser: Browser;
let context: BrowserContext;
let page: Page;
let origin: string;
let failures: string[];

beforeAll(async () => {
  server = createPreviewServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("preview fixture did not start");
  origin = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({
    executablePath:
      process.env.SCIRETRIEVER_BROWSER_EXECUTABLE ??
      "/home/duanjw/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome",
    headless: true,
  });
}, 30_000);

beforeEach(async () => {
  failures = [];
  context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  await context.route("**/*", async (route) => {
    if (new URL(route.request().url()).origin !== origin) {
      failures.push("unexpected external request");
      await route.abort();
    } else await route.continue();
  });
  page = await context.newPage();
  page.on("pageerror", (error) => failures.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning")
      failures.push(message.text());
  });
  await page.goto(origin);
});

afterEach(async () => {
  await context?.close();
  expect(failures).toEqual([]);
});

afterAll(async () => {
  await browser?.close();
  if (server)
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
});

it("serves only sample assets and refuses filesystem paths and mutations", async () => {
  const response = await page.request.get(`${origin}/`);
  expect(response.headers()["content-security-policy"]).toContain(
    "connect-src 'none'",
  );
  expect(await response.text()).toContain("合成示例");
  for (const path of [
    "/config.toml",
    "/src/main.ts",
    "/preview.js",
    "/%2e%2e/package.json",
  ]) {
    expect((await page.request.get(`${origin}${path}`)).status()).toBe(404);
  }
  expect((await page.request.post(origin)).status()).toBe(405);
  expect((await page.request.head(origin)).status()).toBe(200);
});

it("requires human takeover for page input and explicit confirmation for sample publication", async () => {
  expect(await page.locator("#pdf-button").isDisabled()).toBe(true);
  await page.getByRole("button", { name: "人工接管", exact: true }).click();
  expect(await page.locator("#pdf-button").isEnabled()).toBe(true);
  expect(await page.locator("#run-button").isDisabled()).toBe(true);
  await page.locator("#pdf-button").click();
  await page.locator("#candidate-result").waitFor({ state: "visible" });
  expect(await page.locator("#library-count").textContent()).toBe("0");
  await page
    .getByRole("button", { name: "确认入库（演示）", exact: true })
    .click();
  expect(await page.locator("#library-count").textContent()).toBe("1");
  expect(await page.locator("#publish-button").isDisabled()).toBe(true);
  await page.reload();
  expect(await page.locator("#library-count").textContent()).toBe("0");
  expect(await page.locator("#candidate-result").isHidden()).toBe(true);
}, 15_000);

it("keeps uncertain candidates unpublished and explains rejected network requests", async () => {
  await page.getByRole("button", { name: "身份待确认", exact: true }).click();
  await page.locator("#run-button").click();
  await page.locator("#candidate-result").waitFor({ state: "visible" });
  expect(await page.locator("#publish-button").isDisabled()).toBe(true);
  expect(await page.locator("#version-evidence").textContent()).toContain(
    "缺少",
  );
  await page.getByRole("button", { name: "网络拒绝", exact: true }).click();
  await page.locator("#run-button").click();
  await expect
    .poll(() => page.locator("#view-caption").textContent())
    .toBe("示例请求被网络策略拒绝");
  expect(await page.locator("#candidate-result").isHidden()).toBe(true);
  expect(await page.locator("#observation-text").textContent()).toContain(
    "切换其他样本场景",
  );
  expect(await page.locator("#run-button").isEnabled()).toBe(true);
}, 15_000);

it("stops delayed capture after takeover, pause, cancellation and scenario changes", async () => {
  await page.locator("#run-button").click();
  await page.locator("#takeover-button").click();
  await page.waitForTimeout(1200);
  expect(await page.locator("#candidate-result").isHidden()).toBe(true);
  await page.locator("#takeover-button").click();
  await page.locator("#run-button").click();
  await page.locator("#pause-button").click();
  await page.waitForTimeout(1200);
  expect(await page.locator("#view-caption").textContent()).toBe("演示已暂停");
  expect(await page.locator("#candidate-result").isHidden()).toBe(true);
  await page.locator("#run-button").click();
  await page.locator("#cancel-button").click();
  await page.waitForTimeout(1200);
  expect(await page.locator("#candidate-result").isHidden()).toBe(true);
  expect(await page.locator("#view-caption").textContent()).toBe("会话已取消");
  await page.getByRole("button", { name: "重新演示" }).click();
  await page.locator("#run-button").click();
  await page.getByRole("button", { name: "身份待确认", exact: true }).click();
  await page.waitForTimeout(1200);
  expect(await page.locator("#candidate-result").isHidden()).toBe(true);
}, 20_000);

it("supports the 390px drawer and keyboard without horizontal overflow", async () => {
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.locator("#mobile-details-button").focus();
  await page.keyboard.press("Enter");
  expect(
    await page.locator("#mobile-details-button").getAttribute("aria-expanded"),
  ).toBe("true");
  expect(
    await page
      .locator(".mobile-close")
      .evaluate((node) => node === document.activeElement),
  ).toBe(true);
  await page.keyboard.press("Escape");
  expect(
    await page.locator("#mobile-details-button").getAttribute("aria-expanded"),
  ).toBe("false");
  expect(
    await page
      .locator("#mobile-details-button")
      .evaluate((node) => node === document.activeElement),
  ).toBe(true);
  await page.locator("#run-button").click();
  await expect
    .poll(() => page.locator("#candidate-count").textContent())
    .toBe("1");
  await page.locator("#mobile-details-button").click();
  await page.locator("#publish-button").click();
  expect(await page.locator("#library-count").textContent()).toBe("1");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
}, 15_000);
