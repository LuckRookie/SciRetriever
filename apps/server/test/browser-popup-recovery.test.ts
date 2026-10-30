import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { chromium } from "playwright";
import { expect, it } from "vitest";
import { BrowserHost } from "../src/browser/host.js";
import { BrowserPageTransitionError } from "../src/browser/page-runtime.js";

it.each(["link", "script"] as const)(
  "recovers a %s popup before Page registration and re-admits its PDF navigation",
  async (mode) => {
    const root = await mkdtemp(join(tmpdir(), "sciretriever-popup-recovery-"));
    const server = createServer((request, response) => {
      if (request.url === "/slow") {
        response.writeHead(200, { "Content-Type": "image/png" });
        response.write(Buffer.from([137, 80, 78, 71]));
      } else if (request.url === "/viewer") {
        response.writeHead(200, {
          "Content-Type": "application/pdf",
          "Content-Disposition": "attachment; filename=synthetic.pdf",
        });
        response.end("%PDF-synthetic-popup\n" + "x".repeat(2000));
      } else {
        response.setHeader("Content-Type", "text/html");
        response.end(
          '<title>Article</title><img src="/slow">' +
            (mode === "link"
              ? '<a target="_blank" href="/viewer">Open PDF</a>'
              : "<button onclick=\"window.open('/viewer')\">Open PDF</button>"),
        );
      }
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Synthetic address unavailable");
    const origin = `http://127.0.0.1:${address.port}`;
    let first = true;
    const admissions: string[] = [],
      failures: string[] = [],
      captures: string[] = [];
    let pagePresent: boolean | undefined;
    const host = new BrowserHost({
      profile: join(root, "profile"),
      executablePath: chromium.executablePath(),
      headless: true,
      admitNavigation: (url) => {
        if (new URL(url).origin !== origin) throw new Error("Offline boundary");
        return url;
      },
      beforeRequest: async (binding, url, drain) => {
        if (new URL(url).pathname !== "/viewer") return;
        admissions.push(binding.request_id);
        if (first) {
          first = false;
          pagePresent = (await host.listPages()).some(
            (p) => p.id === binding.page_id,
          );
          const result = await drain();
          expect(result).toEqual({ kind: "retry-navigation" });
          return result;
        }
      },
      navigationRetryFailed: () => {
        failures.push("navigation-retry-failed");
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
          let bytes = 0;
          for await (const chunk of input.chunks) bytes += chunk.length;
          expect(bytes).toBeGreaterThan(2000);
          captures.push(input.capture.session_id);
        },
        failed: (_id, _capture, code) => {
          failures.push(code ?? "transfer-failed");
        },
      },
    });
    try {
      await host.start();
      const page = await host.openPage(origin + "/article");
      let ready: Awaited<ReturnType<typeof page.snapshot>> | undefined;
      await expect
        .poll(async () => {
          try {
            ready = await page.snapshot();
            return true;
          } catch (error) {
            if (error instanceof BrowserPageTransitionError) return false;
            throw error;
          }
        })
        .toBe(true);
      const element = ready!.elements!.find((e) => e.name === "Open PDF")!;
      expect(element).toBeDefined();
      await page.apply(
        { kind: "click-element", element_id: element.element_id, revision: 1 },
        ready!.document_generation!,
        () => true,
      );
      await expect.poll(() => captures.length, { timeout: 20_000 }).toBe(1);
      expect(pagePresent).toBe(false);
      expect(admissions).toHaveLength(2);
      expect(new Set(admissions).size).toBe(2);
      expect(captures).toEqual([host.sessionForPage(page.id)]);
      expect(failures).toEqual([]);
    } finally {
      await host.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  },
  30000,
);
