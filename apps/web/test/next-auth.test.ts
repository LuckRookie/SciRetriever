import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { loadAuthAssets } from "../../server/src/workbench/assets.js";
import { chromium } from "playwright";
import { expect, it } from "vitest";
import { nextAssets } from "./next-workspace-fixture.js";
import { ProductionWorkbenchSession } from "../../server/src/workbench/production-session.js";
import { startWorkbenchHttp } from "../../server/src/workbench/http.js";
import {
  workbenchTestAccess,
  WORKBENCH_TEST_PASSWORD,
} from "../../server/test/workbench-auth-fixture.js";
import { loginDestination } from "../src/app/data/auth.js";

it("accepts only same-origin workspace return destinations", () => {
  const origin = "http://127.0.0.1:4174";
  expect(loginDestination("?next=%2F%3Fview%3Dweb", origin)).toBe("/?view=web");
  for (const next of [
    "https://example.com/",
    "//example.com/",
    "/auth",
    "/api/view",
    "javascript:alert(1)",
  ])
    expect(loginDestination(`?next=${encodeURIComponent(next)}`, origin)).toBe(
      "/",
    );
});

it.each(["no-preference", "reduce"] as const)(
  "uses the independent React login under the unchanged CSP and preserves a current workspace bookmark (%s)",
  async (reducedMotion) => {
    const directory = await mkdtemp(join(tmpdir(), "sciretriever-react-auth-"));
    const session = new ProductionWorkbenchSession(null, undefined);
    const browser = await chromium.launch({
      ...(process.env.SCIRETRIEVER_BROWSER_EXECUTABLE
        ? { executablePath: process.env.SCIRETRIEVER_BROWSER_EXECUTABLE }
        : {}),
      headless: true,
    });
    let server: Awaited<ReturnType<typeof startWorkbenchHttp>> | undefined;
    try {
      await promisify(execFile)(process.execPath, [
        "--input-type=module",
        "-e",
        "import { buildAuthAssets } from './scripts/build-react-assets.mjs'; await buildAuthAssets(process.argv[1]);",
        directory,
      ]);
      const assets = new Map(await nextAssets());
      for (const [path, asset] of await loadAuthAssets(
        pathToFileURL(`${directory}/`),
      ))
        assets.set(path, asset);
      server = await startWorkbenchHttp({
        session,
        assets,
        access: workbenchTestAccess,
      });
      const page = await browser.newPage({ reducedMotion });
      const errors: string[] = [],
        violations: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (message) => {
        if (
          message.type() === "error" &&
          /Content Security Policy|font|woff|OTS parsing/iu.test(message.text())
        )
          violations.push(message.text());
      });
      await page.goto(`${server.origin}/?view=web`);
      await page.getByRole("heading", { name: "打开你的文献库" }).waitFor();
      const fontStatus = await page.evaluate(async () => {
        const families = [
          "IBM Plex Sans",
          "Source Serif 4",
          "Noto Sans SC",
          "Noto Serif SC",
        ];
        return Promise.all(
          families.map(async (family) => {
            const faces = await document.fonts.load(
              `16px "${family}"`,
              "文献库 SciRetriever",
            );
            return {
              family,
              loaded:
                faces.length > 0 &&
                faces.every((face) => face.status === "loaded"),
            };
          }),
        );
      });
      expect(fontStatus).toEqual([
        { family: "IBM Plex Sans", loaded: true },
        { family: "Source Serif 4", loaded: true },
        { family: "Noto Sans SC", loaded: true },
        { family: "Noto Serif SC", loaded: true },
      ]);
      const input = page.getByLabel("密码或 API key");
      await input.fill("incorrect");
      await page.getByRole("button", { name: "显示密码" }).click();
      expect(await input.getAttribute("type")).toBe("text");
      await page.getByRole("button", { name: "隐藏密码" }).click();
      expect(await input.getAttribute("type")).toBe("password");
      await page.getByRole("button", { name: "进入文献库" }).click();
      await expect
        .poll(() => page.getByRole("alert").textContent())
        .toContain("密码或 API key 不正确");
      expect(await input.getAttribute("aria-invalid")).toBe("true");
      await input.fill(WORKBENCH_TEST_PASSWORD);
      await page.getByRole("button", { name: "进入文献库" }).click();
      await page
        .getByRole("tab", { name: "浏览器", exact: true, selected: true })
        .waitFor();
      expect(new URL(page.url()).pathname).toBe("/");
      expect(new URL(page.url()).searchParams.get("view")).toBe("web");
      expect(
        await page.evaluate(() =>
          Object.values(localStorage).some((value) =>
            String(value).includes("synthetic-workbench-test-password"),
          ),
        ),
      ).toBe(false);
      // Another tab may reauthenticate in the same browser. The shared login
      // cookie is valid, but this tab's old workbench grant has been revoked.
      expect(
        (
          await page.context().request.post(`${server.origin}/auth/login`, {
            headers: { Origin: server.origin, "X-Workbench-Init": "1" },
            data: { password: WORKBENCH_TEST_PASSWORD },
          })
        ).status(),
      ).toBe(200);
      const reattached = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === "/api/clients" &&
          response.status() === 201,
      );
      await page.getByRole("button", { name: "刷新会话" }).click();
      await reattached;
      await page
        .getByRole("tab", { name: "浏览器", exact: true, selected: true })
        .waitFor();
      expect(new URL(page.url()).searchParams.get("view")).toBe("web");
      expect(errors).toEqual([]);
      expect(violations).toEqual([]);
    } finally {
      await server?.close();
      await session.close();
      await browser.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
  60000,
);
