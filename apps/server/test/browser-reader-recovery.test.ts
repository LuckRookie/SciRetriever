import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright";
import { expect, it } from "vitest";
import { BrowserHost, type BrowserPageHandle } from "../src/browser/host.js";
import { BrowserPageTransitionError } from "../src/browser/page-runtime.js";
import type { BrowserPageSnapshot } from "../src/browser/observation.js";

async function observe(page: BrowserPageHandle, title: string) {
  let snapshot: BrowserPageSnapshot | undefined;
  await expect
    .poll(
      async () => {
        try {
          snapshot = await page.snapshot();
          return snapshot.title;
        } catch (error) {
          if (error instanceof BrowserPageTransitionError) return "transition";
          throw error;
        }
      },
      { timeout: 25000 },
    )
    .toBe(title);
  return snapshot!;
}

it.each([false, true])(
  "recovers a same-tab reader after admission exceeds the RPC timeout (redirect=%s)",
  async (redirect) => {
    const directory = await mkdtemp(
      join(tmpdir(), "sciretriever-reader-recovery-"),
    );
    const bytes = Buffer.from("%PDF-synthetic-reader\n" + "x".repeat(2000));
    const hits: string[] = [];
    const server = createServer((request, response) => {
      hits.push(request.url!);
      if (request.url === "/slow") {
        response.writeHead(200, { "Content-Type": "image/png" });
        response.write(Buffer.from([137, 80, 78, 71]));
      } else if (request.url === "/epdf" && redirect) {
        response.writeHead(302, { location: "/reader" });
        response.end();
      } else if (request.url === "/epdf" || request.url === "/reader") {
        response.setHeader("Content-Type", "text/html");
        response.end(
          '<title>Synthetic reader</title><main>Reader</main><script>fetch("/pdf")</script>',
        );
      } else if (request.url === "/pdf") {
        response.writeHead(200, {
          "Content-Type": "application/pdf",
          "Content-Disposition": "attachment; filename=synthetic.pdf",
        });
        response.end(bytes);
      } else {
        response.setHeader("Content-Type", "text/html");
        response.end(
          '<title>Synthetic article</title><img src="/slow"><a href="/epdf">ePDF</a>',
        );
      }
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Fixture address unavailable");
    const origin = `http://127.0.0.1:${address.port}`;
    const admissions: {
      id: string;
      page: string;
      path: string;
      redirect: string | null;
    }[] = [];
    const failures: string[] = [];
    const captures: { session: string; page: string; bytes: Buffer }[] = [];
    let replayed = false;
    const host = new BrowserHost({
      profile: join(directory, "profile"),
      executablePath: chromium.executablePath(),
      headless: true,
      admitNavigation: (url) => {
        if (new URL(url).origin !== origin) throw new Error("Offline boundary");
        return url;
      },
      beforeRequest: async (binding, url, drain) => {
        const path = new URL(url).pathname;
        admissions.push({
          id: binding.request_id,
          page: binding.page_id,
          path,
          redirect: binding.redirected_request_id,
        });
        if (path !== "/epdf") return;
        if (!replayed) {
          replayed = true;
          const result = await drain();
          expect(result).toEqual({ kind: "retry-navigation" });
          return result;
        }
        // An owned navigation must wait for admission, not a generic 15 s RPC.
        // The article signal still cancels this wait and the replay command.
        await delay(16000, undefined, { signal: binding.signal });
        expect(hits).not.toContain("/epdf");
      },
      navigationRetryFailed: () => failures.push("navigation-retry-failed"),
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
          const chunks: Uint8Array[] = [];
          for await (const chunk of input.chunks) chunks.push(chunk);
          captures.push({
            session: input.capture.session_id,
            page: input.capture.page_id,
            bytes: Buffer.concat(chunks),
          });
        },
        failed: () => failures.push("transfer-failed"),
      },
    });
    try {
      await host.start();
      const page = await host.openPage(origin + "/article");
      const initial = await observe(page, "Synthetic article");
      const link = initial.elements!.find(
        (element) => element.name === "ePDF",
      )!;
      await page.apply(
        { kind: "click-element", element_id: link.element_id, revision: 1 },
        initial.document_generation!,
        () => true,
      );
      await observe(page, "Synthetic reader");
      await expect.poll(() => captures.length, { timeout: 20_000 }).toBe(1);
      expect(failures).toEqual([]);
      expect(captures).toEqual([
        { session: host.sessionForPage(page.id), page: page.id, bytes },
      ]);
      const epdf = admissions.filter((entry) => entry.path === "/epdf");
      expect(epdf).toHaveLength(2);
      expect(new Set(epdf.map((entry) => entry.id)).size).toBe(2);
      expect(epdf.every((entry) => entry.page === page.id)).toBe(true);
      expect(hits.filter((path) => path === "/epdf")).toHaveLength(1);
      expect(hits.filter((path) => path === "/pdf")).toHaveLength(1);
      if (redirect)
        expect(
          admissions.find((entry) => entry.path === "/reader")?.redirect,
        ).toBe(epdf[1]!.id);
    } finally {
      await host.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  },
  45000,
);
