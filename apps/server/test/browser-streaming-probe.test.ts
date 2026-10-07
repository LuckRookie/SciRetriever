import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer, type Server, type ServerResponse } from "node:http";
import { mkdir, mkdtemp, open, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  chromium,
  type BrowserContext,
  type CDPSession,
  type Download,
  type Page,
} from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BrowserDisplay } from "../src/browser/display.js";
import {
  loadCloakIdentity,
  verifyInstalledCloakRuntime,
  type VerifiedCloakRuntime,
} from "../src/configuration/cloak-runtime.js";
import { BrowserNetworkProxy } from "../src/network/browser-proxy.js";
import { NetworkBudgetCoordinator } from "../src/network/budget.js";

interface DownloadBegin {
  readonly frameId: string;
  readonly guid: string;
  readonly url: string;
}
interface DownloadProgress {
  readonly guid: string;
  readonly state: "inProgress" | "completed" | "canceled";
  readonly receivedBytes: number;
  readonly totalBytes: number;
  readonly filePath?: string;
}
interface TimedProgress extends DownloadProgress {
  readonly at: number;
}
interface Sent {
  bytes: number;
  first: number;
  ended: number;
  closed: number;
  requests: number;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** One readable blank page and one unused, uncompressed synthetic stream. */
function probePdf(): Buffer {
  const objects = [
    Buffer.from("<< /Type /Catalog /Pages 2 0 R >>"),
    Buffer.from("<< /Type /Pages /Kids [3 0 R] /Count 1 >>"),
    Buffer.from("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 10 10] >>"),
    Buffer.concat([
      Buffer.from("<< /Length 524288 >>\nstream\n"),
      Buffer.alloc(512 * 1024, 0x61),
      Buffer.from("\nendstream"),
    ]),
  ];
  const parts = [Buffer.from("%PDF-1.7\n")];
  const offsets = [0];
  let length = parts[0]!.length;
  for (const [index, object] of objects.entries()) {
    offsets.push(length);
    const bytes = Buffer.concat([
      Buffer.from(`${index + 1} 0 obj\n`),
      object,
      Buffer.from("\nendobj\n"),
    ]);
    parts.push(bytes);
    length += bytes.length;
  }
  parts.push(
    Buffer.from(
      `xref\n0 5\n0000000000 65535 f \n${offsets
        .slice(1)
        .map((offset) => `${String(offset).padStart(10, "0")} 00000 n `)
        .join(
          "\n",
        )}\ntrailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${length}\n%%EOF\n`,
    ),
  );
  return Buffer.concat(parts);
}

async function readDownload(download: Download): Promise<string> {
  const result = createHash("sha256");
  const stream = await download.createReadStream();
  for await (const chunk of stream) result.update(chunk as Uint8Array);
  return result.digest("hex");
}

/** Explicit local-runtime probe. Its evidence is not a production streaming implementation. */
describe.runIf(!!process.env.SCIRETRIEVER_CLOAK_BUNDLE)(
  "Cloak download progress and original-response streaming probe",
  () => {
    let root: string;
    let origin: string;
    let server: Server;
    let context: BrowserContext;
    let browserCdp: CDPSession;
    let runtime: VerifiedCloakRuntime;
    let displayName: string;
    const display = new BrowserDisplay();
    const begins: DownloadBegin[] = [];
    const progress: TimedProgress[] = [];
    const sent = new Map<string, Sent>();
    const evidence: Record<string, unknown> = {};
    const proxyFirst = deferred<void>();
    const proxyFinish = deferred<void>();
    const payload = probePdf();

    async function serve(path: string, response: ServerResponse) {
      const info = sent.get(path) ?? {
        bytes: 0,
        first: 0,
        ended: 0,
        closed: 0,
        requests: 0,
      };
      sent.set(path, info);
      info.requests++;
      response.once("close", () => {
        info.closed = performance.now();
      });
      const disposition = path.startsWith("/inline") ? "inline" : "attachment";
      response.writeHead(200, {
        "content-type": "application/pdf",
        "content-disposition": `${disposition}; filename="synthetic.pdf"`,
        "cache-control": "no-store",
        ...(path === "/native-bad-length"
          ? {
              "content-length": String(payload.length + 1024),
              connection: "close",
            }
          : {}),
      });
      response.flushHeaders();
      const chunkSize = path === "/native-slow" ? 16 * 1024 : 32 * 1024;
      for (let offset = 0; offset < payload.length; offset += chunkSize) {
        if (response.destroyed) return;
        const bytes = payload.subarray(offset, offset + chunkSize);
        response.write(bytes);
        info.bytes += bytes.length;
        info.first ||= performance.now();
        if (path === "/pdf-proxy" && offset === 0) {
          proxyFirst.resolve();
          await proxyFinish.promise;
        }
        if (path === "/native-disconnect" && offset >= chunkSize) {
          response.destroy();
          return;
        }
        if (path === "/native-slow") {
          // More than thirty seconds, including a real pause with no new bytes.
          await delay(offset === 8 * chunkSize ? 4000 : 1000);
        } else
          await delay(
            path === "/native-cancel" || path === "/pdf-io-cancel" ? 100 : 20,
          );
      }
      if (!response.destroyed) {
        info.ended = performance.now();
        response.end();
      }
    }

    async function launch(
      profile: string,
      downloads: string,
      proxy?: {
        server: string;
        username: string;
        password: string;
      },
    ): Promise<BrowserContext> {
      await mkdir(profile, { mode: 0o700 });
      await mkdir(downloads, { mode: 0o700 });
      const identity = await loadCloakIdentity(profile);
      await mkdir(join(profile, "Default"), { mode: 0o700 });
      // A synthetic Profile with the same PDF preference as the production host.
      await writeFile(
        join(profile, "Default", "Preferences"),
        JSON.stringify({ plugins: { always_open_pdf_externally: true } }),
        { mode: 0o600 },
      );
      return chromium.launchPersistentContext(profile, {
        executablePath: runtime.executablePath,
        headless: false,
        acceptDownloads: true,
        downloadsPath: downloads,
        serviceWorkers: "block",
        ignoreDefaultArgs: [
          "--enable-automation",
          "--enable-unsafe-swiftshader",
        ],
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          LANG: "en_US.UTF-8",
          TZ: "UTC",
          DISPLAY: displayName,
          HOME: join(root, "home"),
        },
        ...(proxy ? { proxy: { ...proxy, bypass: "<-loopback>" } } : {}),
        args: [
          `--fingerprint=${identity.seed}`,
          "--fingerprint-platform=linux",
          "--fingerprint-timezone=UTC",
          "--disable-component-update",
          "--disable-default-apps",
          "--disable-sync",
          "--no-first-run",
          "--disable-quic",
          "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost",
        ],
      });
    }

    async function fixturePage(target: string): Promise<Page> {
      const page = await context.newPage();
      await page.goto(`${origin}/article?target=${target}`);
      return page;
    }

    beforeAll(async () => {
      runtime = await verifyInstalledCloakRuntime(
        process.env.SCIRETRIEVER_CLOAK_BUNDLE!,
      );
      root = await mkdtemp(
        join(tmpdir(), "sciretriever-browser-streaming-probe-"),
      );
      await mkdir(join(root, "home"), { mode: 0o700 });
      evidence.runtime = runtime.version;
      evidence.expected_sha256 = digest(payload);
      evidence.expected_bytes = payload.length;
      console.info(`Streaming probe evidence directory: ${root}`);
      server = createServer((request, response) => {
        const url = new URL(request.url ?? "/", "http://fixture.local");
        if (url.pathname === "/article") {
          const target = url.searchParams.get("target") ?? "/native-slow";
          response.writeHead(200, { "content-type": "text/html" });
          response.end(
            `<title>Synthetic streaming probe</title><a href="${target}">Download</a>`,
          );
        } else if (url.pathname === "/redirect") {
          response.writeHead(302, { location: "/inline-redirect" });
          response.end();
        } else if (
          url.pathname.startsWith("/pdf-") ||
          url.pathname.startsWith("/native-") ||
          url.pathname.startsWith("/inline")
        ) {
          if (
            url.pathname.startsWith("/pdf-") &&
            url.pathname !== "/pdf-proxy" &&
            request.headers["x-probe-owner"] !== "synthetic-session"
          ) {
            response.writeHead(403);
            response.end();
            return;
          }
          void serve(url.pathname, response);
        } else {
          response.writeHead(404);
          response.end();
        }
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("fixture unavailable");
      origin = `http://127.0.0.1:${address.port}`;
      displayName = await display.start();
      context = await launch(join(root, "profile"), join(root, "downloads"));
      const browser = context.browser();
      if (!browser) throw new Error("persistent Browser object unavailable");
      browserCdp = await browser.newBrowserCDPSession();
      browserCdp.on("Browser.downloadWillBegin", (event: DownloadBegin) =>
        begins.push(event),
      );
      browserCdp.on("Browser.downloadProgress", (event: DownloadProgress) =>
        progress.push({ ...event, at: performance.now() }),
      );
      await browserCdp.send("Browser.setDownloadBehavior", {
        behavior: "allowAndName",
        downloadPath: join(root, "downloads"),
        eventsEnabled: true,
      });
    }, 30000);

    afterAll(async () => {
      proxyFinish.resolve();
      await context?.close();
      await display.close();
      if (server) {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
      if (root) {
        evidence.begins = begins;
        evidence.progress = progress;
        evidence.served = Object.fromEntries(sent);
        await writeFile(
          join(root, "evidence.json"),
          JSON.stringify(evidence, null, 2),
        );
        // Keep the compact probe evidence; remove only our synthetic Profiles and download bytes.
        for (const name of [
          "profile",
          "downloads",
          "proxy-profile",
          "proxy-downloads",
          "home",
        ])
          await rm(join(root, name), { recursive: true, force: true });
      }
    }, 15000);

    it("observes single-GUID received bytes before a slow unknown-length download exposes its stream or path", async () => {
      const page = await fixturePage("/native-slow");
      const cdp = await context.newCDPSession(page);
      const frame = (await cdp.send("Page.getFrameTree")) as {
        frameTree: { frame: { id: string } };
      };
      const downloading = page.waitForEvent("download");
      await page.getByRole("link", { name: "Download" }).click();
      const download = await downloading;
      await expect
        .poll(
          () => begins.find((event) => event.url === `${origin}/native-slow`),
          {
            timeout: 5000,
          },
        )
        .toBeDefined();
      const begin = begins.find(
        (event) => event.url === `${origin}/native-slow`,
      );
      expect(begin?.frameId).toBe(frame.frameTree.frame.id);
      const guid = begin!.guid;
      let streamAt = 0;
      let pathAt = 0;
      const started = sent.get("/native-slow")!.first;
      const stream = download.createReadStream().then((value) => {
        streamAt = performance.now();
        return value;
      });
      const path = download.path().then((value) => {
        pathAt = performance.now();
        return value;
      });
      await delay(1200);
      expect(streamAt).toBe(0);
      expect(pathAt).toBe(0);
      const early = progress.filter(
        (event) =>
          event.guid === guid &&
          event.receivedBytes > 0 &&
          event.state === "inProgress",
      );
      expect(early.length).toBeGreaterThan(0);
      expect(early.at(-1)!.totalBytes).toBe(0);
      const partial = await stat(join(root, "downloads", `${guid}.crdownload`));
      expect(partial.size).toBeGreaterThan(0);
      const result = createHash("sha256");
      for await (const chunk of await stream)
        result.update(chunk as Uint8Array);
      expect(result.digest("hex")).toBe(digest(payload));
      expect(await download.failure()).toBeNull();
      const finalPath = await path;
      await expect
        .poll(
          () =>
            progress.find(
              (event) => event.guid === guid && event.state === "completed",
            ),
          { timeout: 5000 },
        )
        .toBeDefined();
      const terminal = progress.find(
        (event) => event.guid === guid && event.state === "completed",
      );
      expect(terminal?.receivedBytes).toBe(payload.length);
      expect(streamAt - started).toBeGreaterThan(30000);
      expect(pathAt - started).toBeGreaterThan(30000);
      expect(sent.get("/native-slow")!.requests).toBe(1);
      evidence.native = {
        guid,
        first_progress: early[0],
        stream_after_ms: streamAt - started,
        path_after_ms: pathAt - started,
        final_file_matches_guid: finalPath === join(root, "downloads", guid),
        terminal,
      };
      await page.close();
    }, 60000);

    it("uses native downloads for inline PDF navigation and its HTTP redirect under the production PDF preference", async () => {
      const results = [];
      for (const target of ["/inline-direct", "/redirect"]) {
        const page = await fixturePage(target);
        const downloading = page.waitForEvent("download");
        await page.getByRole("link", { name: "Download" }).click();
        const download = await downloading;
        expect(await readDownload(download)).toBe(digest(payload));
        expect(await download.failure()).toBeNull();
        results.push({ target, download_url: download.url() });
        await page.close();
      }
      evidence.inline = results;
    }, 15000);

    it("captures bytes of an original fetch response with Network.streamResourceContent before completion", async () => {
      const page = await fixturePage("/unused");
      const cdp = await context.newCDPSession(page);
      const output = await open(join(root, "network-stream.bin"), "wx", 0o600);
      const done = deferred<void>();
      let requestId: string | undefined;
      let opening = true;
      let firstAt = 0;
      let size = 0;
      let eventCount = 0;
      let bufferedBytes = 0;
      let tail = Promise.resolve();
      const queued: Buffer[] = [];
      const hash = createHash("sha256");
      const append = (bytes: Buffer) => {
        if (!bytes.length) return;
        firstAt ||= performance.now();
        size += bytes.length;
        hash.update(bytes);
        tail = tail.then(async () => {
          await output.writeFile(bytes);
        });
      };
      cdp.on(
        "Network.responseReceived",
        (event: {
          requestId: string;
          response: { url: string; mimeType: string };
        }) => {
          if (event.response.url !== `${origin}/pdf-network`) return;
          requestId = event.requestId;
          void cdp
            .send("Network.streamResourceContent", { requestId })
            .then((value: { bufferedData: string }) => {
              const bytes = Buffer.from(value.bufferedData, "base64");
              bufferedBytes = bytes.length;
              append(bytes);
              opening = false;
              for (const chunk of queued.splice(0)) append(chunk);
            }, done.reject);
        },
      );
      cdp.on(
        "Network.dataReceived",
        (event: { requestId: string; data?: string }) => {
          if (event.requestId !== requestId || !event.data) return;
          eventCount++;
          const bytes = Buffer.from(event.data, "base64");
          if (opening) queued.push(bytes);
          else append(bytes);
        },
      );
      cdp.on("Network.loadingFinished", (event: { requestId: string }) => {
        if (event.requestId === requestId) done.resolve();
      });
      cdp.on("Network.loadingFailed", (event: { requestId: string }) => {
        if (event.requestId === requestId)
          done.reject(new Error("original response failed"));
      });
      await cdp.send("Network.enable", {
        maxTotalBufferSize: 65536,
        maxResourceBufferSize: 65536,
      });
      const browserFetch = page.evaluate(async () => {
        const response = await fetch("/pdf-network", {
          headers: { "x-probe-owner": "synthetic-session" },
        });
        return (await response.arrayBuffer()).byteLength;
      });
      try {
        await done.promise;
        await tail;
        expect(await browserFetch).toBe(payload.length);
        expect(size).toBe(payload.length);
        expect(hash.digest("hex")).toBe(digest(payload));
        expect(firstAt).toBeLessThan(sent.get("/pdf-network")!.ended);
        expect(eventCount).toBeGreaterThan(1);
        expect(sent.get("/pdf-network")!.requests).toBe(1);
        evidence.network_stream = {
          first_byte_at: firstAt,
          server_ended_at: sent.get("/pdf-network")!.ended,
          event_count: eventCount,
          buffered_bytes: bufferedBytes,
          size,
        };
      } finally {
        await output.close();
        await cdp.detach();
        await page.close();
        await rm(join(root, "network-stream.bin"), { force: true });
      }
    }, 15000);

    it("takes an original fetch response as a pull-based IO stream while preserving the request session header", async () => {
      const page = await fixturePage("/unused");
      const cdp = await context.newCDPSession(page);
      const output = await open(join(root, "fetch-io.bin"), "wx", 0o600);
      const done = deferred<{
        firstAt: number;
        size: number;
        chunks: number;
        sha256: string;
      }>();
      await cdp.send("Fetch.enable", {
        patterns: [
          { urlPattern: `${origin}/pdf-io`, requestStage: "Response" },
        ],
      });
      cdp.on(
        "Fetch.requestPaused",
        (event: { requestId: string; responseStatusCode?: number }) => {
          void (async () => {
            if (event.responseStatusCode !== 200)
              throw new Error("unexpected response status");
            const { stream } = (await cdp.send(
              "Fetch.takeResponseBodyAsStream",
              { requestId: event.requestId },
            )) as { stream: string };
            const hash = createHash("sha256");
            let firstAt = 0;
            let size = 0;
            let chunks = 0;
            try {
              for (;;) {
                const part = (await cdp.send("IO.read", {
                  handle: stream,
                  size: 65536,
                })) as { data: string; base64Encoded?: boolean; eof: boolean };
                const bytes = Buffer.from(
                  part.data,
                  part.base64Encoded ? "base64" : "utf8",
                );
                if (bytes.length) {
                  firstAt ||= performance.now();
                  size += bytes.length;
                  chunks++;
                  hash.update(bytes);
                  await output.writeFile(bytes);
                }
                if (part.eof) break;
              }
            } finally {
              await cdp.send("IO.close", { handle: stream });
            }
            // The PDF has been handed off; the same browser request cannot continue after takeResponseBodyAsStream.
            await cdp.send("Fetch.failRequest", {
              requestId: event.requestId,
              errorReason: "Aborted",
            });
            done.resolve({ firstAt, size, chunks, sha256: hash.digest("hex") });
          })().catch(done.reject);
        },
      );
      const browserFetch = page.evaluate(async () => {
        try {
          const response = await fetch("/pdf-io", {
            headers: { "x-probe-owner": "synthetic-session" },
          });
          await response.arrayBuffer();
          return "completed";
        } catch {
          return "handed-off";
        }
      });
      try {
        const result = await done.promise;
        expect(result.size).toBe(payload.length);
        expect(result.sha256).toBe(digest(payload));
        expect(result.chunks).toBeGreaterThan(1);
        expect(result.firstAt).toBeLessThan(sent.get("/pdf-io")!.ended);
        expect(await browserFetch).toBe("handed-off");
        expect(sent.get("/pdf-io")!.requests).toBe(1);
        evidence.fetch_io = {
          ...result,
          server_ended_at: sent.get("/pdf-io")!.ended,
          browser_result: "handed-off",
          maximum_read_size: 65536,
        };
      } finally {
        await cdp.send("Fetch.disable");
        await output.close();
        await cdp.detach();
        await page.close();
        await rm(join(root, "fetch-io.bin"), { force: true });
      }
    }, 15000);

    it("really cancels its native writer and reports an interrupted download as canceled", async () => {
      const outcomes = [];
      for (const target of [
        "/native-cancel",
        "/native-disconnect",
        "/native-bad-length",
      ]) {
        const page = await fixturePage(target);
        const downloading = page.waitForEvent("download");
        await page.getByRole("link", { name: "Download" }).click();
        const download = await downloading;
        if (target === "/native-cancel") {
          await delay(200);
          await download.cancel();
        }
        expect(await download.failure()).not.toBeNull();
        await expect
          .poll(
            () => begins.find((event) => event.url === `${origin}${target}`),
            {
              timeout: 5000,
            },
          )
          .toBeDefined();
        const begin = begins.find(
          (event) => event.url === `${origin}${target}`,
        )!;
        await expect
          .poll(
            () =>
              progress.some(
                (event) =>
                  event.guid === begin.guid && event.state === "canceled",
              ),
            { timeout: 2000, interval: 20 },
          )
          .toBe(true);
        const bytesAtTerminal = sent.get(target)!.bytes;
        await delay(200);
        expect(sent.get(target)!.bytes).toBe(bytesAtTerminal);
        await expect(download.path()).rejects.toBeDefined();
        outcomes.push({
          target,
          guid: begin.guid,
          bytes_at_terminal: bytesAtTerminal,
          requests: sent.get(target)!.requests,
          writer_closed: sent.get(target)!.closed > 0,
        });
        await page.close();
      }
      evidence.cancellation = outcomes;
    }, 15000);

    it("closes the original response writer when a taken IO stream is canceled", async () => {
      const page = await fixturePage("/unused");
      const cdp = await context.newCDPSession(page);
      const done = deferred<{ bytes: number; at: number }>();
      await cdp.send("Fetch.enable", {
        patterns: [
          { urlPattern: `${origin}/pdf-io-cancel`, requestStage: "Response" },
        ],
      });
      cdp.on("Fetch.requestPaused", (event: { requestId: string }) => {
        void (async () => {
          const { stream } = (await cdp.send("Fetch.takeResponseBodyAsStream", {
            requestId: event.requestId,
          })) as { stream: string };
          const first = (await cdp.send("IO.read", {
            handle: stream,
            size: 65536,
          })) as {
            data: string;
            base64Encoded?: boolean;
          };
          const bytes = Buffer.from(
            first.data,
            first.base64Encoded ? "base64" : "utf8",
          ).length;
          await cdp.send("IO.close", { handle: stream });
          await cdp.send("Fetch.failRequest", {
            requestId: event.requestId,
            errorReason: "Aborted",
          });
          done.resolve({ bytes, at: performance.now() });
        })().catch(done.reject);
      });
      const browserFetch = page.evaluate(async () => {
        try {
          const response = await fetch("/pdf-io-cancel", {
            headers: { "x-probe-owner": "synthetic-session" },
          });
          await response.arrayBuffer();
          return "completed";
        } catch {
          return "canceled";
        }
      });
      try {
        const result = await done.promise;
        expect(await browserFetch).toBe("canceled");
        await expect
          .poll(() => sent.get("/pdf-io-cancel")!.closed > 0, {
            timeout: 2000,
            interval: 20,
          })
          .toBe(true);
        const terminalBytes = sent.get("/pdf-io-cancel")!.bytes;
        await delay(250);
        expect(sent.get("/pdf-io-cancel")!.bytes).toBe(terminalBytes);
        expect(terminalBytes).toBeLessThan(payload.length);
        expect(sent.get("/pdf-io-cancel")!.requests).toBe(1);
        evidence.fetch_io_cancel = {
          ...result,
          server_bytes_at_close: terminalBytes,
          server_closed_at: sent.get("/pdf-io-cancel")!.closed,
        };
      } finally {
        await cdp.send("Fetch.disable");
        await cdp.detach();
        await page.close();
      }
    }, 15000);

    it("observes the production HTTP proxy deliver a native download before the origin reaches EOF", async () => {
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("fixture unavailable");
      const proxy = new BrowserNetworkProxy({
        resolver: () => ["127.0.0.1"],
        policy: {
          allowed_schemes: ["http"],
          allowed_classes: ["loopback"],
          allowed_addresses: ["127.0.0.1"],
          allowed_ports: [{ scheme: "http", port: address.port }],
        },
        coordinator: new NetworkBudgetCoordinator(),
        limits: {
          maxConcurrency: 4,
          maxHostConcurrency: 4,
          maxResponseBytes: 1024 * 1024,
          maxRedirects: 0,
          maxRetries: 0,
        },
        timeoutMs: 5000,
      });
      const connection = await proxy.start();
      const proxied = await launch(
        join(root, "proxy-profile"),
        join(root, "proxy-downloads"),
        connection,
      );
      try {
        const page = await proxied.newPage();
        await page.goto(`${origin}/article?target=/pdf-proxy`);
        let downloadAt = 0;
        const downloading = page.waitForEvent("download").then((download) => {
          downloadAt = performance.now();
          return download;
        });
        const click = page.getByRole("link", { name: "Download" }).click();
        await proxyFirst.promise;
        const download = await downloading;
        expect(sent.get("/pdf-proxy")!.ended).toBe(0);
        expect(downloadAt).toBeGreaterThan(0);
        proxyFinish.resolve();
        await click;
        expect(await readDownload(download)).toBe(digest(payload));
        expect(downloadAt).toBeLessThan(sent.get("/pdf-proxy")!.ended);
        expect(sent.get("/pdf-proxy")!.requests).toBe(1);
        evidence.http_proxy = {
          server_first_byte_at: sent.get("/pdf-proxy")!.first,
          server_ended_at: sent.get("/pdf-proxy")!.ended,
          browser_download_at: downloadAt,
          first_byte_was_buffered: false,
        };
      } finally {
        proxyFinish.resolve();
        await proxied.close();
        await proxy.close();
      }
    }, 15000);
  },
);
