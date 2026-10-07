import { createHash } from "node:crypto";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { sha256, type CandidateCapture } from "@sciretriever/contracts";
import {
  BrowserHost,
  BrowserHostRuntimeError,
  type BrowserPageHandle,
} from "../src/browser/host.js";
import type { BrowserArticleSessionIdentity } from "../src/browser/article-session.js";
import type { OwnedBrowserCdpConnection } from "../src/browser/cdp.js";
import type { BrowserCdpOwner } from "../src/browser/cdp-owner.js";
import { BrowserPageTransitionError } from "../src/browser/page-runtime.js";
import type { BrowserPageSnapshot } from "../src/browser/observation.js";
import { BrowserDownloadResources } from "../src/browser/resources.js";
import { verifyInstalledCloakRuntime } from "../src/configuration/cloak-runtime.js";
import { chromium, type Page } from "playwright";

const executable =
  process.env.SCIRETRIEVER_BROWSER_EXECUTABLE ?? chromium.executablePath();
const bundle = process.env.SCIRETRIEVER_CLOAK_BUNDLE;
const available = Boolean(bundle) || existsSync(executable);
async function identity(
  name: "a" | "b",
): Promise<BrowserArticleSessionIdentity> {
  return {
    session_id: "session-" + name,
    operation_id: "operation-fixture",
    generation: 1,
    literature_id:
      "00000000-0000-0000-0000-00000000000" + (name === "a" ? "1" : "2"),
    metadata_snapshot: { revision: 1, sha256: await sha256(new Uint8Array()) },
  };
}
async function fixture(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
) {
  const directory = await mkdtemp(
    join(tmpdir(), "sciretriever-owned-sessions-"),
  );
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("synthetic server unavailable");
  const origin = "http://127.0.0.1:" + address.port;
  const runtime = bundle
    ? await verifyInstalledCloakRuntime(bundle)
    : undefined;
  return {
    directory,
    origin,
    runtime,
    server,
    launch: runtime
      ? { runtime }
      : { executablePath: executable, headless: true },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(join(directory, "profile"), { recursive: true, force: true });
      if (!bundle) await rm(directory, { recursive: true, force: true });
    },
  };
}
function html(response: ServerResponse, name: string): void {
  response.writeHead(200, { "Content-Type": "text/html" });
  response.end(
    `<title>${name}:0</title><main><button>Count</button><a href="/same.pdf" target="_blank">PDF</a></main><script>document.querySelector("button").onclick=()=>document.title="${name}:1"</script>`,
  );
}
async function click(page: BrowserPageHandle, name: string): Promise<void> {
  const snapshot = await readySnapshot(page);
  const element = snapshot.elements!.find((item) => item.name === name)!;
  expect(element).toBeDefined();
  await page.apply(
    { kind: "click-element", element_id: element.element_id, revision: 1 },
    snapshot.document_generation!,
    () => true,
  );
}
async function readySnapshot(
  page: BrowserPageHandle,
): Promise<BrowserPageSnapshot> {
  let snapshot: BrowserPageSnapshot | undefined;
  await expect
    .poll(
      async () => {
        try {
          snapshot = await page.snapshot();
          return true;
        } catch (error) {
          if (error instanceof BrowserPageTransitionError) return false;
          throw error;
        }
      },
      { timeout: 15000 },
    )
    .toBe(true);
  return snapshot!;
}
function capture(
  identities: ReadonlyMap<string, BrowserArticleSessionIdentity>,
  page: string,
  generation: number,
  url: string,
  session?: string,
): CandidateCapture | null {
  const owner = session ? identities.get(session) : undefined;
  return owner
    ? {
        session_id: owner.session_id,
        article_id: owner.literature_id,
        page_id: page,
        document_generation: generation,
        source_url: url,
        captured_at: "2026-10-05T00:00:00Z",
      }
    : null;
}

it.runIf(available).each([1, 2, 3])(
  "owns two same-URL popup PDF hashes independently through the production Host (round %s)",
  async (round) => {
    const bytesA = Buffer.from("%PDF-synthetic-A\n" + "A".repeat(2000));
    const bytesB = Buffer.from("%PDF-synthetic-B\n" + "B".repeat(3000));
    const captured: {
      session: string;
      article: string;
      page: string;
      hash: string;
    }[] = [];
    const admissions: { session: string; page: string; path: string }[] = [];
    const failures: string[] = [];
    const drained = new Set<string>();
    const f = await fixture((request, response) => {
      if (request.url === "/same.pdf") {
        const content = request.headers.referer?.endsWith("/article/a")
          ? bytesA
          : bytesB;
        response.writeHead(200, {
          "Content-Type": "application/pdf",
          "Content-Disposition": 'attachment; filename="same.pdf"',
          "Content-Length": content.length,
        });
        response.end(content);
        return;
      }
      html(response, request.url === "/article/a" ? "A" : "B");
    });
    const a = await identity("a");
    const b = await identity("b");
    const identities = new Map([
      [a.session_id, a],
      [b.session_id, b],
    ]);
    const resources = new BrowserDownloadResources({
      available_bytes: async () => 10 * 1024 ** 3,
    });
    const host = new BrowserHost({
      profile: join(f.directory, "profile"),
      ...f.launch,
      admitNavigation: (url) => {
        if (new URL(url).origin !== f.origin)
          throw new Error("offline boundary");
        return url;
      },
      beforeRequest: async (owner, url) => {
        admissions.push({
          session: owner.session_id,
          page: owner.page_id,
          path: new URL(url).pathname,
        });
      },
      transfers: {
        resources: () => resources,
        captureContext: (page, generation, url, session) =>
          capture(identities, page, generation, url, session),
        receive: async (input) => {
          const hash = createHash("sha256");
          for await (const chunk of input.chunks) hash.update(chunk);
          captured.push({
            session: input.capture.session_id,
            article: input.capture.article_id,
            page: input.capture.page_id,
            hash: hash.digest("hex"),
          });
        },
        completed: (_transfer, owner) => {
          void host.stopSessionNetwork(owner.session_id).then(() => {
            drained.add(owner.session_id);
          });
        },
        failed: (_transfer, _owner, code) => failures.push(code ?? "unknown"),
      },
    });
    try {
      await host.start();
      const pageA = await host.openPage(f.origin + "/article/a", a);
      const pageB = await host.openPage(f.origin + "/article/b", b);
      const snapshotA = await readySnapshot(pageA);
      const snapshotB = await readySnapshot(pageB);
      expect((await host.listPages()).find((page) => page.active)?.id).toBe(
        pageB.id,
      );
      const pdfA = snapshotA.elements!.find((item) => item.name === "PDF")!;
      const pdfB = snapshotB.elements!.find((item) => item.name === "PDF")!;
      await pageA.apply(
        { kind: "click-element", element_id: pdfA.element_id, revision: 1 },
        snapshotA.document_generation!,
        () => true,
      );
      await pageB.apply(
        { kind: "click-element", element_id: pdfB.element_id, revision: 1 },
        snapshotB.document_generation!,
        () => true,
      );
      await expect.poll(() => captured.length, { timeout: 15000 }).toBe(2);
      await expect.poll(() => drained.size, { timeout: 5000 }).toBe(2);
      expect(failures).toEqual([]);
      const expectedA = createHash("sha256").update(bytesA).digest("hex");
      const expectedB = createHash("sha256").update(bytesB).digest("hex");
      expect(captured).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            session: a.session_id,
            article: a.literature_id,
            hash: expectedA,
          }),
          expect.objectContaining({
            session: b.session_id,
            article: b.literature_id,
            hash: expectedB,
          }),
        ]),
      );
      expect(new Set(captured.map((item) => item.page)).size).toBe(2);
      for (const result of captured)
        expect(admissions).toContainEqual({
          session: result.session,
          page: result.page,
          path: "/same.pdf",
        });
      await pageA.settleCaptures!();
      await pageB.settleCaptures!();
      expect(resources.snapshot().native_bytes).toBe(0);
      if (bundle) {
        await writeFile(
          join(f.directory, "events.json"),
          JSON.stringify(
            {
              round,
              runtime_version: f.runtime!.version,
              admissions,
              captured,
              resources: resources.snapshot(),
              forbidden_external_requests: 0,
            },
            null,
            2,
          ),
        );
        console.info("synthetic owned Host evidence:", f.directory);
      }
    } finally {
      await host.close();
      await f.close();
    }
  },
  45000,
);

it.runIf(available)(
  "keeps an admitted background request alive after B gains foreground",
  async () => {
    let release: (() => void) | undefined;
    const requests: string[] = [];
    const f = await fixture((request, response) => {
      requests.push(request.url ?? "");
      if (request.url === "/gate") {
        release = () => response.end("continue");
        return;
      }
      if (request.url === "/late") {
        response.end("owned");
        return;
      }
      response.writeHead(200, { "Content-Type": "text/html" });
      response.end(
        request.url === "/article/a"
          ? '<title>A waiting</title><script>fetch("/gate").then(()=>fetch("/late")).then(()=>document.title="A complete")</script>'
          : "<title>B foreground</title>",
      );
    });
    const host = new BrowserHost({
      profile: join(f.directory, "profile"),
      ...f.launch,
      admitNavigation: (url) => url,
    });
    try {
      await host.start();
      const a = await host.openPage(
        f.origin + "/article/a",
        await identity("a"),
      );
      await expect.poll(() => Boolean(release)).toBe(true);
      const b = await host.openPage(
        f.origin + "/article/b",
        await identity("b"),
      );
      expect((await host.listPages()).find((page) => page.active)?.id).toBe(
        b.id,
      );
      release!();
      await expect.poll(() => a.title()).toBe("A complete");
      expect(requests.filter((path) => path === "/late")).toHaveLength(1);
    } finally {
      release?.();
      await host.close();
      await f.close();
    }
  },
  30000,
);

it.runIf(available)(
  "owns simultaneous script-created same-URL PDF popups before Page creation",
  async () => {
    const releases: (() => void)[] = [];
    const captures: string[] = [];
    const pdfOwners = new Set<string>();
    const f = await fixture((request, response) => {
      if (request.url?.startsWith("/gate/")) {
        releases.push(() => response.end("go"));
        return;
      }
      if (request.url === "/same.pdf") {
        response.writeHead(200, {
          "Content-Type": "application/pdf",
          "Content-Disposition": "attachment",
        });
        response.end("%PDF-script-owned\n" + "A".repeat(512));
        return;
      }
      response.writeHead(200, { "Content-Type": "text/html" });
      response.end(
        '<title>Script popup fixture</title><script>fetch("/gate/"+location.pathname.split("/").pop()).then(()=>window.open("/same.pdf"))</script>',
      );
    });
    const a = await identity("a");
    const b = await identity("b");
    const identities = new Map([
      [a.session_id, a],
      [b.session_id, b],
    ]);
    let releasePdf!: () => void;
    const bothPdf = new Promise<void>((resolve) => {
      releasePdf = resolve;
    });
    const host = new BrowserHost({
      profile: join(f.directory, "profile"),
      ...f.launch,
      admitNavigation: (url) => url,
      beforeRequest: async (owner, url) => {
        if (new URL(url).pathname === "/same.pdf") {
          pdfOwners.add(owner.session_id);
          if (pdfOwners.size === 2) releasePdf();
          await bothPdf;
        }
      },
      transfers: {
        captureContext: (page, generation, url, session) =>
          capture(identities, page, generation, url, session),
        receive: async (input) => {
          for await (const chunk of input.chunks)
            expect(chunk.byteLength).toBeGreaterThan(0);
          captures.push(input.capture.session_id);
        },
        failed: () => {
          throw new Error("unexpected script popup failure");
        },
      },
    });
    try {
      await host.start();
      const pageA = await host.openPage(f.origin + "/article/a", a);
      const pageB = await host.openPage(f.origin + "/article/b", b);
      await expect.poll(() => releases.length).toBe(2);
      for (const release of releases) release();
      await expect.poll(() => captures.length, { timeout: 15000 }).toBe(2);
      expect(new Set(captures)).toEqual(new Set([a.session_id, b.session_id]));
      await pageA.settleCaptures!();
      await pageB.settleCaptures!();
    } finally {
      releasePdf();
      for (const release of releases) release();
      await host.close();
      await f.close();
    }
  },
  30000,
);

it.runIf(available)(
  "refuses a popup's held first request after its article closes",
  async () => {
    let releasePopup!: () => void;
    const popupAllowed = new Promise<void>((resolve) => {
      releasePopup = resolve;
    });
    let popupPaused = false;
    let pdfRequests = 0;
    const f = await fixture((request, response) => {
      if (request.url === "/same.pdf") pdfRequests++;
      html(response, "late");
    });
    const host = new BrowserHost({
      profile: join(f.directory, "profile"),
      ...f.launch,
      admitNavigation: (url) => url,
      beforeRequest: async (_owner, url) => {
        if (new URL(url).pathname === "/same.pdf") {
          popupPaused = true;
          await popupAllowed;
        }
      },
    });
    try {
      await host.start();
      const page = await host.openPage(
        f.origin + "/article/a",
        await identity("a"),
      );
      await click(page, "PDF");
      await expect.poll(() => popupPaused).toBe(true);
      await page.close();
      releasePopup();
      await host.openPage(f.origin + "/article/b", await identity("b"));
      expect(pdfRequests).toBe(0);
      await expect(
        host.openPage(f.origin + "/article/a", await identity("a")),
      ).rejects.toBeDefined();
    } finally {
      releasePopup();
      await host.close();
      await f.close();
    }
  },
  30000,
);

it.runIf(available)(
  "closes A without waiting for B's unfinished native download",
  async () => {
    let finish: (() => void) | undefined;
    const started = new Set<string>();
    const received: string[] = [];
    const f = await fixture((request, response) => {
      if (request.url === "/same.pdf") {
        response.writeHead(200, {
          "Content-Type": "application/pdf",
          "Content-Disposition": 'attachment; filename="slow.pdf"',
        });
        response.write("%PDF-synthetic-start\n");
        finish = () => response.end("synthetic-end");
        return;
      }
      html(response, request.url === "/article/a" ? "A" : "B");
    });
    const a = await identity("a");
    const b = await identity("b");
    const identities = new Map([
      [a.session_id, a],
      [b.session_id, b],
    ]);
    const host = new BrowserHost({
      profile: join(f.directory, "profile"),
      ...f.launch,
      admitNavigation: (url) => url,
      transfers: {
        captureContext: (page, generation, url, session) =>
          capture(identities, page, generation, url, session),
        started: (_id, owner) => {
          started.add(owner.session_id);
        },
        receive: async (input) => {
          for await (const chunk of input.chunks)
            expect(chunk.byteLength).toBeGreaterThan(0);
          received.push(input.capture.session_id);
        },
        failed: () => {
          throw new Error("unexpected native transfer failure");
        },
      },
    });
    try {
      await host.start();
      const pageA = await host.openPage(f.origin + "/article/a", a);
      const pageB = await host.openPage(f.origin + "/article/b", b);
      await click(pageB, "PDF");
      await expect.poll(() => started.has(b.session_id)).toBe(true);
      await pageA.close();
      expect(received).toEqual([]);
      expect(
        (await host.listPages()).some((page) => page.id === pageB.id),
      ).toBe(true);
      finish!();
      await expect.poll(() => received).toEqual([b.session_id]);
      await pageB.settleCaptures!();
    } finally {
      finish?.();
      await host.close();
      await f.close();
    }
  },
  30000,
);

it.runIf(available)(
  "leaves B input available during A navigation and refuses A's obsolete action",
  async () => {
    let requestStarted = false;
    let release: (() => void) | undefined;
    const f = await fixture((request, response) => {
      if (request.url === "/slow") {
        requestStarted = true;
        release = () => {
          if (!response.headersSent) html(response, "A next");
        };
        return;
      }
      html(response, request.url === "/article/a" ? "A" : "B");
    });
    const host = new BrowserHost({
      profile: join(f.directory, "profile"),
      ...f.launch,
      admitNavigation: (url) => url,
    });
    try {
      await host.start();
      const a = await host.openPage(
        f.origin + "/article/a",
        await identity("a"),
      );
      const b = await host.openPage(
        f.origin + "/article/b",
        await identity("b"),
      );
      const previous = await readySnapshot(a);
      const navigation = a.navigate!(f.origin + "/slow");
      await expect.poll(() => requestStarted).toBe(true);
      const snapshot = await readySnapshot(b);
      expect(snapshot.title).toBe("B:0");
      release!();
      await navigation;
      await expect(
        a.apply(
          {
            kind: "click-element",
            element_id: previous.elements!.find(
              (item) => item.name === "Count",
            )!.element_id,
            revision: 1,
          },
          previous.document_generation!,
          () => true,
        ),
      ).rejects.toBeDefined();
      expect(await b.title()).toBe("B:0");
    } finally {
      release?.();
      await host.close();
      await f.close();
    }
  },
  30000,
);

it.runIf(available)(
  "reports shared protocol disconnection for every owned article",
  async () => {
    const f = await fixture((_request, response) => html(response, "owned"));
    const host = new BrowserHost({
      profile: join(f.directory, "profile"),
      ...f.launch,
      admitNavigation: (url) => url,
    });
    try {
      await host.start();
      const a = await host.openPage(
        f.origin + "/article/a",
        await identity("a"),
      );
      const b = await host.openPage(
        f.origin + "/article/b",
        await identity("b"),
      );
      const protocol = Reflect.get(
        host,
        "protocol",
      ) as OwnedBrowserCdpConnection;
      protocol.close();
      await expect(a.snapshot()).rejects.toBeInstanceOf(
        BrowserHostRuntimeError,
      );
      await expect(b.snapshot()).rejects.toMatchObject({
        code: "browser-runtime-lost",
      });
    } finally {
      await host.close();
      await f.close();
    }
  },
  30000,
);

it.runIf(available)(
  "keeps B's snapshot and native capture alive after only A's renderer crashes",
  async () => {
    const bytes = Buffer.from(
      "%PDF-synthetic-local-crash\n" + "B".repeat(3000),
    );
    const captured: { session: string; hash: string }[] = [];
    const failures: string[] = [];
    let runtimeLosses = 0;
    const f = await fixture((request, response) => {
      if (request.url === "/same.pdf") {
        response.writeHead(200, {
          "Content-Type": "application/pdf",
          "Content-Disposition": 'attachment; filename="owned.pdf"',
          "Content-Length": bytes.length,
        });
        response.end(bytes);
      } else html(response, request.url === "/article/a" ? "A" : "B");
    });
    const aIdentity = await identity("a");
    const bIdentity = await identity("b");
    const identities = new Map([
      [aIdentity.session_id, aIdentity],
      [bIdentity.session_id, bIdentity],
    ]);
    const resources = new BrowserDownloadResources({
      available_bytes: async () => 10 * 1024 ** 3,
    });
    const host = new BrowserHost({
      profile: join(f.directory, "profile"),
      ...f.launch,
      admitNavigation: (requested) => requested,
      onRuntimeLost: () => {
        runtimeLosses++;
      },
      transfers: {
        resources: () => resources,
        captureContext: (page, generation, url, session) =>
          capture(identities, page, generation, url, session),
        receive: async (input) => {
          const hash = createHash("sha256");
          for await (const chunk of input.chunks) hash.update(chunk);
          captured.push({
            session: input.capture.session_id,
            hash: hash.digest("hex"),
          });
        },
        failed: (_transfer, _capture, code) => failures.push(code ?? "unknown"),
      },
    });
    let localCode: string | undefined;
    try {
      await host.start();
      const a = await host.openPage(f.origin + "/article/a", aIdentity);
      const b = await host.openPage(f.origin + "/article/b", bIdentity);
      await readySnapshot(a);
      const raw = (host as unknown as { pages: Map<string, Page> }).pages.get(
        a.id,
      )!;
      const crashed = raw.waitForEvent("crash");
      const probe = await raw.context().newCDPSession(raw);
      void probe.send("Page.crash").catch(() => undefined);
      await crashed;
      try {
        await a.snapshot();
      } catch (error) {
        localCode = (error as { code?: string }).code;
      }
      expect((await readySnapshot(b)).title).toBe("B:0");
      await a.close();
      await click(b, "PDF");
      await expect.poll(() => captured.length, { timeout: 15000 }).toBe(1);
      await b.settleCaptures!();
      expect(captured).toEqual([
        {
          session: bIdentity.session_id,
          hash: createHash("sha256").update(bytes).digest("hex"),
        },
      ]);
      expect(failures).toEqual([]);
      expect(runtimeLosses).toBe(0);
      expect(host.diagnostics().status).toBe("ready");
      expect(resources.snapshot().native_bytes).toBe(0);
      expect(localCode).toBe("browser-page-crashed");
    } finally {
      if (bundle) {
        await writeFile(
          join(f.directory, "crash-evidence.json"),
          JSON.stringify(
            {
              runtime: f.runtime?.version,
              local_code: localCode,
              runtime_losses: runtimeLosses,
              captured,
              failures,
              resources: resources.snapshot(),
            },
            null,
            2,
          ),
        );
        console.info("Synthetic local renderer crash evidence:", f.directory);
      }
      await host.close();
      await f.close();
    }
  },
  30000,
);

it.runIf(available)(
  "cancels an in-progress native writer when its temporary-byte quota is exceeded",
  async () => {
    let cancelledBeforeEof = false;
    const failures: string[] = [];
    const captured: string[] = [];
    const f = await fixture((request, response) => {
      if (request.url === "/same.pdf") {
        response.writeHead(200, {
          "Content-Type": "application/pdf",
          "Content-Disposition": 'attachment; filename="quota.pdf"',
        });
        response.write("%PDF-synthetic-quota\n");
        let chunks = 0;
        const timer = setInterval(() => {
          response.write(Buffer.alloc(32768, 65));
          if (++chunks === 80) {
            clearInterval(timer);
            response.end();
          }
        }, 50);
        response.once("close", () => {
          clearInterval(timer);
          cancelledBeforeEof = chunks < 80;
        });
        return;
      }
      response.writeHead(200, { "Content-Type": "text/html" });
      response.end(
        '<title>Quota fixture</title><main><a href="/same.pdf" download>PDF</a></main>',
      );
    });
    const a = await identity("a");
    const identities = new Map([[a.session_id, a]]);
    const resources = new BrowserDownloadResources({
      temporary_bytes: 1024,
      disk_reserve_bytes: 0,
      available_bytes: async () => 10 * 1024 ** 3,
    });
    const host = new BrowserHost({
      profile: join(f.directory, "profile"),
      ...f.launch,
      admitNavigation: (url) => url,
      transfers: {
        resources: () => resources,
        captureContext: (page, generation, url, session) =>
          capture(identities, page, generation, url, session),
        receive: async (input) => {
          for await (const chunk of input.chunks)
            captured.push(String(chunk.byteLength));
        },
        failed: (_id, _capture, code) => {
          failures.push(code ?? "unknown");
        },
      },
    });
    try {
      await host.start();
      const page = await host.openPage(f.origin + "/article/a", a);
      await click(page, "PDF");
      await expect
        .poll(() => failures, { timeout: 15000 })
        .toEqual(["browser-download-temporary-quota"]);
      await page.settleCaptures!();
      expect(cancelledBeforeEof).toBe(true);
      expect(captured).toEqual([]);
      expect(resources.snapshot().native_bytes).toBe(0);
    } finally {
      await host.close();
      await f.close();
    }
  },
  30000,
);

it.runIf(available)(
  "closes A's page and native writer after an inactive stop protocol while B keeps downloading",
  async () => {
    const bytes = Buffer.from(
      "%PDF-synthetic-stop-fallback\n" + "B".repeat(3000),
    );
    const released: (() => void)[] = [];
    const sourceClosed = new Set<string>();
    const captured: { session: string; hash: string }[] = [];
    const failures: { session: string; code: string }[] = [];
    const terminals: string[] = [];
    let scriptStarted = false;
    let releaseB: (() => void) | undefined;
    const f = await fixture((request, response) => {
      if (request.url === "/held-script.js") {
        scriptStarted = true;
        response.writeHead(200, { "Content-Type": "text/javascript" });
        response.write("/* held script body");
        response.once("close", () => sourceClosed.add("script-a"));
        released.push(() => response.end(" */"));
        return;
      }
      if (request.url === "/native-a.pdf" || request.url === "/same.pdf") {
        const name = request.url === "/native-a.pdf" ? "native-a" : "native-b";
        response.writeHead(200, {
          "Content-Type": "application/pdf",
          "Content-Disposition": 'attachment; filename="held.pdf"',
          "Content-Length": bytes.length,
        });
        response.write(bytes.subarray(0, 128));
        response.once("close", () => sourceClosed.add(name));
        const release = () => response.end(bytes.subarray(128));
        released.push(release);
        if (name === "native-b") releaseB = release;
        return;
      }
      if (request.url === "/article/a") {
        response.writeHead(200, { "Content-Type": "text/html" });
        response.end(
          '<title>A held</title><a href="/native-a.pdf" download>PDF</a>',
        );
      } else html(response, "B");
    });
    const aIdentity = await identity("a");
    const bIdentity = await identity("b");
    const identities = new Map([
      [aIdentity.session_id, aIdentity],
      [bIdentity.session_id, bIdentity],
    ]);
    const resources = new BrowserDownloadResources({
      available_bytes: async () => 10 * 1024 ** 3,
    });
    const host = new BrowserHost({
      profile: join(f.directory, "profile"),
      ...f.launch,
      admitNavigation: (url) => url,
      transfers: {
        resources: () => resources,
        captureContext: (page, generation, url, session) =>
          capture(identities, page, generation, url, session),
        receive: async (input) => {
          const hash = createHash("sha256");
          for await (const chunk of input.chunks) hash.update(chunk);
          captured.push({
            session: input.capture.session_id,
            hash: hash.digest("hex"),
          });
        },
        failed: (_id, owner, code) => {
          failures.push({ session: owner.session_id, code: code ?? "unknown" });
        },
      },
    });
    let restoreProtocol: (() => void) | undefined;
    let stopAttempts = 0;
    let stopError: string | undefined;
    let targetA: string | undefined;
    try {
      await host.start();
      const a = await host.openPage(f.origin + "/article/a", aIdentity);
      const b = await host.openPage(f.origin + "/article/b", bIdentity);
      await readySnapshot(a);
      const rawA = (Reflect.get(host, "pages") as Map<string, Page>).get(a.id)!;
      await rawA.evaluate(() => {
        const script = document.createElement("script");
        script.async = true;
        script.src = "/held-script.js";
        document.head.append(script);
      });
      await expect.poll(() => scriptStarted, { timeout: 10000 }).toBe(true);
      await click(a, "PDF");
      await click(b, "PDF");
      await expect.poll(() => Boolean(releaseB)).toBe(true);
      await expect
        .poll(() => resources.snapshot().native_bytes, { timeout: 10000 })
        .toBeGreaterThan(0);
      const protocol = Reflect.get(
        host,
        "protocol",
      ) as OwnedBrowserCdpConnection;
      const owner = Reflect.get(host, "cdp") as BrowserCdpOwner;
      targetA = (Reflect.get(host, "pageTargets") as Map<string, string>).get(
        a.id,
      )!;
      const records = Reflect.get(owner, "requests") as Map<
        string,
        { identity: { session_id: string }; url: string }
      >;
      expect(
        [...records.values()].some((record) =>
          record.url.endsWith("/held-script.js"),
        ),
      ).toBe(true);
      protocol.on("Target.targetDestroyed", ({ params }) => {
        if (params.targetId === targetA) terminals.push("target-destroyed-a");
      });
      const send = protocol.send.bind(protocol);
      protocol.send = async (method, params, session, timeout, signal) => {
        if (method === "Page.stopLoading" && stopAttempts++ === 0) {
          // The page remains alive; only this adapter's session is detached while
          // its already selected stop command is in flight.
          await send("Target.detachFromTarget", { sessionId: session });
          try {
            return await send(method, params, session, timeout, signal);
          } catch (error) {
            stopError = (error as { reason?: string }).reason;
            expect(
              [...records.values()].some((record) =>
                record.url.endsWith("/held-script.js"),
              ),
            ).toBe(true);
            throw error;
          }
        }
        return send(method, params, session, timeout, signal);
      };
      restoreProtocol = () => {
        protocol.send = send;
      };
      // Cooperative network suspension still uses Page.stopLoading. Full close
      // owns actual page closure and must recover from this earlier stop failure
      // without issuing the same ineffective renderer command again.
      await expect(
        host.stopSessionNetwork(aIdentity.session_id),
      ).rejects.toMatchObject({ reason: "target-inactive" });
      await Promise.all([a.close(), a.close()]);
      expect(stopError).toBe("target-inactive");
      expect(stopAttempts).toBe(1);
      await expect.poll(() => sourceClosed.has("script-a")).toBe(true);
      await expect.poll(() => sourceClosed.has("native-a")).toBe(true);
      expect(terminals).toEqual(["target-destroyed-a"]);
      expect(
        [...records.values()].filter(
          (record) => record.identity.session_id === aIdentity.session_id,
        ),
      ).toEqual([]);
      expect(sourceClosed.has("native-b")).toBe(false);
      expect((await readySnapshot(b)).title).toBe("B:0");
      releaseB!();
      await expect.poll(() => captured.length, { timeout: 15000 }).toBe(1);
      await b.settleCaptures!();
      expect(captured).toEqual([
        {
          session: bIdentity.session_id,
          hash: createHash("sha256").update(bytes).digest("hex"),
        },
      ]);
      expect(
        failures.filter((failure) => failure.session === bIdentity.session_id),
      ).toEqual([]);
      expect(resources.snapshot().native_bytes).toBe(0);
      expect(host.diagnostics().status).toBe("ready");
    } finally {
      restoreProtocol?.();
      for (const release of released) release();
      if (bundle) {
        await writeFile(
          join(f.directory, "stop-fallback-evidence.json"),
          JSON.stringify(
            {
              runtime: f.runtime?.version,
              target_a: targetA,
              stop_attempts: stopAttempts,
              stop_error: stopError,
              terminals,
              source_closed: [...sourceClosed],
              captured,
              failures,
              resources: resources.snapshot(),
            },
            null,
            2,
          ),
        );
        console.info("Synthetic inactive stop fallback evidence:", f.directory);
      }
      await host.close();
      await f.close();
    }
  },
  30000,
);
