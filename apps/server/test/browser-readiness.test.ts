import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { BrowserHost } from "../src/browser/host.js";
import { chromium, type Page } from "playwright";

const executablePath =
  process.env.SCIRETRIEVER_BROWSER_EXECUTABLE ?? chromium.executablePath();

it.runIf(existsSync(executablePath))(
  "observes a usable article with stalled scripts and fonts without exposing sensitive inputs",
  async () => {
    const profile = await mkdtemp(join(tmpdir(), "sciretriever-readiness-"));
    const server = createServer((req, res) => {
      if (req.url === "/pending.js" || req.url === "/pending.woff2") return;
      res.writeHead(200, { "content-type": "text/html" });
      res.end(
        '<title>Slow resources</title><style>@font-face{font-family:pending;src:url(/pending.woff2)}body{font-family:pending}</style><noscript>JavaScript is disabled</noscript><div style="display:none">Hidden login required</div><main>Article ready <button>Download PDF</button><input type="password" value="synthetic-private-input"></main><script src="/pending.js"></script>',
      );
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("fixture");
    const origin = `http://127.0.0.1:${address.port}`;
    const host = new BrowserHost({
      profile,
      executablePath,
      headless: true,
      admitNavigation: (url) => {
        if (new URL(url).origin !== origin) throw new Error("offline boundary");
        return url;
      },
    });
    try {
      await host.start();
      const page = await host.openPage(origin + "/article");
      const snapshot = await page.snapshot();
      expect(snapshot.loading).toBe(true);
      expect(snapshot.text).toContain("Article ready");
      expect(snapshot.text).not.toContain("synthetic-private-input");
      expect(snapshot.text).not.toContain("JavaScript is disabled");
      expect(snapshot.text).not.toContain("Hidden login required");
      expect(
        snapshot.elements?.some((element) => element.name === "Download PDF"),
      ).toBe(true);
      // A completed masked screenshot is also valid when fonts remain pending.
      // Verify the actual password-field pixels; a raw CDP fallback is forbidden.
      if (snapshot.screenshot !== null) {
        const browserPage = (
          host as unknown as { pages: Map<string, Page> }
        ).pages.get(page.id)!;
        const box = (await browserPage
          .locator('input[type="password"]')
          .boundingBox())!;
        const pixel = await browserPage.evaluate(
          async ({ encoded, x, y }) => {
            const image = new Image();
            image.src = "data:image/jpeg;base64," + encoded;
            await image.decode();
            const canvas = document.createElement("canvas");
            canvas.width = image.width;
            canvas.height = image.height;
            const context = canvas.getContext("2d")!;
            context.drawImage(image, 0, 0);
            return [...context.getImageData(x, y, 1, 1).data];
          },
          {
            encoded: Buffer.from(snapshot.screenshot).toString("base64"),
            x: Math.floor(box.x + box.width / 2),
            y: Math.floor(box.y + box.height / 2),
          },
        );
        expect(pixel[0]).toBeGreaterThan(220);
        expect(pixel[1]).toBeLessThan(35);
        expect(pixel[2]).toBeGreaterThan(220);
      }
    } finally {
      await host.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(profile, { recursive: true, force: true });
    }
  },
  15000,
);
