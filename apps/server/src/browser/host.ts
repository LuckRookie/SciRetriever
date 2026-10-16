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
import {
  parseStrictJsonObject,
  type OperatorInput,
} from "@sciretriever/contracts";
import type { BrowserProxyConnection } from "../network/browser-proxy.js";
import {
  BrowserPageClosedError,
  BrowserPageCrashedError,
  BrowserPageRuntime,
  BrowserPageTransitionError,
  type BrowserPageApplyResult,
} from "./page-runtime.js";
import type { BrowserArticleSessionIdentity } from "./article-session.js";
import {
  BrowserCdpOwner,
  type BrowserOwnedRequest,
  type BrowserPageOwnership,
  type BrowserDocumentCommit,
  type BrowserRequestAdmission,
} from "./cdp-owner.js";
import { clearOwnedDebugEndpoint, OwnedBrowserCdpConnection } from "./cdp.js";
import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright";
import { acquireFileLock, type FileLock } from "../storage/locking.js";
import type { BrowserPageSnapshot } from "./observation.js";
import { randomUUID } from "node:crypto";

export class BrowserHostError extends Error {
  readonly code: string = "browser-host";
  constructor(cause?: unknown) {
    super("browser host operation failed", { cause });
    this.name = "BrowserHostError";
  }
}
export class BrowserHostRuntimeError extends Error {
  readonly code = "browser-runtime-lost" as const;
  constructor(cause?: unknown) {
    super("shared Browser runtime disconnected", { cause });
    this.name = "BrowserHostRuntimeError";
  }
}
export class BrowserHostNavigationError extends BrowserHostError {
  override readonly code = "browser-navigation-failed" as const;
  constructor(
    cause?: unknown,
    readonly recoverable = false,
  ) {
    super(cause);
    this.message = "Browser navigation did not commit";
    this.name = "BrowserHostNavigationError";
  }
}
export class BrowserHostCleanupError extends BrowserHostError {
  override readonly code = "browser-session-cleanup-failed" as const;
  constructor(cause: unknown) {
    super(cause);
    this.message = "Owned Browser session cleanup failed";
    this.name = "BrowserHostCleanupError";
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
  readonly maxSessions?: number;
  /** Exact top-level document allowed by a reachability-only Site probe. */
  readonly probeDocumentUrl?: string;
  /** Network must return the exact URL that it admitted for navigation. */
  readonly admitNavigation?: BrowserNavigationAdmission;
  readonly beforeRequest?: (
    identity: BrowserOwnedRequest,
    url: string,
    drainPrevious: () => Promise<BrowserRequestAdmission>,
  ) => Promise<BrowserRequestAdmission>;
  readonly navigationRetryFailed?: (identity: BrowserOwnedRequest) => void;
  readonly requestEnded?: (identity: BrowserOwnedRequest) => void;
  readonly documentCommitted?: (document: BrowserDocumentCommit) => void;
  readonly resumeDocument?: (
    document: BrowserDocumentCommit,
    drainPrevious: () => Promise<void>,
  ) => Promise<void>;
  readonly onRuntimeLost?: () => void;
  readonly rateLimited?: (
    identity: BrowserOwnedRequest,
    retryAfter: string | null,
  ) => void;
  readonly transferStallMs?: number;
  readonly transferLifetimeMs?: number;
}
export type {
  BrowserOwnedRequest,
  BrowserDocumentCommit,
} from "./cdp-owner.js";
export interface BrowserPageHandle {
  readonly id: string;
  readonly session_id?: string;
  close(): Promise<void>;
  /** Make this page the active tab for navigation, observation and input. */
  activate?(): Promise<void>;
  title(): Promise<string>;
  /** Returns a query-free, fragment-free URL observation. */
  url(): string;
  /** Navigate the active page through the same Network admission as initial navigation. */
  navigate?(url: string): Promise<void>;
  /** Private preparation fact; never exposed in observations or persisted. */
  navigationUrl?(): string | null;
  /** Retained initial failure, allowing capture settlement before entry recovery. */
  readonly initial_navigation_failure?: { readonly recoverable: boolean };
  snapshot(): Promise<BrowserPageSnapshot>;
  settleCaptures?(): Promise<void>;
  retryRateLimit?(signal: AbortSignal, deadlineAt: number): Promise<boolean>;
  apply(
    input: OperatorInput,
    documentGeneration: number,
    current: () => boolean,
  ): Promise<unknown>;
  /** Activate the newest popup/viewer opened by this page, if one exists. */
  successor?(): Promise<BrowserPageHandle | null>;
}
export interface BrowserPageInfo {
  readonly id: string;
  readonly url: string;
  readonly title: string;
  readonly active: boolean;
  readonly opener_id: string | null;
  readonly session_id?: string;
}
interface HostArticleSession {
  readonly id: string;
  readonly identity: BrowserArticleSessionIdentity | null;
  readonly controller: AbortController;
  readonly pageIds: Set<string>;
  networkAllowed: boolean;
  closing: boolean;
  openingPage?: Promise<Page>;
  closePromise?: Promise<void>;
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
    parsed.password !== ""
  )
    invalid();
  parsed.hash = "";
  return parsed.toString();
}

function observedUrl(value: string): string {
  const parsed = new URL(safeNavigationUrl(value));
  parsed.search = "";
  return parsed.toString();
}

/** Set only the native PDF download preference while holding the Profile lease. */
async function configurePdfDownloads(profile: string): Promise<void> {
  const directory = join(profile, "Default");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await validateProfile(directory);
  const path = join(directory, "Preferences");
  let preferences: Record<string, unknown> = {};
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const metadata = await file.stat();
      if (!metadata.isFile() || metadata.nlink !== 1) invalid();
      preferences = parseStrictJsonObject(await file.readFile());
    } finally {
      await file.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const plugins = preferences.plugins ?? {};
  if (typeof plugins !== "object" || plugins === null || Array.isArray(plugins))
    invalid();
  if (
    "always_open_pdf_externally" in plugins &&
    plugins.always_open_pdf_externally === true
  )
    return;
  preferences.plugins = { ...plugins, always_open_pdf_externally: true };
  const temporary = join(
    directory,
    `.sciretriever-preferences-${randomUUID()}`,
  );
  try {
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(JSON.stringify(preferences));
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
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
  private readonly targetPages = new Map<string, string>();
  private readonly pageTargets = new Map<string, string>();
  private readonly targetParents = new Map<string, string>();
  private readonly pageSessions = new Map<string, HostArticleSession>();
  private readonly sessions = new Map<string, HostArticleSession>();
  private readonly seenSessions = new Set<string>();
  private readonly closedPages = new Set<string>();
  private readonly tracking = new Map<Page, Promise<string>>();
  private inputTail: Promise<void> = Promise.resolve();
  private protocol: OwnedBrowserCdpConnection | undefined;
  private cdp: BrowserCdpOwner | undefined;
  private downloadsDirectory: string | undefined;
  private readonly runtimes = new Map<string, BrowserPageRuntime>();
  /** A blocked document navigation cannot be interpreted as a normal no-PDF page. */
  private readonly blockedNavigations = new Set<string>();
  /** Last admitted top-level locator, retained only while its page is owned. */
  private readonly navigationUrls = new Map<string, string>();
  private readonly historyResumes = new Map<string, Promise<void>>();
  private activePageId: string | undefined;
  private sequence = 0;
  private state: BrowserHostDiagnostics["status"] = "stopped";
  private failure: BrowserHostDiagnostics["code"];
  private startPromise: Promise<void> | undefined;
  private closePromise: Promise<void> | undefined;
  private runtimeShutdown: Promise<void> | undefined;
  private readonly closedContexts = new WeakSet<BrowserContext>();
  private closing = false;
  private runtimeLost = false;

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
        typeof options.admitNavigation !== "function") ||
      (options.maxSessions !== undefined &&
        (!Number.isSafeInteger(options.maxSessions) ||
          options.maxSessions < 1 ||
          options.maxSessions > 8))
    )
      invalid();
    if (options.runtime) {
      assertVerifiedCloakRuntime(options.runtime);
      if (options.executablePath || options.headless === true) invalid();
    }
    this.transfers = options.transfers
      ? new BrowserTransferDispatcher(
          {
            ...options.transfers,
            captureContext: (pageId, generation, sourceUrl) => {
              const session = this.pageSessions.get(pageId);
              if (!session || session.closing) return null;
              const capture = options.transfers!.captureContext(
                pageId,
                generation,
                sourceUrl,
                session.id,
              );
              if (
                capture &&
                session.identity &&
                (capture.session_id !== session.id ||
                  capture.article_id !== session.identity.literature_id)
              )
                throw new BrowserHostError();
              return capture;
            },
          },
          {
            ...(options.transferStallMs !== undefined
              ? { stall_ms: options.transferStallMs }
              : {}),
            ...(options.transferLifetimeMs !== undefined
              ? { lifetime_ms: options.transferLifetimeMs }
              : {}),
          },
        )
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
        await configurePdfDownloads(this.options.profile);
        await clearOwnedDebugEndpoint(this.options.profile);
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
            acceptDownloads: this.options.probeDocumentUrl === undefined,
            ...(this.options.probeDocumentUrl
              ? { javaScriptEnabled: false }
              : {}),
            serviceWorkers: "block",
            ...(this.options.proxy
              ? { proxy: { ...this.options.proxy, bypass: "<-loopback>" } }
              : {}),
            args: [
              ...runtimeArgs,
              "--disable-quic",
              "--disable-features=WebTransport",
              "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
              "--remote-debugging-port=0",
              "--remote-debugging-address=127.0.0.1",
            ],
            viewport: this.options.runtime
              ? null
              : { width: 1280, height: 720 },
          },
        );
        const context = this.context;
        context.once("close", () => this.closedContexts.add(context));
      } catch {
        this.failure = "launch";
        throw new BrowserHostError();
      }
      this.downloadsDirectory = await mkdtemp(
        join(tmpdir(), "sciretriever-browser-downloads-"),
      );
      this.protocol = await OwnedBrowserCdpConnection.connect(
        this.options.profile,
      );
      this.protocol.onDisconnect(() => {
        this.loseRuntime(this.context);
      });
      this.cdp = new BrowserCdpOwner({
        protocol: this.protocol,
        downloads_directory: this.downloadsDirectory,
        targetCreated: (targetId, openerId) =>
          this.reserveTarget(targetId, openerId),
        documentCommitted: (document) => {
          this.options.documentCommitted?.(document);
          if (document.is_history_navigation && this.options.resumeDocument) {
            const resume = this.options.resumeDocument(document, () =>
              this.cdp!.drainSession(document.session_id),
            );
            this.historyResumes.set(document.page_id, resume);
            void resume.catch(() => {
              this.blockedNavigations.add(document.page_id);
            });
          }
        },
        resolvePage: (targetId) => this.resolveOwnership(targetId),
        beforeRequest: async (identity, url, drainPrevious) => {
          const session = this.pageSessions.get(identity.page_id);
          if (
            !session ||
            !session.networkAllowed ||
            session.closing ||
            this.closing ||
            !this.options.admitNavigation
          )
            throw new BrowserHostError();
          const requested = safeNavigationUrl(url);
          if (
            this.options.probeDocumentUrl &&
            (requested !== this.options.probeDocumentUrl ||
              !identity.is_navigation)
          )
            throw new BrowserHostError();
          if (
            !this.options.proxy &&
            !["127.0.0.1", "[::1]"].includes(new URL(requested).hostname)
          )
            throw new BrowserHostError();
          const admitted = await this.options.admitNavigation(requested);
          if (
            safeNavigationUrl(admitted) !== requested ||
            !session.networkAllowed ||
            session.closing ||
            this.closing
          )
            throw new BrowserHostError();
          const result = await this.options.beforeRequest?.(
            identity,
            requested,
            drainPrevious,
          );
          if (!session.networkAllowed || session.closing || this.closing)
            throw new BrowserHostError();
          return result;
        },
        retryNavigation: async (identity, url) => {
          const target = this.pageTargets.get(identity.page_id);
          const current = target ? this.resolveOwnership(target) : null;
          const page = this.pages.get(identity.page_id);
          if (
            !page ||
            !current ||
            current.session_id !== identity.session_id ||
            current.operation_id !== identity.operation_id ||
            current.generation !== identity.generation ||
            current.document_generation !== identity.document_generation ||
            current.signal.aborted ||
            this.closing ||
            !this.pageSessions.get(identity.page_id)?.networkAllowed
          )
            throw new BrowserHostError();
          await this.navigatePage(page, url, false);
        },
        navigationRetryFailed: (identity) =>
          this.options.navigationRetryFailed?.(identity),
        admitted: (identity, url) => {
          if (identity.is_navigation) {
            this.blockedNavigations.delete(identity.page_id);
            this.navigationUrls.set(identity.page_id, url);
          }
          this.transfers?.admitted(identity, url);
        },
        ended: (identity) => {
          this.transfers?.ended(identity);
          this.options.requestEnded?.(identity);
        },
        blocked: (ownership, navigation) => {
          if (ownership && navigation)
            this.blockedNavigations.add(ownership.page_id);
        },
        allowNative: (ownership) => {
          const session = this.sessions.get(ownership.session_id);
          return (
            !!session &&
            session.networkAllowed &&
            !session.closing &&
            !this.closing
          );
        },
        ...(this.transfers
          ? {
              pdfResponse: (
                identity: BrowserOwnedRequest,
                url: string,
                response: import("./cdp-owner.js").BrowserPdfResponse,
              ) => this.transfers!.pdfResponse(identity, url, response),
              nativeDownload: (
                download: import("./cdp-owner.js").BrowserNativeDownload,
              ) =>
                this.transfers!.nativeDownload(
                  download,
                  () => this.cdp!.retireNative(download.guid),
                  this.downloadsDirectory!,
                ),
              nativeProgress: (
                progress: import("./cdp-owner.js").BrowserNativeProgress,
              ) => this.transfers!.nativeProgress(progress),
            }
          : {}),
        ...(this.options.rateLimited
          ? { rateLimited: this.options.rateLimited }
          : {}),
        rejectedResponse: (identity, code) =>
          this.transfers?.rejectedResponse(identity, code),
        failure: () => {
          this.failure = "page";
        },
      });
      await this.cdp.start();
      await this.context.routeWebSocket("**/*", (socket) => {
        socket.close({ code: 1008, reason: "Unsupported channel" });
      });
      this.context.on("page", (page) => {
        void this.trackPage(page).catch(() => {
          if (!this.closing) this.failure = "page";
        });
      });
      for (const page of this.context.pages()) await this.trackPage(page);
      const ownedContext = this.context;
      ownedContext.on("close", () => {
        this.context = undefined;
        this.pages.clear();
        this.runtimes.clear();
        this.activePageId = undefined;
        this.pageIds.clear();
        this.pageParents.clear();
        this.loseRuntime(ownedContext);
      });
      this.state = "ready";
    } catch (error) {
      if (this.context) await this.context.close().catch(() => undefined);
      this.context = undefined;
      this.cdp?.dispose();
      this.protocol?.close();
      if (this.downloadsDirectory)
        await rm(this.downloadsDirectory, { recursive: true, force: true });
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

  async openPage(
    initialUrl?: string,
    identity?: BrowserArticleSessionIdentity,
    signal?: AbortSignal,
    options?: { readonly retainNavigationFailure: boolean },
  ): Promise<BrowserPageHandle> {
    this.assertRuntime();
    if (this.state !== "ready" || !this.context || this.closing)
      throw new BrowserHostError();
    const requested =
      initialUrl === undefined ? undefined : safeNavigationUrl(initialUrl);
    const sessionId = identity?.session_id ?? "browser-session-" + randomUUID();
    if (
      this.seenSessions.has(sessionId) ||
      this.sessions.size >= (this.options.maxSessions ?? 5)
    )
      throw new BrowserHostError();
    if (
      identity &&
      (!identity.session_id ||
        !identity.operation_id ||
        !identity.literature_id ||
        !Number.isSafeInteger(identity.generation) ||
        identity.generation < 0)
    )
      throw new BrowserHostError();
    const frozen = identity
      ? Object.freeze({
          ...identity,
          metadata_snapshot: Object.freeze({ ...identity.metadata_snapshot }),
        })
      : null;
    const session: HostArticleSession = {
      id: sessionId,
      identity: frozen,
      controller: new AbortController(),
      pageIds: new Set(),
      networkAllowed: true,
      closing: false,
    };
    this.seenSessions.add(sessionId);
    this.sessions.set(sessionId, session);
    let page: Page | undefined;
    let id: string | undefined;
    const cancelOpening = () => {
      void this.closeSession(session).catch(() => {
        this.failure = "close";
      });
    };
    signal?.addEventListener("abort", cancelOpening, { once: true });
    try {
      if (signal?.aborted) throw new BrowserHostNavigationError();
      session.openingPage = this.context.newPage();
      page = await session.openingPage;
      if (signal?.aborted || session.closing)
        throw new BrowserHostNavigationError();
      id = await this.trackPage(page);
      if (signal?.aborted || session.closing)
        throw new BrowserHostNavigationError();
      this.pageSessions.set(id, session);
      session.pageIds.add(id);
      await this.cdp?.ready(this.pageTargets.get(id)!);
      if (signal?.aborted || session.closing)
        throw new BrowserHostNavigationError();
      let navigationFailure: BrowserHostNavigationError | undefined;
      if (requested !== undefined) {
        try {
          await this.navigatePage(page, requested);
        } catch (error) {
          if (
            !options?.retainNavigationFailure ||
            !(error instanceof BrowserHostNavigationError)
          )
            throw error;
          navigationFailure = error;
        }
      }
      await this.withPageInput(id, page, async () => undefined);
      if (signal?.aborted || session.closing)
        throw new BrowserHostNavigationError();
      return {
        ...this.handle(id, page),
        ...(navigationFailure
          ? {
              initial_navigation_failure: {
                recoverable: navigationFailure.recoverable,
              },
            }
          : {}),
      };
    } catch (error) {
      try {
        await this.closeSession(session);
      } catch (closeError) {
        throw new BrowserHostCleanupError(
          new AggregateError(
            [error, closeError],
            "Browser open cleanup failed",
          ),
        );
      }
      if (this.runtimeLost) throw new BrowserHostRuntimeError(error);
      if (error instanceof BrowserHostNavigationError) throw error;
      throw new BrowserHostError(error);
    } finally {
      signal?.removeEventListener("abort", cancelOpening);
      delete session.openingPage;
    }
  }

  sessionForPage(pageId: string): string | null {
    return this.pageSessions.get(pageId)?.id ?? null;
  }
  setSessionNetworkAccess(sessionId: string, allowed: boolean): void {
    const session = this.sessions.get(sessionId);
    if (
      !session ||
      session.closing ||
      session.controller.signal.aborted ||
      this.runtimeLost
    ) {
      if (!allowed) return;
      throw new BrowserHostError();
    }
    session.networkAllowed = allowed;
  }
  async stopSessionNetwork(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.networkAllowed = false;
    await this.cdp?.stopSession(sessionId);
    await this.cdp?.drainSession(sessionId);
  }
  private closeSession(session: HostArticleSession): Promise<void> {
    session.closePromise ??= (async () => {
      session.closing = true;
      session.networkAllowed = false;
      session.controller.abort();
      const errors: unknown[] = [];
      const stopErrors: unknown[] = [];
      const closedPages = new Set<Page>();
      const closePage = async (page: Page) => {
        if (closedPages.has(page) || page.isClosed()) return;
        closedPages.add(page);
        try {
          await page.close();
        } catch (error) {
          if (!page.isClosed()) errors.push(error);
        }
      };
      // Dispatch physical closes before cooperative stop: stopLoading can leave
      // a failed navigation's error document unable to finish page.close.
      // Real native writers remain Browser-owned and still require their terminal.
      const pageClosures = [...session.pageIds]
        .map((id) => this.pages.get(id))
        .filter((page): page is Page => page !== undefined)
        .map(closePage);
      if (session.openingPage)
        pageClosures.push(session.openingPage.then(closePage, () => undefined));
      if (this.runtimeLost) {
        try {
          await this.runtimeShutdown;
          this.cdp?.dispose();
        } catch (error) {
          errors.push(error);
        }
      } else {
        try {
          await this.cdp?.stopSession(session.id, false);
        } catch (error) {
          stopErrors.push(error);
        }
      }
      // A failed renderer command is not a terminal. Independently cancel the
      // real writer and close every owned page, then await actual network ends.
      try {
        await this.transfers?.cancelSession(session.id);
      } catch (error) {
        errors.push(error);
      }
      // Await raw late page creation, never the open/navigation that close stops.
      await Promise.all(pageClosures);
      try {
        await this.cdp?.drainSession(session.id);
      } catch (error) {
        errors.push(error);
      }
      if (errors.length) {
        const causes = [...stopErrors, ...errors];
        throw causes.length === 1
          ? causes[0]
          : new AggregateError(causes, "Owned Browser session cleanup failed");
      }
      // A successful page/native close and drain supersede a failed stop command.
      this.cdp?.sessionClosed(session.id);
      for (const id of session.pageIds) this.pageSessions.delete(id);
      this.sessions.delete(session.id);
    })();
    return session.closePromise;
  }
  private async withPageInput<T>(
    id: string,
    page: Page,
    operation: () => Promise<T>,
  ): Promise<T> {
    let release!: () => void;
    const predecessor = this.inputTail;
    this.inputTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await predecessor;
    try {
      this.assertRuntime();
      const session = this.pageSessions.get(id);
      if (
        !this.pages.has(id) ||
        page.isClosed() ||
        !session ||
        session.closing ||
        session.controller.signal.aborted
      )
        throw new BrowserHostError();
      await page.bringToFront();
      this.activePageId = id;
      return await operation();
    } finally {
      release();
    }
  }

  /** Return a bounded, query-free tab projection for the current workspace. */
  async listPages(): Promise<readonly BrowserPageInfo[]> {
    this.assertRuntime();
    if (this.state !== "ready" || this.closing) throw new BrowserHostError();
    const result: BrowserPageInfo[] = [];
    for (const [id, page] of this.pages) {
      if (page.isClosed()) continue;
      let url = "about:blank";
      let title = "";
      try {
        if (page.url() !== "about:blank") url = observedUrl(page.url());
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
          ...(this.pageSessions.get(id)
            ? { session_id: this.pageSessions.get(id)!.id }
            : {}),
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
      await this.withPageInput(id, page, async () => undefined);
    } catch {
      this.failure = "page";
      throw new BrowserHostError();
    }
    this.activePageId = id;
    return this.handle(id, page);
  }

  private handle(id: string, page: Page): BrowserPageHandle {
    let returnTo: [string, Page] | null = null;
    return {
      id,
      ...(this.pageSessions.get(id)
        ? { session_id: this.pageSessions.get(id)!.id }
        : {}),
      close: async () => {
        const session = this.pageSessions.get(id);
        if (!this.pages.has(id) && !session) return;
        try {
          if (session) await this.closeSession(session);
          else await page.close();
        } catch (error) {
          this.failure = "page";
          throw new BrowserHostError(error);
        }
      },
      activate: async () => {
        if (!this.pages.has(id) || page.isClosed())
          throw new BrowserHostError();
        try {
          await this.withPageInput(id, page, async () => undefined);
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
          return observedUrl(page.url());
        } catch {
          throw new BrowserHostError();
        }
      },
      navigate: async (nextUrl: string) => {
        if (!this.pages.has(id) || this.pageSessions.get(id)?.closing)
          throw new BrowserHostError();
        const requested = safeNavigationUrl(nextUrl);
        try {
          await this.navigatePage(page, requested);
        } catch (error) {
          this.failure = "page";
          if (this.runtimeLost) throw new BrowserHostRuntimeError(error);
          if (error instanceof BrowserHostNavigationError) throw error;
          throw new BrowserHostNavigationError(error);
        }
      },
      navigationUrl: () => {
        if (!this.pages.has(id)) throw new BrowserHostError();
        const value = page.url();
        return value === "about:blank" || value.startsWith("chrome-error:")
          ? (this.navigationUrls.get(id) ?? null)
          : safeNavigationUrl(value);
      },
      retryRateLimit: async (signal, deadlineAt) =>
        this.runtimes.get(id)?.retryRateLimit(signal, deadlineAt) ?? false,
      settleCaptures: async () => {
        const sessionId = this.pageSessions.get(id)?.id;
        if (sessionId) await this.transfers?.settle(sessionId);
      },
      snapshot: async () => {
        this.assertRuntime();
        const target = this.pageTargets.get(id);
        if (target !== undefined) {
          const generation = this.cdp?.documentGeneration(target);
          if (generation !== undefined)
            await this.cdp?.navigationRecovery(target, generation);
        }
        const generation =
          target === undefined
            ? undefined
            : this.cdp?.documentGeneration(target);
        const recovery =
          target === undefined
            ? undefined
            : this.cdp?.navigationRecoveryRequest(target);
        const runtime = this.runtimes.get(id);
        if (
          !runtime ||
          this.pageSessions.get(id)?.closing ||
          this.blockedNavigations.has(id)
        )
          throw new BrowserHostError();
        const documentChanged = () =>
          target !== undefined &&
          generation !== undefined &&
          (this.pageTargets.get(id) !== target ||
            this.cdp?.documentGeneration(target) !== generation ||
            this.cdp?.navigationRecoveryRequest(target) !== recovery);
        try {
          const snapshot = await runtime.snapshot();
          this.assertRuntime();
          if (documentChanged()) throw new BrowserPageTransitionError();
          return snapshot;
        } catch (error) {
          if (this.runtimeLost) throw new BrowserHostRuntimeError(error);
          if (
            error instanceof BrowserPageClosedError ||
            error instanceof BrowserPageCrashedError
          )
            throw error;
          if (page.isClosed()) throw new BrowserPageClosedError();
          // A changed CDP identity proves a transition even when the page RPC
          // failed with an unclassified error. Stable documents retain that error.
          if (documentChanged()) throw new BrowserPageTransitionError();
          throw error;
        }
      },
      apply: async (input, generation, current) => {
        this.assertRuntime();
        const runtime = this.runtimes.get(id);
        if (
          !runtime ||
          this.pageSessions.get(id)?.closing ||
          this.blockedNavigations.has(id)
        )
          throw new BrowserHostError();
        if (input.kind === "go-back")
          this.cdp?.expectHistoryNavigation(this.pageTargets.get(id)!);
        let result: BrowserPageApplyResult | void;
        try {
          result = await runtime.apply(input, generation, () => {
            this.assertRuntime();
            return !this.pageSessions.get(id)?.closing && current();
          });
        } catch (error) {
          if (this.runtimeLost) throw new BrowserHostRuntimeError(error);
          throw error;
        }
        const historyResume = this.historyResumes.get(id);
        if (historyResume) {
          try {
            await historyResume;
          } finally {
            this.historyResumes.delete(id);
          }
        }
        if (input.kind === "go-back" && result?.no_history) {
          const parent = this.pageParents.get(page);
          const parentId = parent ? this.pageIds.get(parent) : undefined;
          if (parent && parentId && !parent.isClosed())
            returnTo = [parentId, parent];
        }
        return result;
      },
      successor: async () => {
        const successor = returnTo ?? this.findSuccessor(id);
        if (!successor) return null;
        const [successorId, successorPage] = successor;
        if (returnTo) {
          const document = this.cdp?.currentDocument(
            this.pageTargets.get(successorId)!,
          );
          if (document && this.options.resumeDocument)
            await this.options.resumeDocument(document, () =>
              this.cdp!.drainSession(document.session_id),
            );
          returnTo = null;
          await page.close();
        }
        try {
          await this.withPageInput(
            successorId,
            successorPage,
            async () => undefined,
          );
          return this.handle(successorId, successorPage);
        } catch {
          this.failure = "page";
          throw new BrowserHostError();
        }
      },
    };
  }

  private findSuccessor(id: string): [string, Page] | null {
    const owner = this.pages.get(id);
    if (!owner) return null;
    const candidates = [...this.pages.entries()].filter(
      ([candidateId, candidate]) =>
        candidateId !== id &&
        !candidate.isClosed() &&
        this.pageParents.get(candidate) === owner,
    );
    return candidates.at(-1) ?? null;
  }
  private assertRuntime(): void {
    if (this.runtimeLost && !this.closing) throw new BrowserHostRuntimeError();
  }
  private loseRuntime(context: BrowserContext | undefined): void {
    if (this.closing || this.runtimeLost) return;
    this.failure = "context-closed";
    this.state = "failed";
    this.runtimeLost = true;
    for (const session of this.sessions.values())
      session.networkAllowed = false;
    if (context) this.shutdownRuntime(context);
    this.options.onRuntimeLost?.();
    for (const session of this.sessions.values()) session.controller.abort();
    void this.runtimeShutdown?.catch(() => {
      this.failure = "close";
    });
  }
  private shutdownRuntime(context: BrowserContext): Promise<void> {
    this.runtimeShutdown ??= context.close().catch((error: unknown) => {
      // An external process close can win while Playwright sends its own close
      // command. Only the observed context terminal supersedes that RPC error;
      // a disconnected CDP channel alone does not prove that writers stopped.
      if (!this.closedContexts.has(context)) throw error;
    });
    return this.runtimeShutdown;
  }
  private async navigatePage(
    page: Page,
    url: string,
    awaitRecovery = true,
  ): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const target = this.pageTargets.get(this.pageIds.get(page)!);
      const generation = target
        ? this.cdp?.documentGeneration(target)
        : undefined;
      const previousRecovery =
        target !== undefined && generation !== undefined
          ? this.cdp?.navigationRecovery(target, generation, url)
          : undefined;
      try {
        await page.goto(url, { waitUntil: "commit", timeout: 0 });
        return;
      } catch (error) {
        if (this.runtimeLost) throw new BrowserHostRuntimeError(error);
        if (
          awaitRecovery &&
          error instanceof Error &&
          /net::ERR_ABORTED\b/u.test(error.message) &&
          target !== undefined &&
          generation !== undefined
        ) {
          const recovery = this.cdp?.navigationRecovery(
            target,
            generation,
            url,
          );
          if (recovery && recovery !== previousRecovery) {
            await recovery;
            return;
          }
        }
        const session = this.pageSessions.get(this.pageIds.get(page)!);
        const temporary =
          error instanceof Error &&
          /net::ERR_(?:NAME_NOT_RESOLVED|DNS_TIMED_OUT|CONNECTION_RESET|CONNECTION_CLOSED|CONNECTION_REFUSED|TIMED_OUT|NETWORK_CHANGED|EMPTY_RESPONSE)\b/u.test(
            error.message,
          );
        if (
          temporary &&
          session &&
          !session.closing &&
          session.networkAllowed &&
          !session.controller.signal.aborted &&
          !this.closing &&
          target !== undefined &&
          generation !== undefined &&
          this.cdp !== undefined
        ) {
          await this.cdp.waitForDocumentChange(target, generation);
          if (
            attempt === 0 &&
            this.cdp.canRetryNavigation(target, generation, url)
          )
            continue;
        }
        // A failed redirect cannot authorize replaying its original start URL.
        throw new BrowserHostNavigationError(error, temporary);
      }
    }
  }

  private reserveTarget(targetId: string, openerId: string | undefined): void {
    let id = this.targetPages.get(targetId);
    if (!id) {
      id = "page-" + ++this.sequence;
      this.targetPages.set(targetId, id);
      this.pageTargets.set(id, targetId);
    }
    if (this.pageSessions.has(id)) return;
    if (!openerId) return;
    this.targetParents.set(targetId, openerId);
    const parentId = this.targetPages.get(openerId);
    if (parentId && this.closedPages.has(parentId)) return;
    const session = parentId ? this.pageSessions.get(parentId) : undefined;
    if (
      !session ||
      session.closing ||
      session.controller.signal.aborted ||
      session.pageIds.size >= 16
    )
      return;
    this.pageSessions.set(id, session);
    session.pageIds.add(id);
  }
  private resolveOwnership(targetId: string): BrowserPageOwnership | null {
    const id = this.targetPages.get(targetId);
    const session = id ? this.pageSessions.get(id) : undefined;
    if (!id || !session || this.closedPages.has(id)) return null;
    return Object.freeze({
      session_id: session.id,
      page_id: id,
      operation_id: session.identity?.operation_id ?? session.id,
      generation: session.identity?.generation ?? 0,
      document_generation: this.cdp?.documentGeneration(targetId) ?? 0,
      signal: session.controller.signal,
    });
  }
  private trackPage(page: Page): Promise<string> {
    const existing = this.pageIds.get(page);
    if (existing) return Promise.resolve(existing);
    const pending = this.tracking.get(page);
    if (pending) return pending;
    const tracked = this.trackPageInternal(page).finally(() => {
      this.tracking.delete(page);
    });
    this.tracking.set(page, tracked);
    return tracked;
  }
  private async trackPageInternal(page: Page): Promise<string> {
    const protocol = await page.context().newCDPSession(page);
    let targetId: string;
    try {
      const { targetInfo } = await protocol.send("Target.getTargetInfo");
      targetId = targetInfo.targetId;
      this.reserveTarget(targetId, targetInfo.openerId);
    } finally {
      await protocol.detach();
    }
    const id = this.targetPages.get(targetId)!;
    this.pages.set(id, page);
    this.pageIds.set(page, id);
    const parentTarget = this.targetParents.get(targetId);
    const parentId = parentTarget
      ? this.targetPages.get(parentTarget)
      : undefined;
    const parent = parentId ? this.pages.get(parentId) : undefined;
    if (parent) this.pageParents.set(page, parent);
    this.runtimes.set(
      id,
      new BrowserPageRuntime(
        page,
        !!this.options.runtime,
        async (url) => {
          const session = this.pageSessions.get(id);
          if (
            !session ||
            session.closing ||
            !session.networkAllowed ||
            !this.options.admitNavigation ||
            !this.transfers
          )
            throw new BrowserHostError();
          const requested = new URL(url);
          const local =
            requested.protocol === "blob:" || requested.protocol === "data:";
          const source = local ? observedUrl(page.url()) : url;
          if (!local) {
            if (
              !this.options.proxy &&
              !["127.0.0.1", "[::1]"].includes(requested.hostname)
            )
              throw new BrowserHostError();
            const admitted = await this.options.admitNavigation(url);
            if (
              safeNavigationUrl(admitted) !== safeNavigationUrl(url) ||
              session.closing ||
              !session.networkAllowed ||
              this.closing
            )
              throw new BrowserHostError();
          }
          this.transfers.prepareDownload(
            url,
            id,
            this.runtimes.get(id)!.documentGeneration(),
            source,
            session.id,
          );
        },
        (operation) => this.withPageInput(id, page, operation),
        () => this.cdp?.documentGeneration(targetId) ?? 0,
      ),
    );
    page.on("filechooser", (chooser) => {
      void chooser.setFiles([]).catch(() => {
        this.failure = "page";
      });
    });
    page.once("close", () => {
      this.closedPages.add(id);
      this.pages.delete(id);
      this.runtimes.delete(id);
      this.blockedNavigations.delete(id);
      this.navigationUrls.delete(id);
      this.pageIds.delete(page);
      this.pageParents.delete(page);
      if (this.activePageId === id)
        this.activePageId = this.pages.keys().next().value;
    });
    page.on("popup", (popup) => {
      void this.trackPage(popup).catch(() => {
        if (!this.closing) this.failure = "page";
      });
    });
    page.on("crash", () => {
      this.failure ??= "page";
    });
    return id;
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
    const sessions = [...this.sessions.values()];
    for (const session of sessions) {
      session.closing = true;
      session.networkAllowed = false;
      session.controller.abort();
    }
    const context = this.context;
    if (context || this.runtimeShutdown) {
      try {
        // Closing the persistent context owns its pages and process. Closing its
        // last headed page first races Chromium's own process shutdown.
        if (context) this.shutdownRuntime(context);
        await this.runtimeShutdown;
        this.context = undefined;
      } catch (error) {
        this.failure = "close";
        this.state = "failed";
        throw new BrowserHostError(error);
      }
    }
    this.cdp?.dispose();
    this.protocol?.close();
    // Context close is the authoritative whole-runtime writer terminal. Cleanup
    // can now settle each article without sending commands to detached targets.
    const cleanups = await Promise.allSettled(
      sessions.map((session) => this.transfers?.cancelSession(session.id)),
    );
    await this.transfers?.settle();
    await this.cdp?.retireClosedDownloads();
    this.transfers?.dispose();
    if (this.downloadsDirectory)
      await rm(this.downloadsDirectory, { recursive: true, force: true });
    await clearOwnedDebugEndpoint(this.options.profile);
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
    this.pageSessions.clear();
    this.sessions.clear();
    this.targetPages.clear();
    this.pageTargets.clear();
    this.targetParents.clear();
    this.closedPages.clear();
    this.state = "closed";
    if (cleanups.some((result) => result.status === "rejected")) {
      this.failure = "close";
      throw new BrowserHostError();
    }
  }
}
