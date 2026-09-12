import {
  BrowserTransferDispatcher,
  type BrowserTransferCallbacks,
} from "./transfers.js";
import {
  assertVerifiedCloakRuntime,
  loadCloakIdentity,
  type VerifiedCloakRuntime,
} from "../configuration/cloak-runtime.js";
import { BrowserDisplay } from "./display.js";
import type { OperatorInput } from "@sciretriever/contracts";
import type { BrowserProxyConnection } from "../network/browser-proxy.js";
import { BrowserPageRuntime } from "./page-runtime.js";
import { lstat, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright";
import { acquireFileLock, type FileLock } from "../storage/locking.js";
import type { BrowserPageSnapshot } from "./observation.js";
import { randomUUID } from "node:crypto";

export class BrowserHostError extends Error {
  readonly code = "browser-host" as const;
  constructor() {
    super("browser host operation failed");
    this.name = "BrowserHostError";
  }
}

export type BrowserNavigationAdmission = (
  url: string,
) => string | Promise<string>;
export interface BrowserHostOptions {
  readonly transfers?: BrowserTransferCallbacks;
  readonly runtime?: VerifiedCloakRuntime;
  readonly proxy?: BrowserProxyConnection;
  readonly profile: string;
  readonly executablePath?: string;
  readonly headless?: boolean;
  /** Network must return the exact URL that it admitted for navigation. */
  readonly admitNavigation?: BrowserNavigationAdmission;
}
export interface BrowserPageHandle {
  readonly id: string;
  close(): Promise<void>;
  /** Make this page the active tab for navigation, observation and input. */
  activate?(): Promise<void>;
  title(): Promise<string>;
  /** Returns a query-free, fragment-free URL observation. */
  url(): string;
  /** Navigate the active page through the same Network admission as initial navigation. */
  navigate?(url: string): Promise<void>;
  snapshot(): Promise<BrowserPageSnapshot>;
  apply(
    input: OperatorInput,
    documentGeneration: number,
    current: () => boolean,
  ): Promise<void>;
}
export interface BrowserPageInfo {
  readonly id: string;
  readonly url: string;
  readonly title: string;
  readonly active: boolean;
  readonly opener_id: string | null;
}
export interface BrowserHostDiagnostics {
  readonly boot_id: string;
  readonly service_workers: "blocked";
  readonly status: "stopped" | "starting" | "ready" | "failed" | "closed";
  readonly code?:
    | "profile-lock"
    | "profile-identity"
    | "launch"
    | "context-closed"
    | "page"
    | "close";
  readonly page_count: number;
  readonly transfer_failures: number;
}

function invalid(): never {
  throw new BrowserHostError();
}

function safeNavigationUrl(value: string): string {
  if (typeof value !== "string" || value.length > 8192) invalid();
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    invalid();
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.hash !== ""
  )
    invalid();
  parsed.search = "";
  return parsed.toString();
}

async function validateProfile(profile: string): Promise<void> {
  try {
    const metadata = await lstat(profile);
    if (!metadata.isDirectory() || metadata.mode & 0o022) invalid();
    if (
      typeof process.getuid === "function" &&
      metadata.uid !== process.getuid()
    )
      invalid();
  } catch (error) {
    if (error instanceof BrowserHostError) throw error;
    throw new BrowserHostError();
  }
}

export class BrowserHost {
  readonly bootId = randomUUID();
  private readonly options: Readonly<BrowserHostOptions>;
  private display: BrowserDisplay | undefined;
  private readonly transfers: BrowserTransferDispatcher | undefined;
  private context: BrowserContext | undefined;
  private lock: FileLock | undefined;
  private readonly pages = new Map<string, Page>();
  private readonly pageIds = new Map<Page, string>();
  private readonly pageParents = new Map<Page, Page>();
  private readonly runtimes = new Map<string, BrowserPageRuntime>();
  private activePageId: string | undefined;
  private sequence = 0;
  private state: BrowserHostDiagnostics["status"] = "stopped";
  private failure: BrowserHostDiagnostics["code"];
  private startPromise: Promise<void> | undefined;
  private closePromise: Promise<void> | undefined;
  private closing = false;

  constructor(options: BrowserHostOptions) {
    if (
      typeof options !== "object" ||
      options === null ||
      typeof options.profile !== "string" ||
      !options.profile.startsWith("/") ||
      (options.executablePath !== undefined &&
        (typeof options.executablePath !== "string" ||
          !options.executablePath.startsWith("/"))) ||
      (options.headless !== undefined &&
        typeof options.headless !== "boolean") ||
      (options.admitNavigation !== undefined &&
        typeof options.admitNavigation !== "function")
    )
      invalid();
    if (options.runtime) {
      assertVerifiedCloakRuntime(options.runtime);
      if (options.executablePath || options.headless === true) invalid();
    }
    this.transfers = options.transfers
      ? new BrowserTransferDispatcher({
          ...options.transfers,
          admitDownload: (url, pageId) =>
            this.admitDownload(url, pageId, options.transfers!),
        })
      : undefined;
    this.options = Object.freeze({
      ...options,
      profile: resolve(options.profile),
    });
  }

  diagnostics(): BrowserHostDiagnostics {
    return Object.freeze({
      boot_id: this.bootId,
      service_workers: "blocked" as const,
      status: this.state,
      ...(this.failure ? { code: this.failure } : {}),
      page_count: this.pages.size,
      transfer_failures: this.transfers?.failureCount() ?? 0,
    });
  }

  async start(): Promise<void> {
    if (this.startPromise) return this.startPromise;
    if (this.state === "ready") return;
    if (this.state === "closed" || this.state === "failed" || this.closing)
      throw new BrowserHostError();
    this.startPromise = this.startInternal();
    try {
      await this.startPromise;
    } finally {
      this.startPromise = undefined;
    }
  }

  private async startInternal(): Promise<void> {
    this.state = "starting";
    try {
      await mkdir(this.options.profile, { recursive: true, mode: 0o700 });
      await validateProfile(this.options.profile);
      try {
        this.lock = await acquireFileLock(
          this.options.profile,
          "browser-profile",
        );
      } catch {
        this.failure = "profile-lock";
        throw new BrowserHostError();
      }
      let runtimeArgs: string[] = [];
      let runtimeEnvironment: Record<string, string> | undefined;
      if (this.options.runtime) {
        const identity = await loadCloakIdentity(this.options.profile);
        this.display = new BrowserDisplay();
        const display = await this.display.start();
        runtimeArgs = [
          `--fingerprint=${identity.seed}`,
          "--fingerprint-platform=linux",
          "--lang=en-US",
          "--fingerprint-timezone=UTC",
          "--window-size=1920,1080",
          "--disable-component-update",
          "--disable-default-apps",
          "--disable-sync",
          "--no-first-run",
        ];
        runtimeEnvironment = {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          LANG: "en_US.UTF-8",
          TZ: "UTC",
          DISPLAY: display,
        };
      }
      try {
        this.context = await chromium.launchPersistentContext(
          this.options.profile,
          {
            ...(this.options.runtime
              ? {
                  executablePath: this.options.runtime.executablePath,
                  ignoreDefaultArgs: [
                    "--enable-automation",
                    "--enable-unsafe-swiftshader",
                  ],
                  ...(runtimeEnvironment ? { env: runtimeEnvironment } : {}),
                }
              : {}),
            ...(this.options.executablePath
              ? { executablePath: this.options.executablePath }
              : {}),
            headless: this.options.headless ?? false,
            acceptDownloads: true,
            serviceWorkers: "block",
            ...(this.options.proxy
              ? { proxy: { ...this.options.proxy, bypass: "<-loopback>" } }
              : {}),
            args: [
              ...runtimeArgs,
              "--disable-quic",
              "--disable-features=WebTransport",
              "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
            ],
            viewport: this.options.runtime
              ? null
              : { width: 1280, height: 720 },
          },
        );
      } catch {
        this.failure = "launch";
        throw new BrowserHostError();
      }
      await this.context.route("**/*", async (route) => {
        try {
          const request = route.request();
          let page: Page;
          try {
            page = request.frame().page();
          } catch {
            // Chromium exposes a popup's first navigation before its frame is
            // created. Validate that request against the active page origin,
            // then continue it; subsequent popup requests have a stable page
            // handle and go through the normal transfer admission path.
            if (
              !request.isNavigationRequest() ||
              !this.admitInitialPopupUrl(request.url())
            )
              throw new BrowserHostError();
            const admitted = await this.options.admitNavigation?.(
              request.url(),
            );
            if (admitted !== request.url() || this.closing)
              throw new BrowserHostError();
            await route.continue();
            return;
          }
          const known = this.pageIds.has(page);
          const pageId = this.pageIds.get(page) ?? this.trackPage(page);
          const related = known
            ? this.pageBelongsToActiveWorkspace(page)
            : this.admitInitialPopup(page, request.url());
          if (
            !related ||
            !this.options.admitNavigation ||
            request.headers()["upgrade"] ||
            request.headers()["content-type"]?.startsWith("multipart/")
          )
            throw new BrowserHostError();
          const requested = request.url();
          if (
            !this.options.proxy &&
            !["127.0.0.1", "[::1]"].includes(new URL(requested).hostname)
          )
            throw new BrowserHostError();
          const admitted = await this.options.admitNavigation(requested);
          if (admitted !== requested || this.closing || page.isClosed())
            throw new BrowserHostError();
          this.transfers?.admitted(
            request,
            pageId,
            this.runtimes.get(pageId)!.documentGeneration(),
          );
          await route.continue();
        } catch {
          try {
            await route.abort("blockedbyclient");
          } catch {
            if (!this.closing) this.failure = "page";
          }
        }
      });
      await this.context.routeWebSocket("**/*", (socket) => {
        socket.close({ code: 1008, reason: "Unsupported channel" });
      });
      this.context.on("page", (page) => {
        this.trackPage(page);
      });
      for (const page of this.context.pages()) this.trackPage(page);
      this.context.on("close", () => {
        this.context = undefined;
        this.pages.clear();
        this.runtimes.clear();
        this.activePageId = undefined;
        this.pageIds.clear();
        this.pageParents.clear();
        if (!this.closing) {
          this.failure = "context-closed";
          this.state = "failed";
        }
      });
      this.state = "ready";
    } catch (error) {
      if (this.context) await this.context.close().catch(() => undefined);
      this.context = undefined;
      await this.display?.close();
      if (this.lock) {
        await this.lock.release().catch(() => undefined);
        this.lock = undefined;
      }
      this.state = "failed";
      if (error instanceof BrowserHostError) throw error;
      throw new BrowserHostError();
    }
  }

  async openPage(initialUrl?: string): Promise<BrowserPageHandle> {
    if (this.state !== "ready" || !this.context || this.closing)
      throw new BrowserHostError();
    let admittedUrl: string | undefined;
    if (initialUrl !== undefined) {
      const requested = safeNavigationUrl(initialUrl);
      const admitted =
        (await this.options.admitNavigation?.(requested)) ?? requested;
      admittedUrl = safeNavigationUrl(admitted);
    }
    let page: Page;
    try {
      page = await this.context.newPage();
    } catch {
      this.failure = "page";
      throw new BrowserHostError();
    }
    const id = this.trackPage(page);
    this.activePageId = id;
    try {
      if (admittedUrl !== undefined)
        await page.goto(admittedUrl, { waitUntil: "domcontentloaded" });
      await page.bringToFront();
    } catch {
      await this.removePage(id, page).catch(() => undefined);
      throw new BrowserHostError();
    }
    return this.handle(id, page);
  }

  /** Return a bounded, query-free tab projection for the current workspace. */
  async listPages(): Promise<readonly BrowserPageInfo[]> {
    if (this.state !== "ready" || this.closing) throw new BrowserHostError();
    const result: BrowserPageInfo[] = [];
    for (const [id, page] of this.pages) {
      if (page.isClosed()) continue;
      let url = "about:blank";
      let title = "";
      try {
        if (page.url() !== "about:blank") url = safeNavigationUrl(page.url());
        title = (await page.title()).slice(0, 4096);
      } catch {
        continue;
      }
      const opener = this.pageParents.get(page);
      result.push(
        Object.freeze({
          id,
          url,
          title,
          active: id === this.activePageId,
          opener_id: opener ? (this.pageIds.get(opener) ?? null) : null,
        }),
      );
    }
    return Object.freeze(result);
  }

  /** Activate an existing tab without creating a second Browser context. */
  async activatePage(id: string): Promise<BrowserPageHandle> {
    if (this.state !== "ready" || this.closing) throw new BrowserHostError();
    const page = this.pages.get(id);
    if (!page || page.isClosed()) throw new BrowserHostError();
    try {
      await page.bringToFront();
    } catch {
      this.failure = "page";
      throw new BrowserHostError();
    }
    this.activePageId = id;
    return this.handle(id, page);
  }

  private handle(id: string, page: Page): BrowserPageHandle {
    return {
      id,
      close: async () => {
        if (!this.pages.has(id)) return;
        try {
          await this.transfers?.settle();
          await page.close();
        } catch {
          this.failure = "page";
          throw new BrowserHostError();
        }
      },
      activate: async () => {
        if (!this.pages.has(id) || page.isClosed())
          throw new BrowserHostError();
        try {
          await page.bringToFront();
          this.activePageId = id;
        } catch {
          this.failure = "page";
          throw new BrowserHostError();
        }
      },
      title: async () => {
        if (!this.pages.has(id)) throw new BrowserHostError();
        try {
          return (await page.title()).slice(0, 4096);
        } catch {
          throw new BrowserHostError();
        }
      },
      url: () => {
        if (!this.pages.has(id)) throw new BrowserHostError();
        try {
          return safeNavigationUrl(page.url());
        } catch {
          throw new BrowserHostError();
        }
      },
      navigate: async (nextUrl: string) => {
        if (!this.pages.has(id) || this.activePageId !== id)
          throw new BrowserHostError();
        const requested = safeNavigationUrl(nextUrl);
        const admitted =
          (await this.options.admitNavigation?.(requested)) ?? requested;
        const admittedUrl = safeNavigationUrl(admitted);
        if (admittedUrl !== requested) throw new BrowserHostError();
        try {
          await page.goto(admittedUrl, { waitUntil: "domcontentloaded" });
        } catch {
          this.failure = "page";
          throw new BrowserHostError();
        }
      },
      snapshot: async () => {
        const runtime = this.runtimes.get(id);
        if (!runtime || this.activePageId !== id) throw new BrowserHostError();
        return runtime.snapshot();
      },
      apply: async (input, generation, current) => {
        const runtime = this.runtimes.get(id);
        if (!runtime || this.activePageId !== id) throw new BrowserHostError();
        await runtime.apply(
          input,
          generation,
          () => this.activePageId === id && current(),
        );
      },
    };
  }

  private trackPage(page: Page): string {
    const existing = this.pageIds.get(page);
    if (existing) return existing;
    const id = `page-${++this.sequence}`;
    this.pages.set(id, page);
    this.runtimes.set(
      id,
      new BrowserPageRuntime(page, !!this.options.runtime, async (url) => {
        if (
          !this.options.admitNavigation ||
          !this.transfers ||
          !this.pageBelongsToActiveWorkspace(page)
        )
          throw new BrowserHostError();
        const requested = new URL(url);
        const source =
          requested.protocol === "blob:" || requested.protocol === "data:"
            ? safeNavigationUrl(page.url())
            : url;
        if (
          requested.protocol !== "blob:" &&
          requested.protocol !== "data:" &&
          !this.options.proxy &&
          !["127.0.0.1", "[::1]"].includes(requested.hostname)
        )
          throw new BrowserHostError();
        if (requested.protocol !== "blob:" && requested.protocol !== "data:") {
          const admitted = await this.options.admitNavigation(url);
          if (admitted !== url || this.closing || this.activePageId !== id)
            throw new BrowserHostError();
        }
        this.transfers.prepareDownload(
          url,
          id,
          this.runtimes.get(id)!.documentGeneration(),
          source,
        );
      }),
    );
    this.transfers?.track(page, id);
    this.pageIds.set(page, id);
    page.once("close", () => {
      this.pages.delete(id);
      this.runtimes.delete(id);
      this.pageIds.delete(page);
      this.pageParents.delete(page);
      if (this.activePageId === id) {
        const next = this.pages.keys().next().value as string | undefined;
        this.activePageId = next;
      }
    });
    page.on("popup", (popup) => {
      this.pageParents.set(popup, page);
      this.trackPage(popup);
    });
    page.on("crash", () => {
      this.failure ??= "page";
    });
    return id;
  }
  private async removePage(id: string, page: Page): Promise<void> {
    this.pages.delete(id);
    this.pageIds.delete(page);
    await page.close();
  }

  /**
   * A popup opened by the active page is part of the same controlled
   * workspace. Unrelated pages remain denied so a stray context page cannot
   * acquire the current article's transfer binding.
   */
  private pageBelongsToActiveWorkspace(page: Page): boolean {
    const pageId = this.pageIds.get(page);
    if (pageId === this.activePageId) return true;
    const opener = this.pageParents.get(page);
    return (
      opener !== undefined && this.pageIds.get(opener) === this.activePageId
    );
  }

  private async admitDownload(
    requestedUrl: string,
    pageId: string,
    callbacks: NonNullable<BrowserHostOptions["transfers"]>,
  ): Promise<import("@sciretriever/contracts").CandidateCapture | null> {
    const page = [...this.pages.entries()].find(([id]) => id === pageId)?.[1];
    const runtime = this.runtimes.get(pageId);
    if (!page || !runtime || !this.pageBelongsToActiveWorkspace(page))
      return null;
    let parsed: URL;
    try {
      parsed = new URL(requestedUrl);
    } catch {
      return null;
    }
    if (
      !["http:", "https:"].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password ||
      parsed.hash ||
      (!this.options.proxy && !["127.0.0.1", "[::1]"].includes(parsed.hostname))
    )
      return null;
    const admitted = await this.options.admitNavigation?.(requestedUrl);
    if (admitted !== requestedUrl || this.closing) return null;
    parsed.search = "";
    parsed.hash = "";
    return callbacks.captureContext(
      pageId,
      runtime.documentGeneration(),
      parsed.toString(),
    );
  }

  /**
   * Playwright may dispatch a popup's first navigation before the `popup`
   * event reaches the opener. Admit only a same-origin first request and bind
   * it to the active page; cross-origin or unrelated context pages remain
   * blocked until an explicit workspace relationship exists.
   */
  private admitInitialPopup(page: Page, requestedUrl: string): boolean {
    if (!this.admitInitialPopupUrl(requestedUrl)) return false;
    const active = [...this.pages.entries()].find(
      ([id]) => id === this.activePageId,
    )?.[1];
    if (!active) return false;
    this.pageParents.set(page, active);
    return true;
  }

  private admitInitialPopupUrl(requestedUrl: string): boolean {
    const active = [...this.pages.entries()].find(
      ([id]) => id === this.activePageId,
    )?.[1];
    if (!active) return false;
    try {
      const requested = new URL(requestedUrl);
      const origin = new URL(active.url()).origin;
      if (
        requested.origin !== origin ||
        !["http:", "https:"].includes(requested.protocol)
      )
        return false;
    } catch {
      return false;
    }
    return true;
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.closePromise = this.closeInternal();
    return this.closePromise;
  }

  private async closeInternal(): Promise<void> {
    if (this.state === "closed") return;
    if (this.startPromise) {
      try {
        await this.startPromise;
      } catch {
        this.state = "closed";
        return;
      }
    }
    await this.transfers?.settle();
    this.transfers?.dispose();
    const context = this.context;
    if (context) {
      try {
        // Closing the persistent context owns its pages and process. Closing its
        // last headed page first races Chromium's own process shutdown.
        await context.close();
        this.context = undefined;
      } catch {
        this.failure = "close";
        this.state = "failed";
        throw new BrowserHostError();
      }
    }
    try {
      await this.lock?.release();
    } catch {
      this.failure = "close";
      this.state = "failed";
      throw new BrowserHostError();
    }
    this.lock = undefined;
    await this.display?.close();
    this.pages.clear();
    this.runtimes.clear();
    this.pageIds.clear();
    this.pageParents.clear();
    this.state = "closed";
  }
}
