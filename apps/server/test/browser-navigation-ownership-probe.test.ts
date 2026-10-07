import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright";
import { describe, expect, it } from "vitest";
import { BrowserDisplay } from "../src/browser/display.js";
import {
  loadCloakIdentity,
  verifyInstalledCloakRuntime,
} from "../src/configuration/cloak-runtime.js";

interface TargetInfo {
  readonly targetId: string;
  readonly type: string;
  readonly url: string;
  readonly openerId?: string;
}
interface ProbeEvent {
  readonly sequence: number;
  readonly event: string;
  readonly [key: string]: unknown;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timeout`)), 10000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function listen(server: Server): Promise<string> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture");
  return `http://127.0.0.1:${address.port}`;
}

/** Owns raw flattened protocol messages without Playwright private fields. */
class ProbeCdpConnection {
  private sequence = 0;
  private readonly commands = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  private readonly handlers = new Map<
    string,
    (params: Record<string, unknown>, sessionId: string | undefined) => void
  >();
  constructor(private readonly socket: WebSocket) {
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as {
        id?: number;
        result?: unknown;
        error?: { message: string };
        method?: string;
        params?: Record<string, unknown>;
        sessionId?: string;
      };
      if (message.id !== undefined) {
        const pending = this.commands.get(message.id);
        if (!pending) return;
        this.commands.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result);
      } else if (message.method) {
        this.handlers.get(message.method)?.(
          message.params ?? {},
          message.sessionId,
        );
      }
    });
  }
  static async connect(profile: string): Promise<ProbeCdpConnection> {
    const [port, path] = (
      await readFile(join(profile, "DevToolsActivePort"), "utf8")
    )
      .trim()
      .split("\n");
    if (
      !port ||
      !/^\d+$/u.test(port) ||
      !path?.startsWith("/devtools/browser/")
    )
      throw new Error("invalid local CDP endpoint");
    const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`);
    await bounded(
      new Promise<void>((resolve, reject) => {
        socket.addEventListener("open", () => resolve(), { once: true });
        socket.addEventListener(
          "error",
          () => reject(new Error("local CDP unavailable")),
          { once: true },
        );
      }),
      "local CDP connection",
    );
    return new ProbeCdpConnection(socket);
  }
  on(
    method: string,
    handler: (
      params: Record<string, unknown>,
      sessionId: string | undefined,
    ) => void,
  ): void {
    this.handlers.set(method, handler);
  }
  send(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
  ): Promise<unknown> {
    const id = ++this.sequence;
    const response = new Promise<unknown>((resolve, reject) => {
      this.commands.set(id, { resolve, reject });
    });
    this.socket.send(
      JSON.stringify({
        id,
        method,
        params,
        ...(sessionId ? { sessionId } : {}),
      }),
    );
    return bounded(response, method);
  }
  close(): void {
    this.socket.close();
  }
}

/** The production adapter must own Target, Network and both Fetch stages. */
class ProbeTargetGate {
  readonly targetSessions = new Map<string, string>();
  readonly owners = new Map<string, string>();
  readonly closedOwners = new Set<string>();
  readonly errors: Error[] = [];
  private readonly setup = new Map<string, Promise<void>>();
  readonly denied = deferred<void>();
  readonly redirectDenied = deferred<void>();
  readonly firstPdf = deferred<void>();
  readonly popups = deferred<void>();
  readonly scriptPopup = deferred<void>();
  readonly latePopup = deferred<void>();
  readonly unowned = deferred<void>();
  readonly popupSetupHeld = deferred<void>();
  readonly popupSetupRelease = deferred<void>();
  holdPopupSetup = false;
  private heldSetups = 0;
  private popupRequests = 0;
  constructor(
    private readonly cdp: ProbeCdpConnection,
    private readonly context: BrowserContext,
    private readonly record: (
      event: string,
      data?: Record<string, unknown>,
    ) => void,
    private readonly permittedOrigins: Set<string>,
  ) {}

  async start(): Promise<void> {
    this.cdp.on("Fetch.requestPaused", (params, sessionId) => {
      if (sessionId !== undefined)
        throw new Error("Fetch must be browser-owned");
      const targetId = params.frameId as string;
      void this.request(targetId, params).catch((error: Error) =>
        this.errors.push(error),
      );
    });
    this.cdp.on("Network.requestWillBeSent", (params, sessionId) => {
      const targetId = [...this.targetSessions.entries()].find(
        ([, knownSessionId]) => knownSessionId === sessionId,
      )?.[0];
      if (!targetId) throw new Error("unregistered network target");
      const request = params.request as { url: string };
      this.record("cdp-network", {
        targetId,
        owner: this.owners.get(targetId) ?? null,
        path: new URL(request.url).pathname,
        frameId: params.frameId,
        requestId: params.requestId,
        redirected: params.redirectResponse !== undefined,
      });
    });
    this.cdp.on("Target.targetCreated", (params) => {
      const targetInfo = params.targetInfo as TargetInfo;
      if (targetInfo.openerId) {
        const owner = this.owners.get(targetInfo.openerId);
        if (owner && !this.closedOwners.has(owner))
          this.owners.set(targetInfo.targetId, owner);
      }
      this.record("cdp-target-created", {
        targetId: targetInfo.targetId,
        openerId: targetInfo.openerId ?? null,
        type: targetInfo.type,
      });
    });
    this.cdp.on("Target.attachedToTarget", (params) => {
      const targetInfo = params.targetInfo as TargetInfo;
      const sessionId = params.sessionId as string;
      this.targetSessions.set(targetInfo.targetId, sessionId);
      if (targetInfo.openerId) {
        const owner = this.owners.get(targetInfo.openerId);
        if (owner && !this.closedOwners.has(owner)) {
          this.owners.set(targetInfo.targetId, owner);
        }
      }
      this.record("cdp-attached", {
        targetId: targetInfo.targetId,
        openerId: targetInfo.openerId ?? null,
        owner: this.owners.get(targetInfo.targetId) ?? null,
      });
      const setup = this.configure(targetInfo, sessionId);
      this.setup.set(targetInfo.targetId, setup);
      void setup.catch((error: Error) => this.errors.push(error));
    });
    await this.cdp.send("Fetch.enable", {
      patterns: [{ urlPattern: "*", requestStage: "Request" }],
    });
    this.record("browser-fetch-supported");
    await this.cdp.send("Target.setDiscoverTargets", { discover: true });
    await this.cdp.send("Target.setAutoAttach", {
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: true,
      filter: [{ type: "page" }, { exclude: true }],
    });
  }

  private async configure(info: TargetInfo, sessionId: string): Promise<void> {
    if (info.openerId && this.holdPopupSetup) {
      this.record("popup-setup-held", { targetId: info.targetId });
      if (++this.heldSetups === 2) this.popupSetupHeld.resolve();
      await this.popupSetupRelease.promise;
    }
    await this.command(sessionId, "Network.enable");
    await this.command(sessionId, "Page.enable");
    await this.command(sessionId, "Runtime.runIfWaitingForDebugger");
    this.record("cdp-gate-ready", { targetId: info.targetId });
  }

  private async command(
    sessionId: string,
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<unknown> {
    return this.cdp.send(method, params, sessionId);
  }

  async register(page: Page, owner: string): Promise<string> {
    const pageCdp = await this.context.newCDPSession(page);
    try {
      const { targetInfo } = (await pageCdp.send("Target.getTargetInfo")) as {
        targetInfo: TargetInfo;
      };
      await this.setup.get(targetInfo.targetId);
      if (this.owners.has(targetInfo.targetId))
        throw new Error("target already owned");
      this.owners.set(targetInfo.targetId, owner);
      this.record("root-owner", { targetId: targetInfo.targetId, owner });
      return targetInfo.targetId;
    } finally {
      await pageCdp.detach();
    }
  }

  private async request(
    targetId: string,
    params: Record<string, unknown>,
  ): Promise<void> {
    const { url } = params.request as { url: string };
    const parsed = new URL(url);
    const owner = this.owners.get(targetId);
    if (
      params.responseStatusCode !== undefined ||
      params.responseErrorReason !== undefined
    ) {
      this.record("cdp-fetch-response", {
        targetId,
        frameId: params.frameId,
        requestId: params.requestId,
        networkId: params.networkId,
        owner: owner ?? null,
        path: parsed.pathname,
        status: params.responseStatusCode ?? null,
      });
      await this.cdp.send("Fetch.continueResponse", {
        requestId: params.requestId,
      });
      return;
    }
    const allowed =
      owner !== undefined &&
      !this.closedOwners.has(owner) &&
      this.permittedOrigins.has(parsed.origin);
    this.record("cdp-fetch-paused", {
      targetId,
      frameId: params.frameId,
      requestId: params.requestId,
      networkId: params.networkId,
      owner: owner ?? null,
      path: parsed.pathname,
      allowed,
    });
    await this.cdp.send(
      allowed ? "Fetch.continueRequest" : "Fetch.failRequest",
      {
        requestId: params.requestId,
        ...(allowed
          ? { interceptResponse: true }
          : { errorReason: "BlockedByClient" }),
      },
    );
    this.record(allowed ? "cdp-admitted" : "cdp-denied", {
      targetId,
      owner: owner ?? null,
      path: parsed.pathname,
    });
    if (parsed.pathname === "/popup" && allowed) {
      if (++this.popupRequests === 2) this.popups.resolve();
    }
    if (parsed.pathname === "/first.pdf" && allowed) this.firstPdf.resolve();
    if (parsed.pathname === "/script-popup" && allowed)
      this.scriptPopup.resolve();
    if (parsed.pathname === "/late-popup" && !allowed) this.latePopup.resolve();
    if (parsed.pathname === "/unowned" && !allowed) this.unowned.resolve();
    if (parsed.pathname === "/denied-background") this.denied.resolve();
    if (parsed.pathname === "/denied-redirect") this.redirectDenied.resolve();
  }
}

describe.runIf(!!process.env.SCIRETRIEVER_CLOAK_BUNDLE)(
  "verified Cloak navigation ownership probe",
  () => {
    it.each([1, 2, 3])(
      "binds popup and redirect first requests with an initialization barrier (run %s)",
      async () => {
        const runtime = await verifyInstalledCloakRuntime(
          process.env.SCIRETRIEVER_CLOAK_BUNDLE!,
        );
        const evidence = await mkdtemp(
          join(tmpdir(), "sciretriever-navigation-ownership-"),
        );
        const profile = join(evidence, "profile");
        await mkdir(profile, { mode: 0o700 });
        const identity = await loadCloakIdentity(profile);
        const events: ProbeEvent[] = [];
        const record = (event: string, data: Record<string, unknown> = {}) => {
          events.push({ sequence: events.length + 1, event, ...data });
        };
        let originA = "";
        let originB = "";
        let deniedOrigin = "";
        const servers = Array.from({ length: 3 }, (_, index) =>
          createServer((request, response) => {
            const path = new URL(request.url!, `http://${request.headers.host}`)
              .pathname;
            record("server-request", { origin: index, path });
            if (path === "/doi") {
              response.writeHead(302, { location: `${originB}/landing` });
              response.end();
            } else if (path === "/redirect-denied") {
              response.writeHead(302, {
                location: `${deniedOrigin}/denied-redirect`,
              });
              response.end();
            } else if (path === "/first.pdf") {
              response.writeHead(200, {
                "Content-Type": "application/pdf",
                "Content-Disposition": 'attachment; filename="synthetic.pdf"',
              });
              response.end("%PDF-1.4\n% synthetic navigation probe\n%%EOF\n");
            } else {
              response.writeHead(200, { "Content-Type": "text/html" });
              response.end(
                "<title>Ownership probe</title><main>synthetic</main>",
              );
            }
          }),
        );
        const display = new BrowserDisplay();
        let context: BrowserContext | undefined;
        let connection: ProbeCdpConnection | undefined;
        let gate: ProbeTargetGate | undefined;
        try {
          const origins = await Promise.all(servers.map(listen));
          originA = origins[0]!;
          originB = origins[1]!;
          deniedOrigin = origins[2]!;
          const displayName = await display.start();
          context = await chromium.launchPersistentContext(profile, {
            executablePath: runtime.executablePath,
            headless: false,
            acceptDownloads: true,
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
            },
            args: [
              `--fingerprint=${identity.seed}`,
              "--fingerprint-platform=linux",
              "--fingerprint-timezone=UTC",
              "--lang=en-US",
              "--disable-component-update",
              "--disable-default-apps",
              "--disable-sync",
              "--no-first-run",
              "--disable-quic",
              "--disable-features=WebTransport",
              "--remote-debugging-port=0",
              "--remote-debugging-address=127.0.0.1",
            ],
          });
          connection = await ProbeCdpConnection.connect(profile);
          const version = (await connection.send("Browser.getVersion")) as {
            product: string;
          };
          record("runtime", {
            version: runtime.version,
            product: version.product,
          });
          const pdfDownload = deferred<{ frameId: string }>();
          connection.on("Browser.downloadWillBegin", (params) => {
            record("cdp-download-started", {
              frameId: params.frameId,
              path: new URL(params.url as string).pathname,
            });
            pdfDownload.resolve({ frameId: params.frameId as string });
          });
          await connection.send("Browser.setDownloadBehavior", {
            behavior: "allowAndName",
            downloadPath: join(evidence, "downloads"),
            eventsEnabled: true,
          });
          gate = new ProbeTargetGate(
            connection,
            context,
            record,
            new Set([originA, originB]),
          );
          await gate.start();
          const pageOwners = new Map<Page, string>();
          const aPopup = deferred<Page>();
          context.on("page", (page) => {
            record("playwright-page");
            void page.opener().then((opener) => {
              const owner = opener ? pageOwners.get(opener) : undefined;
              if (owner) pageOwners.set(page, owner);
              if (owner === "article-a") aPopup.resolve(page);
              record("playwright-opener", { owner: owner ?? null });
            });
          });
          await context.route("**/*", async (route) => {
            const request = route.request();
            let owner: string | null = null;
            let frameAvailable = false;
            try {
              const page = request.frame().page();
              frameAvailable = true;
              owner = pageOwners.get(page) ?? null;
            } catch {
              // The event log records this known public API limitation.
            }
            record("playwright-route", {
              path: new URL(request.url()).pathname,
              owner,
              frameAvailable,
            });
            // This local probe deliberately delegates the actual gate to CDP.
            // CDP remains paused even when Playwright has no Page for a popup.
            await route.continue();
          });
          const a = await context.newPage();
          const b = await context.newPage();
          pageOwners.set(a, "article-a");
          pageOwners.set(b, "article-b");
          const targetA = await gate.register(a, "article-a");
          const targetB = await gate.register(b, "article-b");
          await Promise.all([
            a.goto(`${originA}/article-a`),
            b.goto(`${originB}/article-b`),
          ]);
          await b.bringToFront();
          record("foreground", { owner: "article-b" });

          // Same URL is intentional: attribution cannot use URL or event timing.
          gate.holdPopupSetup = true;
          const opened = Promise.all([
            a.evaluate((url) => {
              window.open(url);
            }, `${originB}/popup`),
            b.evaluate((url) => {
              window.open(url);
            }, `${originB}/popup`),
          ]);
          await bounded(gate.popupSetupHeld.promise, "popup setup barrier");
          await bounded(gate.popups.promise, "two popup first requests");
          expect(
            events.filter((event) => event.event === "popup-setup-held"),
          ).toHaveLength(2);
          expect(
            events.filter(
              (event) =>
                event.event === "cdp-fetch-paused" && event.path === "/popup",
            ),
          ).toHaveLength(2);
          gate.holdPopupSetup = false;
          gate.popupSetupRelease.resolve();
          await bounded(opened, "parent popup scripts");
          const popupRequests = events.filter(
            (event) =>
              event.event === "cdp-fetch-paused" && event.path === "/popup",
          );
          expect(popupRequests.map((event) => event.owner).sort()).toEqual([
            "article-a",
            "article-b",
          ]);
          for (const popup of popupRequests) {
            const attached = events.find(
              (event) =>
                event.event === "cdp-attached" &&
                event.targetId === popup.targetId,
            )!;
            expect(attached.openerId).toBe(
              popup.owner === "article-a" ? targetA : targetB,
            );
            expect(attached.sequence).toBeLessThan(popup.sequence);
          }

          await a.goto(`${originA}/doi`);
          expect(a.url()).toBe(`${originB}/landing`);
          expect(
            events.some(
              (event) =>
                event.event === "cdp-fetch-paused" &&
                event.path === "/landing" &&
                event.owner === "article-a",
            ),
          ).toBe(true);
          await b.bringToFront();
          await a.evaluate(async (url) => {
            await fetch(url);
          }, `${originB}/background-permitted`);
          expect(
            events.some(
              (event) =>
                event.event === "cdp-fetch-paused" &&
                event.path === "/background-permitted" &&
                event.owner === "article-a" &&
                event.allowed === true,
            ),
          ).toBe(true);
          await a.evaluate((url) => {
            setTimeout(() => {
              window.open(url);
            }, 0);
          }, `${originB}/script-popup`);
          await bounded(gate.scriptPopup.promise, "spontaneous popup");
          await a.evaluate((url) => {
            window.open(url);
          }, `${originB}/first.pdf`);
          await bounded(gate.firstPdf.promise, "first PDF admission");
          const nativeDownload = await bounded(
            pdfDownload.promise,
            "popup PDF download",
          );
          const firstPdf = events.find(
            (event) =>
              event.event === "cdp-fetch-paused" && event.path === "/first.pdf",
          )!;
          expect(firstPdf.owner).toBe("article-a");
          expect(nativeDownload.frameId).toBe(firstPdf.frameId);
          expect(
            events.some(
              (event) =>
                event.event === "cdp-fetch-response" &&
                event.path === "/first.pdf" &&
                event.owner === "article-a" &&
                event.status === 200,
            ),
          ).toBe(true);

          gate.closedOwners.add("article-b");
          await b.evaluate((url) => {
            void fetch(url).catch(() => undefined);
          }, `${originB}/denied-background`);
          await bounded(gate.denied.promise, "inactive background rejection");
          expect(
            events.some(
              (event) =>
                event.event === "server-request" &&
                event.path === "/denied-background",
            ),
          ).toBe(false);
          const childA = await bounded(aPopup.promise, "article A popup page");
          gate.closedOwners.add("article-a");
          await a.close();
          await childA.evaluate((url) => {
            window.open(url);
          }, `${originB}/late-popup`);
          await bounded(
            gate.latePopup.promise,
            "closed-parent popup rejection",
          );
          expect(
            events.some(
              (event) =>
                event.event === "server-request" &&
                event.path === "/late-popup",
            ),
          ).toBe(false);
          const unowned = await context.newPage();
          await unowned.goto(`${originB}/unowned`).catch(() => undefined);
          await bounded(gate.unowned.promise, "unowned request rejection");
          expect(
            events.some(
              (event) =>
                event.event === "server-request" && event.path === "/unowned",
            ),
          ).toBe(false);
          const denialPage = await context.newPage();
          await gate.register(denialPage, "article-denial");
          await denialPage
            .goto(`${originA}/redirect-denied`)
            .catch(() => undefined);
          await bounded(gate.redirectDenied.promise, "redirect rejection");
          expect(
            events.some(
              (event) =>
                event.event === "server-request" &&
                event.path === "/denied-redirect",
            ),
          ).toBe(false);
          expect(gate.errors).toEqual([]);
        } finally {
          gate?.popupSetupRelease.resolve();
          await context?.close();
          connection?.close();
          await display.close();
          await Promise.all(
            servers.map(
              (server) =>
                new Promise<void>((resolve) => server.close(() => resolve())),
            ),
          );
          await writeFile(
            join(evidence, "events.json"),
            JSON.stringify(
              {
                runtime: runtime.version,
                events,
                errors: gate?.errors.map((error) => error.message) ?? [],
              },
              null,
              2,
            ),
          );
          await rm(profile, { recursive: true, force: true });
          console.info(`Navigation ownership evidence: ${evidence}`);
        }
      },
      60000,
    );
  },
);
