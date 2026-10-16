import { constants } from "node:fs";
import { open, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  BrowserProtocolError,
  type BrowserProtocol,
  type BrowserProtocolEvent,
} from "./cdp.js";

export interface BrowserPageOwnership {
  readonly session_id: string;
  readonly page_id: string;
  readonly operation_id: string;
  readonly generation: number;
  readonly document_generation: number;
  readonly signal: AbortSignal;
}
export interface BrowserOwnedRequest extends BrowserPageOwnership {
  readonly request_id: string;
  readonly request_method: string;
  readonly resource_type: string;
  readonly is_navigation: boolean;
  readonly frame_id: string;
  /** Exact network loader identity; never inferred from URL or foreground. */
  readonly document_id: string | null;
  /** Owning top document for embedded frames. */
  readonly parent_document_id: string | null;
  /** Committed source document, or the document that created this popup. */
  readonly source_document_id: string | null;
  readonly redirected_request_id: string | null;
}
export interface BrowserDocumentCommit extends BrowserPageOwnership {
  readonly frame_id: string;
  readonly document_id: string;
  readonly parent_document_id: string | null;
  readonly is_main: boolean;
  readonly navigation_request_id: string | null;
  readonly is_history_navigation?: true;
  readonly is_error_document?: true;
}
interface RequestRecord {
  readonly identity: BrowserOwnedRequest;
  readonly url: string;
  readonly target_id: string;
  readonly frame_id: string;
  readonly network_id: string | undefined;
  readonly document_bound: boolean;
  document_replaced: boolean;
  /** Exact renderer terminal; acquired response IO still needs its own close. */
  renderer_terminal: boolean;
  protocol_session: string | undefined;
  admitted: boolean;
  native_response: boolean;
  stream_response: boolean;
  response_cancel?: () => Promise<void>;
  readonly terminal: Promise<void>;
  readonly end: () => void;
}
interface DocumentContext {
  readonly frame: string;
  readonly document: string;
  readonly target: string;
  readonly session: string;
  readonly unique: string | null;
}
/** A canceled, previously authorized main GET must obtain a fresh admission. */
export type BrowserRequestAdmission = void | {
  readonly kind: "retry-navigation";
};
interface NavigationRecovery {
  readonly request: BrowserOwnedRequest;
  readonly url: string;
  readonly completed: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
  active: boolean;
}
export interface BrowserPdfResponse {
  readonly status: number;
  readonly content_length: number | null;
  chunks(signal: AbortSignal): AsyncIterable<Uint8Array>;
  cancel(): Promise<void>;
}
export interface BrowserNativeDownload {
  readonly guid: string;
  readonly page: BrowserPageOwnership;
  readonly url: string;
  readonly completed: Promise<void>;
  /** Resolves only after the stopped native writer's original is deleted. */
  readonly retired: Promise<void>;
  chunks(signal: AbortSignal): AsyncIterable<Uint8Array>;
  cancel(): Promise<void>;
}
export interface BrowserNativeProgress {
  readonly guid: string;
  readonly received_bytes: number;
  readonly total_bytes: number | null;
  readonly state: "inProgress" | "completed" | "canceled";
}
interface NativeRecord {
  readonly page: BrowserPageOwnership | null;
  readonly completed: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
  readonly retired: Promise<void>;
  readonly retireDone: () => void;
  readonly request_id: string | null;
  bytes: number;
  terminal: boolean;
  retirement_pending: boolean;
  cancellation?: Promise<void>;
}
export interface BrowserCdpOwnerOptions {
  readonly protocol: BrowserProtocol;
  readonly downloads_directory: string;
  targetCreated(targetId: string, openerId: string | undefined): void;
  documentCommitted?(document: BrowserDocumentCommit): void;
  resolvePage(targetId: string): BrowserPageOwnership | null;
  beforeRequest(
    identity: BrowserOwnedRequest,
    url: string,
    drainPrevious: () => Promise<BrowserRequestAdmission>,
  ): Promise<BrowserRequestAdmission>;
  retryNavigation?(identity: BrowserOwnedRequest, url: string): Promise<void>;
  navigationRetryFailed?(identity: BrowserOwnedRequest): void;
  admitted(identity: BrowserOwnedRequest, url: string): void;
  ended?(identity: BrowserOwnedRequest): void;
  blocked(page: BrowserPageOwnership | null, navigation: boolean): void;
  pdfResponse?(
    identity: BrowserOwnedRequest,
    url: string,
    response: BrowserPdfResponse,
  ): Promise<void>;
  nativeDownload?(download: BrowserNativeDownload): void;
  allowNative?(page: BrowserPageOwnership): boolean;
  nativeProgress?(progress: BrowserNativeProgress): void;
  rateLimited?(identity: BrowserOwnedRequest, retryAfter: string | null): void;
  rejectedResponse?(identity: BrowserOwnedRequest, code: string): void;
  failure(): void;
}

function text(value: unknown): string {
  if (typeof value !== "string" || value.length > 8192)
    throw new BrowserProtocolError();
  return value;
}
function object(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new BrowserProtocolError();
  return value as Record<string, unknown>;
}
function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const completed = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  // Registration happens before an asynchronous download consumer can attach.
  void completed.catch(() => undefined);
  return { completed, resolve, reject };
}

// These consumers belong to the exact document, unlike keepalive-capable Fetch,
// browser-owned Other/Prefetch, or independent EventSource/WebSocket lifetimes.
const DOCUMENT_RESOURCE_TYPES = new Set([
  "Script",
  "XHR",
  "Image",
  "Stylesheet",
  "Font",
]);

/** One browser-root Fetch owner gates all targets before their first request. */
export class BrowserCdpOwner {
  private closed = false;
  private readonly listeners: (() => void)[] = [];
  private readonly targets = new Map<string, string>();
  private readonly frames = new Map<string, string>();
  private readonly pageTargets = new Map<string, string>();
  private readonly frameDocuments = new Map<string, string>();
  private readonly frameRoots = new Map<string, string>();
  private readonly frameParents = new Map<string, string>();
  private readonly documentRoots = new Map<string, string>();
  private readonly committedNetworkFrames = new Set<string>();
  private readonly historyNavigations = new Map<string, string>();
  private readonly targetSources = new Map<string, string | null>();
  private readonly navigations = new Map<
    string,
    {
      readonly request: string;
      readonly network: string | undefined;
      session: string | undefined;
      document: string | null;
      readonly source: string | null;
      readonly identity: BrowserOwnedRequest;
      readonly url: string;
      connection_failed: boolean;
    }
  >();
  private readonly documentWaiters = new Set<{
    readonly target: string;
    readonly generation: number;
    readonly resolve: () => void;
  }>();
  private readonly errorDocuments = new Set<string>();
  private readonly workers = new Map<
    string,
    {
      readonly parent: string;
      readonly page: string;
      readonly frame: string;
      readonly document: string;
      readonly root: string;
    }
  >();
  private readonly workerTargets = new Set<string>();
  private readonly destroyedTargets = new Set<string>();
  private readonly targetWaiters = new Map<string, Set<() => void>>();
  private readonly documentGenerations = new Map<string, number>();
  private readonly networkDocuments = new Map<
    string,
    {
      frame: string;
      document: string | null;
      redirected_request: string | null;
      worker: string | null;
      resource_type: string | null;
    }
  >();
  private readonly setups = new Map<string, Promise<void>>();
  private readonly requests = new Map<string, RequestRecord>();
  /** Attribution survives a failed renderer response until its late GUID arrives. */
  private readonly nativeResponses = new Map<string, RequestRecord>();
  private readonly documentContexts = new Map<string, DocumentContext>();
  private readonly lostDocumentContexts = new Map<string, DocumentContext>();
  private readonly recoveries = new Map<string, NavigationRecovery>();
  private readonly natives = new Map<string, NativeRecord>();
  private readonly pending = new Set<Promise<void>>();
  private readonly drains = new Set<{
    readonly session: string;
    readonly finish: () => void;
  }>();
  constructor(private readonly options: BrowserCdpOwnerOptions) {}

  async start(): Promise<void> {
    this.listen("Target.targetCreated", ({ params }) => {
      const info = object(params.targetInfo);
      if (info.type === "page") this.created(info);
    });
    this.listen("Target.attachedToTarget", ({ params, session_id }) => {
      const info = object(params.targetInfo);
      const targetId = text(info.targetId);
      const sessionId = text(params.sessionId);
      this.targets.set(targetId, sessionId);
      if (info.type === "page") this.created(info);
      else if (info.type === "iframe") {
        const parent = this.frames.get(targetId);
        if (parent)
          this.pageTargets.set(
            targetId,
            this.pageTargets.get(parent) ?? parent,
          );
        this.frames.set(targetId, targetId);
      } else if (info.type === "worker") {
        this.workerTargets.add(targetId);
        const parent = this.targetForSession(session_id);
        const inherited = parent ? this.workers.get(parent) : undefined;
        const frame = inherited?.frame ?? parent;
        const page =
          inherited?.page ??
          (parent ? (this.pageTargets.get(parent) ?? parent) : undefined);
        const document =
          inherited?.document ??
          (frame ? this.frameDocuments.get(frame) : undefined);
        const root =
          inherited?.root ?? (frame ? this.frameRoots.get(frame) : undefined);
        if (!parent || !frame || !page || !document || !root) {
          this.track(
            this.options.protocol
              .send("Runtime.runIfWaitingForDebugger", {}, sessionId)
              .then(() => undefined),
          );
          return;
        }
        this.workers.set(targetId, { parent, page, frame, document, root });
        this.pageTargets.set(targetId, page);
      } else return;
      const setup = this.setup(sessionId, info.type === "worker");
      this.setups.set(targetId, setup);
      this.track(setup);
    });
    this.listen("Target.detachedFromTarget", ({ params }) => {
      const sessionId = text(params.sessionId);
      const targetId = this.targetForSession(sessionId);
      if (!targetId) return;
      this.forgetDocumentContexts((context) => context.session === sessionId);
      this.targets.delete(targetId);
      this.setups.delete(targetId);
      this.workers.delete(targetId);
      this.workerTargets.delete(targetId);
    });
    this.listen("Target.targetDestroyed", ({ params }) => {
      const targetId = text(params.targetId);
      this.forgetDocumentContexts((context) => context.target === targetId);
      if (this.targetWaiters.has(targetId)) this.destroyedTargets.add(targetId);
      this.targets.delete(targetId);
      this.setups.delete(targetId);
      this.workers.delete(targetId);
      this.workerTargets.delete(targetId);
      this.recoveries.get(targetId)?.reject(new BrowserProtocolError("closed"));
      this.recoveries.delete(targetId);
      // Renderer destruction does not close an acquired IO handle or a native
      // writer. Keep those original resources until their own cleanup confirms.
      for (const [id, request] of this.requests)
        if (request.target_id === targetId) {
          request.renderer_terminal = true;
          if (
            !this.nativeWriterLive(id) &&
            !request.stream_response &&
            !request.response_cancel
          )
            this.end(id);
        }
      for (const resolve of this.targetWaiters.get(targetId) ?? []) resolve();
    });
    this.listen("Page.frameAttached", ({ params, session_id }) => {
      const targetId = this.targetForSession(session_id);
      if (targetId) {
        const frame = text(params.frameId);
        const parent = text(params.parentFrameId);
        this.frames.set(frame, targetId);
        this.pageTargets.set(frame, this.pageTargets.get(targetId) ?? targetId);
        this.frameParents.set(frame, parent);
        const root =
          this.frameRoots.get(parent) ?? this.frameDocuments.get(parent);
        if (root) this.frameRoots.set(frame, root);
      }
    });
    this.listen("Page.frameNavigated", ({ params, session_id }) => {
      const targetId = this.targetForSession(session_id);
      if (targetId) this.committed(object(params.frame), targetId);
    });
    this.listen("Page.frameDetached", ({ params }) => {
      if (params.reason === "swap") return;
      this.forgetDocumentContexts(
        (context) => context.frame === text(params.frameId),
      );
      this.frames.delete(text(params.frameId));
      this.frameDocuments.delete(text(params.frameId));
      this.frameRoots.delete(text(params.frameId));
      this.frameParents.delete(text(params.frameId));
      this.navigations.delete(text(params.frameId));
    });
    this.listen("Runtime.executionContextCreated", ({ params, session_id }) => {
      if (!session_id) return;
      const context = object(params.context);
      if (
        typeof context.id !== "number" ||
        !Number.isSafeInteger(context.id) ||
        context.auxData === undefined
      )
        return;
      const auxiliary = object(context.auxData);
      if (auxiliary.isDefault !== true || typeof auxiliary.frameId !== "string")
        return;
      const frame = text(auxiliary.frameId);
      const target = this.targetForSession(session_id);
      const document = this.frameDocuments.get(frame);
      const navigation = this.navigations.get(frame)?.document;
      if (
        !target ||
        !document ||
        this.frames.get(frame) !== target ||
        this.lostDocumentContexts.get(frame)?.document === document ||
        (navigation && navigation !== document)
      )
        return;
      // Contexts have a frame but no loader. Bind only after that frame's known
      // commit, never to the old loader while a replacement is provisional.
      const key = `${session_id}\n${context.id}`;
      if (!this.documentContexts.has(key) && this.documentContexts.size >= 4096)
        throw new BrowserProtocolError();
      this.documentContexts.set(key, {
        frame,
        document,
        target,
        session: session_id,
        unique: context.uniqueId === undefined ? null : text(context.uniqueId),
      });
    });
    this.listen(
      "Runtime.executionContextDestroyed",
      ({ params, session_id }) => {
        if (!session_id || typeof params.executionContextId !== "number")
          return;
        const key = `${session_id}\n${params.executionContextId}`;
        const context = this.documentContexts.get(key);
        if (
          context &&
          (params.executionContextUniqueId === undefined ||
            params.executionContextUniqueId === context.unique)
        )
          this.documentContextLost(key, context);
      },
    );
    this.listen("Runtime.executionContextsCleared", ({ session_id }) => {
      if (!session_id) return;
      for (const [key, context] of this.documentContexts)
        if (context.session === session_id)
          this.documentContextLost(key, context);
    });
    this.listen("Network.requestWillBeSent", ({ params, session_id }) => {
      if (!session_id) return;
      const target = this.targetForSession(session_id);
      const worker = target ? this.workers.get(target) : undefined;
      if (
        !worker &&
        (typeof params.frameId !== "string" ||
          typeof params.loaderId !== "string")
      )
        return;
      const frame = worker?.frame ?? text(params.frameId);
      const loader = worker?.document ?? text(params.loaderId);
      const network = text(params.requestId);
      const key = `${session_id}\n${network}`;
      const navigation = this.navigations.get(frame);
      if (!worker && params.type === "Document" && navigation)
        navigation.connection_failed = false;
      const redirectedRequest =
        params.redirectResponse !== undefined && navigation?.network === network
          ? navigation.request
          : null;
      if (!this.networkDocuments.has(key) && this.networkDocuments.size >= 4096)
        throw new BrowserProtocolError();
      this.networkDocuments.set(key, {
        frame,
        document: loader || null,
        redirected_request: redirectedRequest,
        worker: worker ? target! : null,
        resource_type:
          typeof params.type === "string"
            ? text(params.type).toLowerCase()
            : null,
      });
      if (
        navigation?.network === network &&
        (!navigation.session || navigation.session === session_id)
      ) {
        navigation.session = session_id;
        navigation.document = loader || null;
      }
      // Root Fetch can precede an attached target's Network domain. Bind its
      // later event by exact frame + network request identity, never by URL.
      for (const request of this.requests.values())
        if (
          request.network_id === network &&
          request.frame_id === frame &&
          !request.protocol_session
        )
          request.protocol_session = session_id;
    });
    this.listen("Fetch.requestPaused", (event) => {
      this.track(this.paused(event));
    });
    this.listen("Network.loadingFinished", (event) => this.finished(event));
    this.listen("Network.loadingFailed", (event) => this.finished(event));
    this.listen("Browser.downloadWillBegin", ({ params }) =>
      this.download(params),
    );
    this.listen("Browser.downloadProgress", ({ params }) =>
      this.progress(params),
    );
    await this.options.protocol.send("Fetch.enable", {
      patterns: [{ urlPattern: "*", requestStage: "Request" }],
    });
    await this.options.protocol.send("Browser.setDownloadBehavior", {
      behavior: "allowAndName",
      downloadPath: this.options.downloads_directory,
      eventsEnabled: true,
    });
    await this.options.protocol.send("Target.setDiscoverTargets", {
      discover: true,
    });
    await this.options.protocol.send("Target.setAutoAttach", {
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: true,
      filter: [{ type: "page" }, { type: "iframe" }, { exclude: true }],
    });
  }
  private listen(
    method: string,
    listener: (event: BrowserProtocolEvent) => void,
  ): void {
    this.listeners.push(
      this.options.protocol.on(method, (event) => {
        if (this.closed) return;
        try {
          listener(event);
        } catch {
          this.options.failure();
        }
      }),
    );
  }
  private track(promise: Promise<void>): void {
    const tracked = promise
      .catch(() => {
        if (!this.closed) this.options.failure();
      })
      .finally(() => {
        this.pending.delete(tracked);
      });
    this.pending.add(tracked);
  }
  private created(info: Readonly<Record<string, unknown>>): void {
    const targetId = text(info.targetId);
    this.frames.set(targetId, targetId);
    this.pageTargets.set(targetId, targetId);
    if (!this.documentGenerations.has(targetId))
      this.documentGenerations.set(targetId, 0);
    if (!this.targetSources.has(targetId)) {
      const opener =
        info.openerFrameId === undefined
          ? info.openerId === undefined
            ? undefined
            : text(info.openerId)
          : text(info.openerFrameId);
      this.targetSources.set(
        targetId,
        opener
          ? (this.frameRoots.get(opener) ??
              this.frameDocuments.get(opener) ??
              null)
          : null,
      );
    }
    this.options.targetCreated(
      targetId,
      info.openerId === undefined ? undefined : text(info.openerId),
    );
  }
  documentGeneration(targetId: string): number {
    return (
      this.documentGenerations.get(
        this.pageTargets.get(targetId) ?? targetId,
      ) ?? 0
    );
  }
  navigationRecovery(
    targetId: string,
    generation: number,
    url?: string,
  ): Promise<void> | undefined {
    const recovery = this.recoveries.get(targetId);
    return recovery?.request.document_generation === generation &&
      (url !== undefined || recovery.active) &&
      (url === undefined || recovery.url === url)
      ? recovery.completed
      : undefined;
  }
  navigationRecoveryRequest(targetId: string): BrowserOwnedRequest | undefined {
    return this.recoveries.get(targetId)?.request;
  }
  canRetryNavigation(
    targetId: string,
    generation: number,
    url: string,
  ): boolean {
    const navigation = this.navigations.get(targetId);
    return Boolean(
      navigation &&
        navigation.url === url &&
        navigation.identity.request_method === "GET" &&
        navigation.identity.document_generation === generation &&
        !navigation.identity.signal.aborted &&
        navigation.connection_failed &&
        !this.requests.has(navigation.request),
    );
  }
  currentDocument(targetId: string): BrowserDocumentCommit | null {
    const pageTarget = this.pageTargets.get(targetId) ?? targetId;
    const document = this.frameDocuments.get(pageTarget);
    const page = this.options.resolvePage(pageTarget);
    return document && page
      ? {
          ...page,
          document_generation: this.documentGeneration(pageTarget),
          frame_id: pageTarget,
          document_id: document,
          parent_document_id: null,
          is_main: true,
          navigation_request_id: null,
        }
      : null;
  }
  expectHistoryNavigation(targetId: string): void {
    const document = this.currentDocument(targetId);
    if (document) this.historyNavigations.set(targetId, document.document_id);
  }
  async waitForDocumentChange(
    targetId: string,
    generation: number,
  ): Promise<void> {
    if (this.documentGeneration(targetId) !== generation || this.closed) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let waiter!: { target: string; generation: number; resolve: () => void };
    try {
      await new Promise<void>((resolve) => {
        waiter = { target: targetId, generation, resolve };
        this.documentWaiters.add(waiter);
        timer = setTimeout(resolve, 5000);
      });
    } finally {
      clearTimeout(timer);
      this.documentWaiters.delete(waiter);
    }
  }
  private committed(
    frame: Readonly<Record<string, unknown>>,
    targetId: string,
  ): void {
    const frameId = text(frame.id);
    this.frames.set(frameId, targetId);
    const loader = frame.loaderId === undefined ? "" : text(frame.loaderId);
    if (!loader) return;
    const parentFrame =
      frame.parentId === undefined
        ? this.frameParents.get(frameId)
        : text(frame.parentId);
    if (frameId === targetId && parentFrame) {
      const parentTarget = this.frames.get(parentFrame);
      if (parentTarget)
        this.pageTargets.set(
          targetId,
          this.pageTargets.get(parentTarget) ?? parentTarget,
        );
    }
    const pageTarget = this.pageTargets.get(targetId) ?? targetId;
    const main = frameId === pageTarget;
    const errorDocument =
      main &&
      (frame.unreachableUrl !== undefined ||
        frame.url === "chrome-error://chromewebdata/");
    if (main) {
      if (errorDocument) this.errorDocuments.add(pageTarget);
      else this.errorDocuments.delete(pageTarget);
    }
    const previousDocument = this.frameDocuments.get(frameId);
    const historySource = this.historyNavigations.get(pageTarget);
    const historyNavigation =
      main &&
      historySource === previousDocument &&
      loader !== previousDocument &&
      this.documentRoots.get(loader) === loader;
    if (main && loader !== previousDocument)
      this.historyNavigations.delete(pageTarget);
    if (main && this.frameDocuments.get(frameId) !== loader)
      this.documentGenerations.set(
        pageTarget,
        this.documentGeneration(pageTarget) + 1,
      );
    for (const waiter of this.documentWaiters)
      if (
        waiter.target === pageTarget &&
        this.documentGeneration(pageTarget) !== waiter.generation
      )
        waiter.resolve();
    this.frameDocuments.set(frameId, loader);
    const lostContext = this.lostDocumentContexts.get(frameId);
    if (lostContext && lostContext.document !== loader) {
      this.lostDocumentContexts.delete(frameId);
      this.retireDocumentRequests(lostContext);
    }
    if (main) this.frameRoots.set(frameId, loader);
    else {
      const parent =
        frame.parentId === undefined
          ? this.frameParents.get(frameId)
          : text(frame.parentId);
      if (parent) {
        this.frameParents.set(frameId, parent);
        const root =
          this.frameRoots.get(parent) ?? this.frameDocuments.get(parent);
        if (root) this.frameRoots.set(frameId, root);
      }
    }
    const root = this.frameRoots.get(frameId);
    if (root) {
      if (!this.documentRoots.has(loader) && this.documentRoots.size >= 4096)
        throw new BrowserProtocolError();
      this.documentRoots.set(loader, root);
    }
    const navigation = this.navigations.get(frameId);
    const navigationRequest =
      navigation?.document === loader ? navigation.request : null;
    if (navigationRequest && !errorDocument) this.navigations.delete(frameId);
    if (main && navigationRequest && !errorDocument)
      this.committedNetworkFrames.add(frameId);
    const page = this.options.resolvePage(pageTarget);
    if (page)
      this.options.documentCommitted?.({
        ...page,
        document_generation: this.documentGeneration(pageTarget),
        frame_id: frameId,
        document_id: loader,
        parent_document_id: main
          ? null
          : (this.frameRoots.get(frameId) ?? null),
        is_main: main,
        navigation_request_id: navigationRequest,
        ...(historyNavigation ? { is_history_navigation: true as const } : {}),
        ...(errorDocument ? { is_error_document: true as const } : {}),
      });
  }
  private targetForSession(sessionId: string | undefined): string | undefined {
    if (!sessionId) return undefined;
    return [...this.targets.entries()].find(
      ([, value]) => value === sessionId,
    )?.[0];
  }
  private async setup(sessionId: string, worker = false): Promise<void> {
    // Browser-root Fetch already gates the first request. Queue domain enables
    // before resume, but do not await them: a popup's Network.enable response can
    // wait on its first document and must not prevent the resume command.
    await Promise.all([
      this.options.protocol.send("Network.enable", {}, sessionId),
      ...(worker
        ? []
        : [
            this.options.protocol.send("Page.enable", {}, sessionId),
            this.options.protocol.send("Runtime.enable", {}, sessionId),
          ]),
      this.options.protocol.send(
        "Target.setAutoAttach",
        {
          autoAttach: true,
          waitForDebuggerOnStart: true,
          flatten: true,
          filter: [{ type: "iframe" }, { type: "worker" }, { exclude: true }],
        },
        sessionId,
      ),
      this.options.protocol.send(
        "Runtime.runIfWaitingForDebugger",
        {},
        sessionId,
      ),
    ]);
  }
  private rememberFrames(
    tree: Readonly<Record<string, unknown>>,
    targetId: string,
  ): void {
    this.committed(object(tree.frame), targetId);
    if (Array.isArray(tree.childFrames))
      for (const child of tree.childFrames)
        this.rememberFrames(object(child), targetId);
  }
  async ready(targetId: string): Promise<void> {
    await this.setups.get(targetId);
  }
  private async frameOwner(frameId: string): Promise<{
    targetId: string;
    pageTargetId: string;
    page: BrowserPageOwnership;
  } | null> {
    let targetId = this.frames.get(frameId);
    if (!targetId) {
      // A frame-tree query is stable identity evidence; URL/time correlation is not.
      await Promise.all(
        [...this.targets]
          .filter(([id]) => !this.workerTargets.has(id))
          .map(async ([id, sessionId]) => {
            const tree = await this.options.protocol.send(
              "Page.getFrameTree",
              {},
              sessionId,
            );
            this.rememberFrames(object(tree.frameTree), id);
          }),
      );
      targetId = this.frames.get(frameId);
    }
    if (!targetId) return null;
    const pageTargetId = this.pageTargets.get(targetId) ?? targetId;
    const page = this.options.resolvePage(pageTargetId);
    return page ? { targetId, pageTargetId, page } : null;
  }
  private async paused({
    params,
    session_id,
  }: BrowserProtocolEvent): Promise<void> {
    if (session_id !== undefined) throw new BrowserProtocolError();
    const requestId = text(params.requestId);
    if (
      params.responseStatusCode !== undefined ||
      params.responseErrorReason !== undefined
    ) {
      await this.response(requestId, params);
      return;
    }
    const request = object(params.request);
    const url = text(request.url);
    let frameId =
      typeof params.frameId === "string" ? text(params.frameId) : "";
    const resourceType = text(params.resourceType);
    let owner: {
      targetId: string;
      pageTargetId: string;
      page: BrowserPageOwnership;
    } | null = null;
    let identity: BrowserOwnedRequest | undefined;
    let record: RequestRecord | undefined;
    let recovery: NavigationRecovery | undefined;
    try {
      const networkId =
        params.networkId === undefined ? undefined : text(params.networkId);
      const workerEvidence = networkId
        ? [...this.networkDocuments].filter(
            ([key, value]) =>
              key.endsWith(`\n${networkId}`) && value.worker !== null,
          )
        : [];
      const worker =
        workerEvidence.length === 1
          ? this.workers.get(workerEvidence[0]![1].worker!)
          : undefined;
      if (worker) {
        frameId = worker.frame;
        const page = this.options.resolvePage(worker.page);
        owner = page
          ? {
              targetId: workerEvidence[0]![1].worker!,
              pageTargetId: worker.page,
              page,
            }
          : null;
      } else owner = frameId ? await this.frameOwner(frameId) : null;
      if (!owner || owner.page.signal.aborted || this.closed)
        throw new BrowserProtocolError();
      if (this.requests.size >= 2048) throw new BrowserProtocolError();
      let protocolSession = this.targets.get(owner.targetId);
      let evidence =
        networkId && protocolSession
          ? this.networkDocuments.get(`${protocolSession}\n${networkId}`)
          : undefined;
      if (!evidence && networkId) {
        const matches = [...this.networkDocuments].filter(
          ([key, value]) =>
            key.endsWith(`\n${networkId}`) && value.frame === frameId,
        );
        if (matches.length === 1) {
          protocolSession = matches[0]![0].split("\n", 1)[0];
          evidence = matches[0]![1];
        }
      }
      if (!evidence) protocolSession = undefined;
      if (evidence && evidence.frame !== frameId)
        throw new BrowserProtocolError();
      const mainNavigation =
        !worker &&
        resourceType === "Document" &&
        frameId === owner.pageTargetId;
      // Fetch/XHR must identify their exact originating loader. A browser-owned
      // Other request (e.g. an explicit native download) can have an empty loader,
      // so its frame's committed document is the only available document proof.
      const document =
        evidence?.document ??
        (resourceType === "Other"
          ? (this.frameDocuments.get(frameId) ?? null)
          : null);
      if (!mainNavigation && !document) throw new BrowserProtocolError();
      identity = Object.freeze({
        ...owner.page,
        request_id: requestId,
        request_method:
          typeof request.method === "string" ? text(request.method) : "UNKNOWN",
        resource_type: resourceType.toLowerCase(),
        is_navigation: mainNavigation,
        frame_id: frameId,
        document_id: document,
        parent_document_id: worker
          ? worker.frame === worker.page
            ? null
            : worker.root
          : frameId === owner.pageTargetId
            ? null
            : ((document && this.documentRoots.get(document)) ??
              this.frameRoots.get(frameId) ??
              null),
        source_document_id: worker
          ? worker.root
          : this.committedNetworkFrames.has(owner.pageTargetId)
            ? this.errorDocuments.has(owner.pageTargetId)
              ? (this.navigations.get(owner.pageTargetId)?.source ?? null)
              : (this.frameDocuments.get(owner.pageTargetId) ?? null)
            : this.errorDocuments.has(owner.pageTargetId)
              ? (this.navigations.get(owner.pageTargetId)?.source ?? null)
              : (this.targetSources.get(owner.pageTargetId) ??
                this.frameDocuments.get(owner.pageTargetId) ??
                null),
        redirected_request_id:
          params.redirectedRequestId === undefined
            ? (evidence?.redirected_request ?? null)
            : text(params.redirectedRequestId),
      });
      const terminal = deferred();
      record = {
        identity,
        url,
        target_id: owner.targetId,
        frame_id: frameId,
        network_id: networkId,
        // Root Fetch labels JavaScript fetch as XHR in Chromium. Its exact
        // Network type must independently confirm a document-bound consumer.
        document_bound:
          DOCUMENT_RESOURCE_TYPES.has(resourceType) &&
          evidence?.resource_type === resourceType.toLowerCase(),
        document_replaced: false,
        renderer_terminal: false,
        protocol_session: protocolSession,
        admitted: false,
        native_response: false,
        stream_response: false,
        terminal: terminal.completed,
        end: terminal.resolve,
      };
      // A paused request can receive its exact Network terminal while admission
      // awaits another platform. Record it first, but do not make a drain wait
      // for the new request that has not been continued onto the network.
      this.requests.set(requestId, record);
      const admission = await this.options.beforeRequest(
        identity,
        url,
        async () => {
          if (
            !mainNavigation ||
            identity!.request_method !== "GET" ||
            !this.options.retryNavigation ||
            !this.networkLive(identity!.session_id) ||
            this.transferLive(identity!.session_id)
          ) {
            await this.drainSession(identity!.session_id);
            return;
          }
          const previous = this.recoveries.get(owner!.pageTargetId);
          if (
            previous?.request.document_generation ===
            identity!.document_generation
          )
            throw new BrowserProtocolError();
          const completion = deferred();
          const created: NavigationRecovery = {
            request: identity!,
            url,
            completed: completion.completed,
            active: true,
            resolve: () => {
              created.active = false;
              completion.resolve();
            },
            reject: (error) => {
              created.active = false;
              completion.reject(error);
            },
          };
          recovery = created;
          this.recoveries.set(owner!.pageTargetId, recovery);
          // Cancel the provisional navigation before stopping its old renderer.
          // Neither a successful command nor a detached session invents terminal.
          await this.options.protocol.send("Fetch.failRequest", {
            requestId,
            errorReason: "Aborted",
          });
          await this.waitForRequestTerminal(record!);
          // An already admitted response can become a managed PDF writer while
          // the provisional GET's real terminal is still arriving.
          if (!this.transferLive(identity!.session_id))
            await this.stopSession(identity!.session_id);
          await this.drainSession(identity!.session_id);
          return { kind: "retry-navigation" };
        },
      );
      const current = this.options.resolvePage(owner.pageTargetId);
      if (
        !current ||
        current.session_id !== identity.session_id ||
        current.operation_id !== identity.operation_id ||
        current.generation !== identity.generation ||
        current.document_generation !== identity.document_generation ||
        current.signal.aborted ||
        this.closed
      )
        throw new BrowserProtocolError();
      if (admission?.kind === "retry-navigation") {
        if (!recovery || !this.options.retryNavigation)
          throw new BrowserProtocolError();
        await this.options.retryNavigation(identity, url);
        recovery.resolve();
        return;
      }
      if (recovery || !this.requests.has(requestId))
        throw new BrowserProtocolError();
      record.admitted = true;
      if (mainNavigation)
        this.navigations.set(frameId, {
          request: requestId,
          network: networkId,
          session: protocolSession,
          document,
          source: identity.source_document_id,
          identity,
          url,
          connection_failed: false,
        });
      this.options.admitted(identity, url);
      await this.options.protocol.send("Fetch.continueRequest", {
        requestId,
        interceptResponse: true,
      });
    } catch (error) {
      if (recovery) {
        recovery.reject(
          error instanceof Error ? error : new BrowserProtocolError(),
        );
        if (identity) this.options.navigationRetryFailed?.(identity);
      }
      const canceled = record !== undefined && !this.requests.has(requestId);
      if (identity && this.requests.has(requestId)) this.end(requestId);
      this.options.blocked(
        owner?.page ?? null,
        resourceType === "Document" &&
          (!owner || frameId === owner.pageTargetId),
      );
      if (!canceled)
        await this.options.protocol.send("Fetch.failRequest", {
          requestId,
          errorReason: "BlockedByClient",
        });
    }
  }
  private async waitForRequestTerminal(request: RequestRecord): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        request.terminal,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new BrowserProtocolError("timeout")),
            5000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  private async response(
    requestId: string,
    params: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    const request = this.requests.get(requestId);
    if (params.responseErrorReason !== undefined) {
      text(params.responseErrorReason);
      if (
        request &&
        params.networkId !== undefined &&
        text(params.networkId) !== request.network_id
      )
        throw new BrowserProtocolError();
      const navigation = request
        ? this.navigations.get(request.frame_id)
        : undefined;
      if (
        request?.admitted &&
        navigation?.request === requestId &&
        [
          "ConnectionClosed",
          "ConnectionReset",
          "ConnectionRefused",
          "NameNotResolved",
          "TimedOut",
        ].includes(text(params.responseErrorReason))
      )
        navigation.connection_failed = true;
      if (request) request.renderer_terminal = true;
      try {
        // Forward the original failed response so a still-paused consumer can
        // observe its error. Chromium may already have retired this exact Fetch
        // interception when navigation canceled the originating document.
        await this.options.protocol.send("Fetch.continueResponse", {
          requestId,
        });
      } catch (error) {
        if (
          !(error instanceof BrowserProtocolError) ||
          error.reason !== "request-inactive"
        )
          throw error;
      } finally {
        // The exact failed response ends its request, even when response headers
        // suggested a native download that never began. A confirmed native/IO
        // writer retains its independent terminal; late GUID attribution survives
        // in nativeResponses without inventing a live writer.
        if (
          request &&
          !this.nativeWriterLive(requestId) &&
          !request.stream_response &&
          !request.response_cancel
        )
          this.end(requestId);
      }
      return;
    }
    if (!request) {
      await this.options.protocol.send("Fetch.failRequest", {
        requestId,
        errorReason: "BlockedByClient",
      });
      return;
    }
    const headers = new Map<string, string>();
    if (Array.isArray(params.responseHeaders))
      for (const item of params.responseHeaders) {
        const header = object(item);
        headers.set(text(header.name).toLowerCase(), text(header.value));
      }
    const mime = headers
      .get("content-type")
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase();
    const status = params.responseStatusCode;
    const programmatic = ["fetch", "xhr"].includes(
      request.identity.resource_type,
    );
    const attachment =
      headers
        .get("content-disposition")
        ?.split(";", 1)[0]
        ?.trim()
        .toLowerCase() === "attachment";
    // Inline Fetch/XHR bytes belong to the renderer: they may be an unrelated
    // background preview, even in the main frame or after a real click. Let the
    // page render them and the operator choose its download control. A later
    // blob/native download has its own capture; explicit attachment responses
    // can be handed off directly without buffering or replaying their request.
    const pdfDownload =
      mime === "application/pdf" && (!programmatic || attachment);
    if (pdfDownload && status === 206) {
      this.options.rejectedResponse?.(request.identity, "browser-partial-pdf");
      await this.options.protocol.send("Fetch.failRequest", {
        requestId,
        errorReason: "BlockedByClient",
      });
      this.end(requestId);
      return;
    }
    if (status === 429 && (request.identity.is_navigation || pdfDownload))
      this.options.rateLimited?.(
        request.identity,
        headers.get("retry-after") ?? null,
      );
    // Content-Disposition does not create a Browser native download for fetch
    // or XHR. Those original responses must remain on the IO-stream path.
    request.native_response =
      ["document", "other"].includes(request.identity.resource_type) &&
      status === 200 &&
      (pdfDownload || attachment);
    if (request.native_response) this.nativeResponses.set(requestId, request);
    if (
      programmatic &&
      pdfDownload &&
      status === 200 &&
      this.options.pdfResponse
    ) {
      request.stream_response = true;
      const length = headers.get("content-length");
      const contentLength =
        length && /^\d+$/u.test(length) && Number.isSafeInteger(Number(length))
          ? Number(length)
          : null;
      const response = this.responseStream(
        requestId,
        request,
        status,
        contentLength,
      );
      try {
        await this.options.pdfResponse(request.identity, request.url, response);
      } finally {
        await response.cancel();
      }
      return;
    }
    if (
      request.document_replaced &&
      !request.native_response &&
      !request.stream_response &&
      !pdfDownload &&
      typeof status === "number" &&
      !(status >= 300 && status < 400)
    ) {
      // The original response is still paused, but its exact document consumer
      // has gone. Root Fetch survives that renderer and can prove body EOF when
      // its old Network session no longer reports a terminal. Never take a live
      // document's response or replay a request to obtain this evidence.
      const response = this.responseStream(requestId, request, status, null);
      try {
        for await (const bytes of response.chunks(request.identity.signal))
          void bytes;
      } finally {
        await response.cancel();
      }
      return;
    }
    await this.options.protocol.send("Fetch.continueResponse", { requestId });
    if (typeof status === "number" && status >= 300 && status < 400)
      this.end(requestId, true);
  }
  private responseStream(
    requestId: string,
    request: RequestRecord,
    status: number,
    contentLength: number | null,
  ): BrowserPdfResponse {
    const protocol = this.options.protocol;
    const reading = new AbortController();
    let stream: string | undefined;
    let opening: Promise<void> | undefined;
    let cancellation: Promise<void> | undefined;
    let eof = false;
    const cancel = () => {
      cancellation ??= (async () => {
        // A concurrent close must bind and close the handle returned by an
        // already dispatched take, before canceling that exact interception.
        const errors: unknown[] = [];
        try {
          await opening;
        } catch (error) {
          errors.push(error);
        }
        let streamClosed = stream === undefined;
        try {
          if (stream) await protocol.send("IO.close", { handle: stream });
          streamClosed = true;
        } catch (error) {
          errors.push(error);
        }
        let requestCancelled = false;
        try {
          await protocol.send("Fetch.failRequest", {
            requestId,
            errorReason: "Aborted",
          });
          requestCancelled = true;
        } catch (error) {
          if (
            error instanceof BrowserProtocolError &&
            error.reason === "request-inactive" &&
            (eof || request.renderer_terminal || !this.requests.has(requestId))
          )
            requestCancelled = true;
          else errors.push(error);
        }
        if (streamClosed && requestCancelled) {
          this.end(requestId);
          reading.abort();
        }
        if (errors.length)
          throw errors.length === 1
            ? errors[0]
            : new AggregateError(
                errors,
                "Original Browser response cleanup failed",
              );
      })();
      return cancellation;
    };
    request.response_cancel = cancel;
    const failure = () => {
      if (!this.closed) this.options.failure();
    };
    const chunks = async function* (
      signal: AbortSignal,
    ): AsyncIterable<Uint8Array> {
      if (signal.aborted || request.identity.signal.aborted || cancellation)
        throw new BrowserProtocolError();
      const abort = () => {
        void cancel().catch(failure);
      };
      signal.addEventListener("abort", abort, { once: true });
      request.identity.signal.addEventListener("abort", abort, { once: true });
      try {
        opening = protocol
          .send("Fetch.takeResponseBodyAsStream", { requestId })
          .then((result) => {
            stream = text(result.stream);
          });
        await opening;
        for (;;) {
          if (cancellation) {
            await cancellation;
            if (!request.stream_response) return;
            throw new BrowserProtocolError();
          }
          if (signal.aborted || request.identity.signal.aborted)
            throw new BrowserProtocolError();
          let chunk: Record<string, unknown>;
          try {
            chunk = await protocol.send(
              "IO.read",
              { handle: stream, size: 65536 },
              undefined,
              120000,
              reading.signal,
            );
          } catch (error) {
            if (
              cancellation &&
              error instanceof BrowserProtocolError &&
              error.reason === "command-cancelled"
            ) {
              await cancellation;
              if (!request.stream_response) return;
            }
            throw error;
          }
          if (typeof chunk.data !== "string" || chunk.data.length > 131072)
            throw new BrowserProtocolError();
          const bytes = Buffer.from(
            chunk.data,
            chunk.base64Encoded === true ? "base64" : "utf8",
          );
          if (bytes.byteLength) yield bytes;
          if (chunk.eof === true) {
            eof = true;
            await cancel();
            return;
          }
        }
      } finally {
        signal.removeEventListener("abort", abort);
        request.identity.signal.removeEventListener("abort", abort);
      }
    };
    return { status, content_length: contentLength, chunks, cancel };
  }
  private end(requestId: string, preserveNetwork = false): void {
    const request = this.requests.get(requestId);
    if (!request) return;
    this.requests.delete(requestId);
    request.end();
    if (!preserveNetwork && request.network_id && request.protocol_session)
      this.networkDocuments.delete(
        `${request.protocol_session}\n${request.network_id}`,
      );
    this.options.ended?.(request.identity);
    this.finishDrains();
  }
  private nativeWriterLive(requestId: string): boolean {
    return [...this.natives.values()].some(
      (record) => record.request_id === requestId && !record.terminal,
    );
  }
  private documentContextLost(key: string, context: DocumentContext): void {
    this.documentContexts.delete(key);
    if (
      [...this.documentContexts.values()].some(
        (remaining) =>
          remaining.frame === context.frame &&
          remaining.document === context.document,
      )
    )
      return;
    const current = this.frameDocuments.get(context.frame);
    if (current === context.document) {
      // One pending loss per live frame; a different-loader commit consumes it.
      if (
        !this.lostDocumentContexts.has(context.frame) &&
        this.lostDocumentContexts.size >= 4096
      )
        throw new BrowserProtocolError();
      this.lostDocumentContexts.set(context.frame, context);
    } else if (current) this.retireDocumentRequests(context);
  }
  private retireDocumentRequests(context: DocumentContext): void {
    // Chromium can cancel replaced document consumers without emitting
    // Network.loadingFailed on the surviving Page session. Default-context
    // loss plus an exact different-loader commit proves those consumers ended.
    // Keepalive-capable Fetch/Other and managed PDF writers have independent
    // lifetimes and still require their original Network/download/IO terminal.
    for (const [id, request] of this.requests)
      if (
        request.frame_id === context.frame &&
        request.identity.document_id === context.document &&
        request.target_id === context.target &&
        request.protocol_session === context.session &&
        !request.identity.is_navigation
      ) {
        request.document_replaced = true;
        if (
          request.document_bound &&
          !request.native_response &&
          !request.stream_response
        )
          this.end(id);
      }
  }
  private forgetDocumentContexts(
    matches: (context: DocumentContext) => boolean,
  ): void {
    for (const [key, context] of this.documentContexts)
      if (matches(context)) this.documentContexts.delete(key);
    for (const [frame, context] of this.lostDocumentContexts)
      if (matches(context)) this.lostDocumentContexts.delete(frame);
  }
  private finished({ params, session_id }: BrowserProtocolEvent): void {
    const networkId = text(params.requestId);
    const target = this.targetForSession(session_id);
    const worker = target ? this.workers.get(target) : undefined;
    const frame =
      this.networkDocuments.get(`${session_id}\n${networkId}`)?.frame ??
      (target ? (this.workers.get(target)?.frame ?? target) : undefined);
    for (const [id, request] of this.requests)
      if (
        request.network_id === networkId &&
        (request.protocol_session === session_id ||
          (request.frame_id === frame &&
            (!worker ||
              request.target_id === target ||
              request.target_id === worker.parent ||
              // Chromium reports a nested worker's startup response on an
              // ancestor Page session, using the worker target token as its
              // Network request ID. Join that exact transferred identity.
              (networkId === target &&
                request.target_id === worker.page &&
                request.identity.document_id === worker.document))))
      ) {
        request.renderer_terminal = true;
        const navigation = this.navigations.get(request.frame_id);
        if (
          request.admitted &&
          navigation?.request === id &&
          typeof params.errorText === "string" &&
          /net::ERR_(?:NAME_NOT_RESOLVED|DNS_TIMED_OUT|CONNECTION_RESET|CONNECTION_CLOSED|CONNECTION_REFUSED|TIMED_OUT|NETWORK_CHANGED|EMPTY_RESPONSE)\b/u.test(
            params.errorText,
          )
        )
          navigation.connection_failed = true;
        if (
          !request.native_response &&
          !request.stream_response &&
          !request.response_cancel
        )
          this.end(id);
      }
    if (
      ![...this.requests.values()].some(
        (request) =>
          request.protocol_session === session_id &&
          request.network_id === networkId,
      )
    )
      this.networkDocuments.delete(`${session_id}\n${networkId}`);
  }
  private download(params: Readonly<Record<string, unknown>>): void {
    const guid = text(params.guid);
    if (!/^[a-f0-9-]{36}$/u.test(guid)) throw new BrowserProtocolError();
    const frameId = text(params.frameId);
    const url = text(params.url);
    const targetId = this.frames.get(frameId);
    const currentPage = targetId
      ? this.options.resolvePage(this.pageTargets.get(targetId) ?? targetId)
      : null;
    // frame/opener establishes ownership. Only a unique native Response within
    // that exact owner/frame may associate the GUID with a live request; URL
    // never establishes or changes article ownership.
    const responses = [...this.nativeResponses.entries()].filter(
      ([, request]) =>
        request.native_response &&
        request.frame_id === frameId &&
        (!currentPage ||
          (request.identity.session_id === currentPage.session_id &&
            request.identity.generation === currentPage.generation)) &&
        request.url === url,
    );
    const binding = responses.length === 1 ? responses[0] : undefined;
    const local = url.startsWith("blob:") || url.startsWith("data:");
    // Frame ownership retains even an unusable writer for cancellation/drain.
    // Only a unique response binding (or a local download) can publish bytes.
    const page = binding?.[1].identity ?? currentPage;
    if (this.natives.has(guid)) return;
    if (binding) this.nativeResponses.delete(binding[0]);
    const deferredNative = deferred();
    const retirement = deferred();
    const record: NativeRecord = {
      page,
      ...deferredNative,
      retired: retirement.completed,
      retireDone: retirement.resolve,
      request_id: binding?.[0] ?? null,
      bytes: 0,
      terminal: false,
      retirement_pending: false,
    };
    this.natives.set(guid, record);
    const cancel = () => this.cancelNative(guid, record);
    if (
      !page ||
      (!binding && !local) ||
      page.signal.aborted ||
      !this.options.nativeDownload ||
      this.options.allowNative?.(page) === false
    ) {
      record.retirement_pending = true;
      this.track(cancel().then(() => this.retireNative(guid)));
      return;
    }
    const directory = this.options.downloads_directory;
    const chunks = async function* (
      signal: AbortSignal,
    ): AsyncIterable<Uint8Array> {
      await record.completed;
      if (signal.aborted || page.signal.aborted)
        throw new BrowserProtocolError();
      const file = await open(
        join(directory, guid),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      try {
        const metadata = await file.stat();
        if (
          !metadata.isFile() ||
          metadata.nlink !== 1 ||
          metadata.uid !== process.getuid?.() ||
          metadata.size !== record.bytes
        )
          throw new BrowserProtocolError();
        for await (const chunk of file.createReadStream({
          autoClose: false,
          highWaterMark: 65536,
        })) {
          if (signal.aborted || page.signal.aborted)
            throw new BrowserProtocolError();
          yield new Uint8Array(chunk);
        }
      } finally {
        await file.close();
      }
    };
    this.options.nativeDownload({
      guid,
      page,
      url,
      completed: record.completed,
      retired: record.retired,
      chunks,
      cancel,
    });
  }
  private progress(params: Readonly<Record<string, unknown>>): void {
    const guid = text(params.guid);
    const record = this.natives.get(guid);
    if (!record || record.terminal) return;
    if (
      typeof params.receivedBytes !== "number" ||
      !Number.isSafeInteger(params.receivedBytes) ||
      params.receivedBytes < 0
    )
      throw new BrowserProtocolError();
    record.bytes = Math.max(record.bytes, params.receivedBytes);
    const state = params.state;
    if (state !== "inProgress" && state !== "completed" && state !== "canceled")
      throw new BrowserProtocolError();
    const total = params.totalBytes;
    this.options.nativeProgress?.({
      guid,
      received_bytes: record.bytes,
      total_bytes:
        typeof total === "number" && Number.isSafeInteger(total) && total > 0
          ? total
          : null,
      state,
    });
    if (state !== "inProgress") {
      record.terminal = true;
      if (record.request_id) this.end(record.request_id);
      if (state === "completed") record.resolve();
      else record.reject(new BrowserProtocolError());
      this.finishDrains();
      if (record.retirement_pending) this.track(this.retireNative(guid));
    }
  }
  async retireNative(guid: string): Promise<void> {
    const record = this.natives.get(guid);
    if (!record) return;
    if (!record.terminal) {
      record.retirement_pending = true;
      throw new BrowserProtocolError();
    }
    await rm(join(this.options.downloads_directory, guid), { force: true });
    await rm(join(this.options.downloads_directory, `${guid}.crdownload`), {
      force: true,
    });
    this.natives.delete(guid);
    record.retireDone();
  }
  async stopSession(sessionId: string, stopPageLoading = true): Promise<void> {
    const cancellations: Promise<unknown>[] = [];
    for (const request of this.requests.values())
      if (
        request.identity.session_id === sessionId &&
        !request.stream_response &&
        request.response_cancel
      )
        cancellations.push(request.response_cancel());
    for (const [targetId, protocolSession] of this.targets)
      if (
        this.options.resolvePage(this.pageTargets.get(targetId) ?? targetId)
          ?.session_id === sessionId
      ) {
        if (this.workers.has(targetId)) {
          cancellations.push(this.stopWorker(targetId, protocolSession));
          continue;
        }
        // Page.stopLoading is a WebContents command. Its top-level target stops
        // child-frame loading too; OOPIF targets reject the command themselves.
        if ((this.pageTargets.get(targetId) ?? targetId) !== targetId) continue;
        // Full close has already dispatched real page closure; a second stop
        // can stall an error document's close and provides no extra proof.
        if (!stopPageLoading) continue;
        cancellations.push(
          this.options.protocol
            .send("Page.stopLoading", {}, protocolSession)
            .catch((error: unknown) => {
              if (
                !(error instanceof BrowserProtocolError) ||
                error.reason !== "target-inactive" ||
                [...this.requests.values()].some(
                  (request) =>
                    request.target_id === targetId ||
                    request.protocol_session === protocolSession,
                )
              )
                throw error;
              // There is no outstanding response in this inactive session. Do
              // not manufacture terminals for detached or swapped renderers.
              if (this.targets.get(targetId) === protocolSession)
                this.targets.delete(targetId);
            }),
        );
      }
    for (const [guid, native] of this.natives)
      if (native.page?.session_id === sessionId && !native.terminal)
        cancellations.push(this.cancelNative(guid, native));
    await Promise.all(cancellations);
  }
  private async stopWorker(
    targetId: string,
    protocolSession: string,
  ): Promise<void> {
    if (this.destroyedTargets.has(targetId)) return;
    let resolve!: () => void;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stopped = new Promise<void>((done, reject) => {
      resolve = done;
      const waiters = this.targetWaiters.get(targetId) ?? new Set();
      waiters.add(done);
      this.targetWaiters.set(targetId, waiters);
      timer = setTimeout(
        () => reject(new BrowserProtocolError("timeout")),
        5000,
      );
    });
    // Register before evaluating: self.close can destroy the worker before the
    // command response arrives. Session detach alone is not shutdown evidence.
    void stopped.catch(() => undefined);
    try {
      try {
        await this.options.protocol.send(
          "Runtime.evaluate",
          { expression: "self.close()", returnByValue: true },
          protocolSession,
        );
      } catch (error) {
        await stopped;
        if (!this.destroyedTargets.has(targetId)) throw error;
      }
      await stopped;
    } finally {
      clearTimeout(timer);
      const waiters = this.targetWaiters.get(targetId);
      waiters?.delete(resolve);
      if (!waiters?.size) {
        this.targetWaiters.delete(targetId);
        this.destroyedTargets.delete(targetId);
      }
    }
  }
  private cancelNative(guid: string, record: NativeRecord): Promise<void> {
    if (record.terminal) return Promise.resolve();
    if (record.cancellation) return record.cancellation;
    record.cancellation = this.cancelNativeWriter(guid, record);
    return record.cancellation;
  }
  private async cancelNativeWriter(
    guid: string,
    record: NativeRecord,
  ): Promise<void> {
    if (record.terminal) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await this.options.protocol.send(
        "Browser.cancelDownload",
        { guid },
        undefined,
        5000,
      );
      await Promise.race([
        record.completed.catch(() => undefined),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new BrowserProtocolError()), 5000);
        }),
      ]);
      if (!record.terminal) throw new BrowserProtocolError();
    } catch {
      record.reject(new BrowserProtocolError());
      record.retirement_pending = true;
      throw new BrowserProtocolError();
    } finally {
      clearTimeout(timer);
    }
  }
  drainSession(sessionId: string): Promise<void> {
    if (!this.networkLive(sessionId)) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const drain = {
        session: sessionId,
        finish: () => {
          clearTimeout(timer);
          this.drains.delete(drain);
          resolve();
        },
      };
      const timer = setTimeout(() => {
        this.drains.delete(drain);
        const error = new Error(
          "Browser platform handoff has live network activity",
        ) as Error & { code: string };
        error.code = "browser-platform-handoff-stalled";
        reject(error);
      }, 120000);
      this.drains.add(drain);
      this.finishDrains();
    });
  }
  /** Called only after the session's pages have closed and its real writers drained. */
  sessionClosed(sessionId: string): void {
    if (this.networkLive(sessionId)) throw new BrowserProtocolError();
    for (const [id, response] of this.nativeResponses)
      if (response.identity.session_id === sessionId)
        this.nativeResponses.delete(id);
  }
  private networkLive(sessionId: string): boolean {
    return (
      [...this.requests.values()].some(
        (request) =>
          request.admitted && request.identity.session_id === sessionId,
      ) ||
      [...this.natives.values()].some(
        (native) => native.page?.session_id === sessionId && !native.terminal,
      )
    );
  }
  private transferLive(sessionId: string): boolean {
    return (
      [...this.requests.values()].some(
        (request) =>
          request.identity.session_id === sessionId &&
          (request.native_response || request.stream_response),
      ) ||
      [...this.natives.values()].some(
        (native) => native.page?.session_id === sessionId && !native.terminal,
      )
    );
  }
  private finishDrains(): void {
    for (const drain of this.drains)
      if (!this.networkLive(drain.session)) drain.finish();
  }
  dispose(): void {
    this.closed = true;
    this.documentContexts.clear();
    this.lostDocumentContexts.clear();
    this.nativeResponses.clear();
    for (const recovery of this.recoveries.values())
      recovery.reject(new BrowserProtocolError("closed"));
    this.recoveries.clear();
    for (const waiter of this.documentWaiters) waiter.resolve();
    for (const [target, waiters] of this.targetWaiters) {
      this.destroyedTargets.add(target);
      for (const resolve of waiters) resolve();
    }
    for (const remove of this.listeners.splice(0)) remove();
    for (const native of this.natives.values()) {
      native.terminal = true;
      native.reject(new BrowserProtocolError());
    }
    for (const id of this.requests.keys()) this.end(id);
    this.finishDrains();
  }
  /** Context close has stopped writers; call after all managed readers settle. */
  async retireClosedDownloads(): Promise<void> {
    if (!this.closed) throw new BrowserProtocolError();
    await Promise.all(
      [...this.natives.keys()].map((guid) => this.retireNative(guid)),
    );
  }
}
