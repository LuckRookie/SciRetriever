import { randomBytes } from "node:crypto";
import { chromium } from "playwright";
import { expect, it } from "vitest";
import { startWorkbenchHttp } from "../../server/src/workbench/http.js";
import { ProductionWorkbenchSession } from "../../server/src/workbench/production-session.js";
import { designSamplesAssets } from "./design-samples-assets.js";

it(
  "includes the current production login page in the design sample assets",
  { timeout: 0 },
  async () => {
    const session = new ProductionWorkbenchSession(null, async () => {
      throw new Error("Unexpected synthetic acquisition");
    });
    const server = await startWorkbenchHttp({
      session,
      access: {
        host: "127.0.0.1",
        password: randomBytes(32).toString("base64url"),
      },
      assets: await designSamplesAssets(),
    });
    const browser = await chromium.launch({
      ...(process.env.SCIRETRIEVER_BROWSER_EXECUTABLE
        ? { executablePath: process.env.SCIRETRIEVER_BROWSER_EXECUTABLE }
        : {}),
      headless: true,
    });
    try {
      const page = await browser.newPage(),
        errors: string[] = [];
      await page.route("**/*", (route) =>
        new URL(route.request().url()).origin === server.origin
          ? route.continue()
          : route.abort("blockedbyclient"),
      );
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (message) => {
        if (message.type() === "error") errors.push(message.text());
      });
      const response = await page.goto(server.origin + "/auth");
      const csp = response?.headers()["content-security-policy"];
      expect(csp?.match(/font-src [^;]+/u)?.[0]).toBe("font-src 'self' blob:");
      await page.locator('input[type="password"]').waitFor();
      expect(await page.locator('form button[type="submit"]').isVisible()).toBe(
        true,
      );
      expect(
        await page.evaluate(async () => {
          const faces = await document.fonts.load(
            '28px "Source Serif 4"',
            "SciRetriever",
          );
          return (
            faces.length > 0 && faces.every((face) => face.status === "loaded")
          );
        }),
      ).toBe(true);
      expect(errors).toEqual([]);
    } finally {
      await browser.close();
      await server.close();
      await session.close();
    }
  },
);
