import { parseAcquisitionAttempts } from "@sciretriever/contracts";
import { randomUUID } from "node:crypto";
import { createLogger } from "../logging/index.js";
import {
  browserRefused,
  type BrowserDeliveryRequest,
  type BrowserDeliveryResult,
} from "../browser/boundary.js";
import type {
  BrowserArticleExecution,
  BrowserArticleCloseOutcome,
  BrowserArticleSessionIdentity,
} from "../browser/article-session.js";
import type {
  BrowserDocumentCommit,
  BrowserOwnedRequest,
  BrowserRequestAdmission,
} from "../browser/cdp-owner.js";
import { BrowserArticleOpenError } from "../browser/article-flow.js";
import {
  browserPlatform,
  BrowserPlatformScheduler,
  BrowserPlatformQuarantinedError,
  type BrowserAccessPolicy,
  type BrowserAccessEnd,
  type BrowserPlatformLease,
} from "../network/browser-platform.js";

interface Ticket {
  readonly request: BrowserDeliveryRequest;
  readonly open: (
    request: BrowserDeliveryRequest,
  ) => Promise<BrowserArticleExecution>;
  readonly controller: AbortController;
  readonly resolve: (result: BrowserDeliveryResult) => void;
  readonly cancel: () => void;
  readonly detach: () => void;
  readonly initialPlatform: string;
  execution?: BrowserArticleExecution;
  platform?: BrowserPlatformLease;
  lastPlatform: string;
  startDispatched: boolean;
  busy: boolean;
  watching: boolean;
  delivered: boolean;
  done: boolean;
  terminalResult?: BrowserDeliveryResult;
  cleanupFailed: boolean;
  cleanupCode?: string;
  closing?: Promise<void>;
  lifetime?: ReturnType<typeof setTimeout>;
  expiresAt?: number;
  access?: Promise<BrowserRequestAdmission>;
  networkEpoch: number;
  navigationStarted: boolean;
  readonly documents: Map<
    string,
    {
      readonly document: string;
      readonly generation: number;
      readonly platform: string;
    }
  >;
  readonly documentGrants: Set<string>;
  readonly resumableDocuments: Set<string>;
  readonly documentHistory: Map<
    string,
    { readonly page: string; readonly platform: string }
  >;
  readonly navigations: Map<
    string,
    {
      readonly request: string;
      readonly document: string | null;
      readonly epoch: number;
      readonly platform: string;
      readonly source: string | null;
      readonly url: string;
      ended: boolean;
      readonly retry_required?: true;
    }
  >;
  detachExecution?: () => void;
}

/** Session capacity, independent decision slots and platform leases share one owner. */
export class BrowserArticleScheduler {
  private readonly sessions = new Map<string, Ticket>();
  private readonly queue: Ticket[] = [];
  private readonly ready: Ticket[] = [];
  private readonly latest = new Map<string, number>();
  private readonly platforms: BrowserPlatformScheduler;
  private readonly logger = createLogger("browser-scheduler");
  private activeWorkers = 0;
  private readonly tasks = new Set<Promise<void>>();
  private closed = false;
  private runtimeFailed = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private pumpQueued = false;

  constructor(
    private readonly options: {
      readonly sessions: number;
      readonly workers: number;
      readonly policy?: Partial<BrowserAccessPolicy>;
      readonly platform_cooldown_ms?: number;
      readonly lifetime_ms?: number;
      readonly onQueued?: (
        identity: BrowserArticleSessionIdentity,
        cancel: () => void,
      ) => void;
      readonly onRemoved?: (
        sessionId: string,
        outcome: BrowserArticleCloseOutcome,
      ) => void;
    },
  ) {
    if (
      !Number.isSafeInteger(options.sessions) ||
      options.sessions < 1 ||
      options.sessions > 8 ||
      !Number.isSafeInteger(options.workers) ||
      options.workers < 1 ||
      options.workers > options.sessions
    )
      throw new TypeError("invalid Browser scheduler capacity");
    this.platforms = new BrowserPlatformScheduler({
      ...(options.policy ? { policy: options.policy } : {}),
      ...(options.platform_cooldown_ms !== undefined
        ? { cooldown_ms: options.platform_cooldown_ms }
        : {}),
      changed: () => this.schedulePump(),
    });
  }

  deliver(
    request: BrowserDeliveryRequest,
    open: Ticket["open"],
  ): Promise<BrowserDeliveryResult> {
    if (this.closed || request.signal.aborted)
      return Promise.resolve(
        browserRefused(
          "browser-flow-cancelled",
          "Browser acquisition was cancelled.",
        ),
      );
    if (this.runtimeFailed)
      return Promise.resolve(
        browserRefused(
          "browser-runtime-lost",
          "The shared Browser runtime disconnected.",
        ),
      );
    const operation = request.operation_id ?? "direct";
    const generation = request.generation ?? 0;
    if (generation < (this.latest.get(operation) ?? generation))
      return Promise.resolve(
        browserRefused(
          "browser-stale-generation",
          "The Browser operation generation is obsolete.",
        ),
      );
    this.latest.set(operation, generation);
    for (const active of this.sessions.values()) {
      const identity = active.request.session_identity!;
      if (
        !active.delivered &&
        identity.operation_id === operation &&
        identity.generation < generation
      )
        active.cancel();
    }
    const controller = new AbortController();
    const identity = Object.freeze({
      session_id: `browser-${randomUUID()}`,
      operation_id: operation,
      generation,
      literature_id: request.literature_id,
      metadata_snapshot: Object.freeze({ ...request.metadata_snapshot }),
      ...(request.prior_attempts
        ? {
            prior_attempts: parseAcquisitionAttempts(
              request.prior_attempts,
              16,
            ),
          }
        : {}),
    });
    const bound = {
      ...request,
      signal: controller.signal,
      session_identity: identity,
    };
    return new Promise((resolve) => {
      const ticket: Ticket = {
        request: bound,
        open,
        controller,
        resolve,
        initialPlatform: browserPlatform(request.start_url) ?? "unknown",
        lastPlatform: browserPlatform(request.start_url) ?? "unknown",
        startDispatched: false,
        networkEpoch: 0,
        navigationStarted: false,
        documents: new Map(),
        documentGrants: new Set(),
        resumableDocuments: new Set(),
        documentHistory: new Map(),
        navigations: new Map(),
        detach: () =>
          request.signal.removeEventListener("abort", ticket.cancel),
        busy: false,
        watching: false,
        delivered: false,
        done: false,
        cleanupFailed: false,
        cancel: () => {
          if (ticket.done) return;
          controller.abort();
          void this.finish(
            ticket,
            browserRefused(
              "browser-flow-cancelled",
              "Browser acquisition was cancelled.",
            ),
          );
        },
      };
      request.signal.addEventListener("abort", ticket.cancel, { once: true });
      this.queue.push(ticket);
      try {
        this.options.onQueued?.(identity, ticket.cancel);
      } catch {
        void this.finish(
          ticket,
          browserRefused(
            "browser-projection-failed",
            "The Browser article could not be registered for collaboration.",
          ),
        );
        return;
      }
      this.schedulePump();
    });
  }

  /** Called before page creation by FlowOptions.onSession. */
  attach(execution: BrowserArticleExecution, signal?: AbortSignal): void {
    const ticket = this.sessions.get(execution.session_id);
    if (!ticket || ticket.done || ticket.execution)
      throw new Error("Browser execution is not owned by this scheduler");
    ticket.execution = execution;
    if (signal) {
      signal.addEventListener("abort", ticket.cancel, { once: true });
      ticket.detachExecution = () =>
        signal.removeEventListener("abort", ticket.cancel);
      if (signal.aborted) ticket.cancel();
    }
  }

  /** The Host calls this before every admitted request, including first redirect hops. */
  async beforeRequest(
    binding: BrowserOwnedRequest,
    url: string,
    drainPrevious: () => Promise<BrowserRequestAdmission>,
  ): Promise<BrowserRequestAdmission> {
    const sessionId = binding.session_id;
    const ticket = this.sessions.get(sessionId);
    if (
      !ticket ||
      ticket.done ||
      ticket.controller.signal.aborted ||
      ticket.delivered
    )
      throw new Error("browser-session-network-inactive");
    const identity = ticket.request.session_identity!;
    if (
      binding.operation_id !== identity.operation_id ||
      binding.generation !== identity.generation ||
      binding.signal.aborted
    )
      throw new Error("browser-session-network-inactive");
    const receivedEpoch = ticket.networkEpoch;
    const currentDocument = () => {
      const root = binding.parent_document_id ?? binding.document_id;
      const fact = ticket.documents.get(binding.page_id);
      return Boolean(
        root &&
          (ticket.documentGrants.has(root) ||
            ticket.resumableDocuments.has(root)) &&
          fact?.document === root &&
          fact.platform === ticket.platform?.platform,
      );
    };
    const sourceGranted = () => {
      const source = binding.source_document_id;
      return Boolean(
        source &&
          [...ticket.documents.values()].some(
            (fact) =>
              fact.document === source &&
              (ticket.documentGrants.has(source) ||
                ticket.resumableDocuments.has(source)) &&
              fact.platform === ticket.platform?.platform,
          ),
      );
    };
    const navigationAllowed = () => {
      const pending = ticket.navigations.get(binding.page_id);
      const preparation =
        binding.request_method === "GET" &&
        binding.parent_document_id === null &&
        ticket.execution?.clock.snapshot().model_calls === 0 &&
        ticket.execution.preparationTarget?.() === url &&
        ticket.request.start_urls?.includes(url) === true;
      return (
        !ticket.navigationStarted ||
        sourceGranted() ||
        preparation ||
        Boolean(
          binding.document_id &&
            pending?.document === binding.document_id &&
            pending.epoch === ticket.networkEpoch,
        ) ||
        Boolean(
          pending?.ended &&
            (!pending.retry_required || binding.request_method === "GET") &&
            pending.url === url &&
            pending.source === binding.source_document_id &&
            pending.epoch === ticket.networkEpoch,
        ) ||
        Boolean(
          binding.redirected_request_id &&
            pending?.request === binding.redirected_request_id &&
            pending.epoch === ticket.networkEpoch,
        )
      );
    };
    const admit = async (): Promise<BrowserRequestAdmission> => {
      if (
        ticket.done ||
        ticket.delivered ||
        ticket.controller.signal.aborted ||
        binding.signal.aborted ||
        receivedEpoch !== ticket.networkEpoch
      )
        throw new Error("browser-session-network-inactive");
      if (
        binding.is_navigation
          ? !navigationAllowed()
          : !ticket.platform || !binding.document_id || !currentDocument()
      )
        throw new Error("browser-document-network-inactive");
      const evidence = binding.is_navigation ? browserPlatform(url) : null;
      const pending = ticket.navigations.get(binding.page_id);
      const retry =
        binding.is_navigation &&
        pending?.ended &&
        pending.url === url &&
        pending.source === binding.source_document_id &&
        binding.redirected_request_id === null;
      const group =
        evidence ?? ticket.platform?.platform ?? ticket.initialPlatform;
      const resume =
        !ticket.platform ||
        group !== ticket.platform.platform ||
        !ticket.startDispatched
          ? ticket.execution?.clock.exclude()
          : undefined;
      try {
        if (ticket.platform && (group !== ticket.platform.platform || retry)) {
          ticket.networkEpoch++;
          ticket.documentGrants.clear();
          ticket.resumableDocuments.clear();
          ticket.navigations.clear();
          const handoffEpoch = ticket.networkEpoch;
          const drained = await drainPrevious();
          if (
            drained?.kind === "retry-navigation" &&
            !ticket.done &&
            !ticket.controller.signal.aborted &&
            ticket.execution &&
            ["downloading", "validating", "candidate-ready"].includes(
              ticket.execution.phase(),
            )
          ) {
            const source = binding.source_document_id;
            const history = source
              ? ticket.documentHistory.get(source)
              : undefined;
            const fact = ticket.documents.get(binding.page_id);
            if (
              source &&
              history?.page === binding.page_id &&
              history.platform === ticket.lastPlatform &&
              fact?.document === source &&
              fact.platform === history.platform
            )
              ticket.resumableDocuments.add(source);
            throw new Error("browser-navigation-superseded-by-transfer");
          }
          if (
            handoffEpoch !== ticket.networkEpoch ||
            ticket.done ||
            ticket.controller.signal.aborted
          )
            throw new Error("browser-session-network-inactive");
          ticket.platform.release({ kind: retry ? "failure" : "completed" });
          delete ticket.platform;
          ticket.startDispatched = false;
          if (drained?.kind === "retry-navigation") {
            ticket.navigations.set(binding.page_id, {
              request: binding.request_id,
              document: binding.document_id,
              epoch: ticket.networkEpoch,
              platform: group,
              source: binding.source_document_id,
              url,
              ended: true,
              retry_required: true,
            });
            return drained;
          }
        }
        const admitEpoch = ticket.networkEpoch;
        const previousLease = ticket.platform;
        const lease =
          previousLease ??
          (await this.platforms.acquire(
            sessionId,
            group,
            ticket.controller.signal,
          ));
        if (
          admitEpoch !== ticket.networkEpoch ||
          ticket.done ||
          ticket.controller.signal.aborted
        ) {
          if (!previousLease) lease.release({ kind: "cancelled" });
          throw new Error("browser-session-network-inactive");
        }
        ticket.platform = lease;
        ticket.lastPlatform = group;
        // DOI resolution is shared transit, not an article start for a publisher.
        if (browserPlatform(url) !== null || group !== "unknown") {
          await ticket.platform.start();
          ticket.startDispatched = true;
        }
        if (
          admitEpoch !== ticket.networkEpoch ||
          ticket.done ||
          ticket.controller.signal.aborted
        )
          throw new Error("browser-session-network-inactive");
        if (binding.is_navigation) {
          ticket.navigationStarted = true;
          ticket.navigations.set(binding.page_id, {
            request: binding.request_id,
            document: binding.document_id,
            epoch: ticket.networkEpoch,
            platform: group,
            source: binding.source_document_id,
            url,
            ended: false,
          });
        } else {
          const root = binding.parent_document_id ?? binding.document_id;
          if (!currentDocument())
            throw new Error("browser-document-network-inactive");
          ticket.documentGrants.add(root!);
        }
      } finally {
        resume?.();
      }
    };
    const previous = ticket.access ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(admit);
    ticket.access = current;
    try {
      return await current;
    } finally {
      if (ticket.access === current) {
        delete ticket.access;
        this.schedulePump();
      }
    }
  }

  requestEnded(binding: BrowserOwnedRequest): void {
    const ticket = this.sessions.get(binding.session_id);
    const pending = ticket?.navigations.get(binding.page_id);
    if (binding.is_navigation && pending?.request === binding.request_id)
      pending.ended = true;
  }

  navigationRetryFailed(binding: BrowserOwnedRequest): void {
    const ticket = this.sessions.get(binding.session_id);
    const identity = ticket?.request.session_identity;
    if (
      !ticket ||
      ticket.done ||
      ticket.delivered ||
      !identity ||
      (ticket.execution &&
        ["downloading", "validating", "candidate-ready"].includes(
          ticket.execution.phase(),
        )) ||
      identity.operation_id !== binding.operation_id ||
      identity.generation !== binding.generation
    )
      return;
    // Navigation failure belongs to the retained article's next observation.
    // No lease or document grant is invented here: Host recovery must resume a
    // known document through resumeDocument before another network action.
    ticket.execution?.navigationFailed?.();
  }

  /** Raw CDP commits bind a new document to its exact admitted navigation. */
  documentCommitted(document: BrowserDocumentCommit): void {
    const ticket = this.sessions.get(document.session_id);
    if (
      !ticket ||
      ticket.done ||
      ticket.delivered ||
      document.signal.aborted ||
      document.is_error_document ||
      !document.is_main
    )
      return;
    const identity = ticket.request.session_identity!;
    const pending = ticket.navigations.get(document.page_id);
    if (
      document.operation_id !== identity.operation_id ||
      document.generation !== identity.generation ||
      !pending ||
      pending.request !== document.navigation_request_id ||
      pending.epoch !== ticket.networkEpoch ||
      pending.platform !== ticket.platform?.platform ||
      (pending.document !== null && pending.document !== document.document_id)
    )
      return;
    const previous = ticket.documents.get(document.page_id);
    if (previous && previous.generation >= document.document_generation) return;
    if (previous) ticket.documentGrants.delete(previous.document);
    ticket.documents.set(document.page_id, {
      document: document.document_id,
      generation: document.document_generation,
      platform: pending.platform,
    });
    ticket.documentGrants.add(document.document_id);
    ticket.documentHistory.set(document.document_id, {
      page: document.page_id,
      platform: pending.platform,
    });
    ticket.navigations.delete(document.page_id);
  }

  /** Only an explicit Host history/parent action may restore a previously known document. */
  async resumeDocument(
    document: BrowserDocumentCommit,
    drainPrevious: () => Promise<void>,
  ): Promise<void> {
    const ticket = this.sessions.get(document.session_id);
    const history = ticket?.documentHistory.get(document.document_id);
    if (
      !ticket ||
      !history ||
      history.page !== document.page_id ||
      ticket.done ||
      ticket.delivered ||
      document.signal.aborted ||
      document.operation_id !== ticket.request.session_identity!.operation_id ||
      document.generation !== ticket.request.session_identity!.generation
    )
      throw new Error("browser-document-network-inactive");
    const receivedEpoch = ticket.networkEpoch;
    const resume = async () => {
      if (
        receivedEpoch !== ticket.networkEpoch ||
        ticket.done ||
        ticket.controller.signal.aborted ||
        document.signal.aborted
      )
        throw new Error("browser-session-network-inactive");
      const include = ticket.execution?.clock.exclude();
      try {
        if (ticket.platform && ticket.platform.platform !== history.platform) {
          ticket.networkEpoch++;
          ticket.documentGrants.clear();
          ticket.resumableDocuments.clear();
          ticket.navigations.clear();
          const epoch = ticket.networkEpoch;
          await drainPrevious();
          if (
            epoch !== ticket.networkEpoch ||
            ticket.done ||
            ticket.controller.signal.aborted
          )
            throw new Error("browser-session-network-inactive");
          ticket.platform.release({ kind: "completed" });
          delete ticket.platform;
          ticket.startDispatched = false;
        }
        const epoch = ticket.networkEpoch;
        const previousLease = ticket.platform;
        const lease =
          previousLease ??
          (await this.platforms.acquire(
            document.session_id,
            history.platform,
            ticket.controller.signal,
          ));
        if (
          epoch !== ticket.networkEpoch ||
          ticket.done ||
          ticket.controller.signal.aborted
        ) {
          if (!previousLease) lease.release({ kind: "cancelled" });
          throw new Error("browser-session-network-inactive");
        }
        ticket.platform = lease;
        ticket.lastPlatform = history.platform;
        const previous = ticket.documents.get(document.page_id);
        if (previous) ticket.documentGrants.delete(previous.document);
        ticket.documents.set(document.page_id, {
          document: document.document_id,
          generation: document.document_generation,
          platform: history.platform,
        });
        ticket.documentGrants.add(document.document_id);
        // Restoring a known source ends the failed provisional navigation.
        // A new Agent choice must obtain a fresh admission, not reuse its retry.
        ticket.navigations.delete(document.page_id);
      } finally {
        include?.();
      }
    };
    const current = (ticket.access ?? Promise.resolve())
      .catch(() => undefined)
      .then(resume);
    ticket.access = current;
    try {
      await current;
    } finally {
      if (ticket.access === current) {
        delete ticket.access;
        this.schedulePump();
      }
    }
  }

  /** Called only after Host has disabled background requests and drained network work. */
  networkEnded(
    sessionId: string,
    outcome: BrowserAccessEnd = { kind: "completed" },
  ): void {
    const ticket = this.sessions.get(sessionId);
    if (!ticket) return;
    ticket.networkEpoch++;
    const resumable = new Set(ticket.resumableDocuments);
    ticket.resumableDocuments.clear();
    for (const fact of ticket.documents.values())
      if (
        fact.platform === ticket.platform?.platform &&
        (ticket.documentGrants.has(fact.document) ||
          resumable.has(fact.document))
      )
        ticket.resumableDocuments.add(fact.document);
    ticket.documentGrants.clear();
    ticket.navigations.clear();
    ticket.platform?.release(outcome);
    delete ticket.platform;
    ticket.startDispatched = false;
    this.schedulePump();
  }

  rateLimited(sessionId: string, retryAfterMs?: number): void {
    const ticket = this.sessions.get(sessionId);
    if (ticket?.platform) {
      this.platforms.rateLimited(ticket.platform.platform, retryAfterMs);
      const delay = Math.max(
        60_000,
        retryAfterMs ?? 0,
        (this.options.policy?.rate_limit_cooldown ?? 0) * 1_000,
      );
      if (
        ticket.expiresAt !== undefined &&
        performance.now() + delay >= ticket.expiresAt
      ) {
        void this.finish(
          ticket,
          browserRefused(
            "browser-rate-limited",
            "The platform retry delay exceeds the retained session lifetime.",
          ),
        );
        return;
      }
      ticket.execution?.rateLimited();
    }
  }

  transferFailed(sessionId: string): void {
    if (this.sessions.has(sessionId)) this.platforms.failed();
  }

  /** Shared Host loss ends acquisition, while delivered files retain their Entry lease. */
  runtimeLost(): void {
    if (this.closed || this.runtimeFailed) return;
    this.runtimeFailed = true;
    clearTimeout(this.timer);
    for (const ticket of new Set([...this.queue, ...this.sessions.values()])) {
      if (ticket.done || ticket.delivered) continue;
      // finish records the terminal result before aborting the ticket signal. Its
      // ordinary close path wakes model/changed/admission work and proves cleanup.
      this.track(
        this.finish(
          ticket,
          browserRefused(
            "browser-runtime-lost",
            "The shared Browser runtime disconnected.",
          ),
        ),
      );
    }
  }

  snapshot(): {
    readonly sessions: number;
    readonly queued: number;
    readonly workers: number;
    readonly platform_active: number;
  } {
    return {
      sessions: this.sessions.size,
      queued: this.queue.length,
      workers: this.activeWorkers,
      platform_active: this.platforms.snapshot().active,
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    clearTimeout(this.timer);
    this.platforms.close();
    const tickets = [...this.queue, ...this.sessions.values()];
    for (const ticket of tickets) ticket.controller.abort();
    await Promise.all(
      tickets.map((ticket) =>
        this.finish(
          ticket,
          browserRefused(
            "browser-flow-cancelled",
            "The Browser scheduler closed.",
          ),
        ),
      ),
    );
    while (this.tasks.size) await Promise.allSettled([...this.tasks]);
    this.latest.clear();
  }

  private schedulePump(): void {
    if (this.closed || this.runtimeFailed || this.pumpQueued) return;
    this.pumpQueued = true;
    queueMicrotask(() => {
      this.pumpQueued = false;
      this.pump();
    });
  }

  private pump(): void {
    if (this.closed || this.runtimeFailed) return;
    clearTimeout(this.timer);
    let delay = Infinity;
    for (const ticket of [...this.queue]) {
      const identity = ticket.request.session_identity!;
      const quarantined = [...this.sessions.values()].filter(
        (session) => session.cleanupFailed,
      );
      if (
        quarantined.length >= this.options.sessions ||
        quarantined.some(
          (session) => session.lastPlatform === ticket.lastPlatform,
        )
      ) {
        void this.finish(
          ticket,
          browserRefused(
            "browser-session-cleanup-failed",
            "A previous Browser session could not release its resources.",
          ),
        );
        continue;
      }
      if (
        identity.generation <
          (this.latest.get(identity.operation_id) ?? identity.generation) ||
        this.platforms.unavailable()
      ) {
        void this.finish(
          ticket,
          browserRefused(
            this.platforms.unavailable()
              ? "browser-runtime-circuit-open"
              : "browser-stale-generation",
            "The Browser attempt cannot be admitted.",
          ),
        );
        continue;
      }
      const retained = this.sessions.has(identity.session_id);
      if (!retained && this.sessions.size >= this.options.sessions) continue;
      // An in-flight navigation already owns platform admission. Recovery must
      // neither reacquire its previous platform nor wait for its own new lease.
      if (
        retained &&
        (ticket.access ||
          [...ticket.navigations.values()].some(
            (navigation) => navigation.retry_required,
          ))
      )
        continue;
      if (retained && ticket.platform) {
        this.queue.splice(this.queue.indexOf(ticket), 1);
        ticket.watching = false;
        this.enqueue(ticket);
        continue;
      }
      const platform = retained ? ticket.lastPlatform : ticket.initialPlatform;
      // One active article and one retained recovery may share a platform.
      // A backlog must not fill the whole browser with pages it cannot serve.
      if (
        !retained &&
        [...this.sessions.values()].filter(
          (item) => item.lastPlatform === platform,
        ).length >= 2
      )
        continue;
      if (!this.platforms.ready(platform)) {
        delay = Math.min(delay, this.platforms.delayMs(platform));
        continue;
      }
      this.queue.splice(this.queue.indexOf(ticket), 1);
      if (retained) {
        this.track(this.restore(ticket));
        continue;
      }
      this.sessions.set(identity.session_id, ticket);
      ticket.expiresAt =
        performance.now() + (this.options.lifetime_ms ?? 60 * 60_000);
      ticket.lifetime = setTimeout(
        () => {
          ticket.controller.abort();
          void this.finish(
            ticket,
            browserRefused(
              "browser-session-lifetime",
              "The retained Browser session reached its lifetime limit.",
            ),
          );
        },
        this.options.lifetime_ms ?? 60 * 60_000,
      );
      this.track(this.open(ticket));
    }
    if (Number.isFinite(delay))
      this.timer = setTimeout(
        () => this.schedulePump(),
        Math.max(1, Math.ceil(delay)),
      );
    while (this.activeWorkers < this.options.workers && this.ready.length) {
      const ticket = this.ready.shift()!;
      if (ticket.done || ticket.busy || ticket.delivered) continue;
      ticket.busy = true;
      this.activeWorkers++;
      this.track(
        this.step(ticket).finally(() => {
          ticket.busy = false;
          this.activeWorkers--;
          this.schedulePump();
        }),
      );
    }
  }

  private track(task: Promise<void>): void {
    this.tasks.add(task);
    void task
      .finally(() => this.tasks.delete(task))
      .catch(() =>
        this.logger.error("Browser scheduler task failed", {
          code: "browser-scheduler-task-failed",
        }),
      );
  }

  private async open(ticket: Ticket): Promise<void> {
    try {
      ticket.platform = await this.platforms.acquire(
        ticket.request.session_identity!.session_id,
        ticket.initialPlatform,
        ticket.controller.signal,
      );
      const execution = await ticket.open(ticket.request);
      if (!ticket.execution) ticket.execution = execution;
      if (ticket.done) {
        await execution.close({ kind: "cancelled" });
        return;
      }
      this.enqueue(ticket);
    } catch (error) {
      await this.finish(
        ticket,
        browserRefused(
          ticket.controller.signal.aborted
            ? "browser-flow-cancelled"
            : error instanceof BrowserArticleOpenError ||
                error instanceof BrowserPlatformQuarantinedError
              ? error.code
              : "browser-open-failed",
          "The Browser article page could not be opened.",
        ),
      );
    }
  }

  private enqueue(ticket: Ticket): void {
    if (!ticket.done && !ticket.delivered && !this.ready.includes(ticket))
      this.ready.push(ticket);
    this.schedulePump();
  }

  private async step(ticket: Ticket): Promise<void> {
    try {
      const execution = ticket.execution!;
      const phase = execution.phase();
      if (!ticket.platform && ["ready", "waiting"].includes(phase)) {
        // Recovery is a new access attempt. Await admission outside a decision slot.
        this.watchAdmission(ticket);
        return;
      }
      const result = await execution.step();
      if (ticket.done) return;
      if (result.kind === "terminal") await this.finish(ticket, result.result);
      else if (result.kind === "candidate") {
        ticket.delivered = true;
        ticket.resolve({
          kind: "delivered",
          candidate: result.candidate,
          accepted: true,
          lease: {
            session_id: execution.session_id,
            signal: ticket.request.signal,
            close: async (outcome) => {
              await this.closeTicket(ticket, outcome);
              if (ticket.cleanupFailed) {
                const error = new Error(
                  "Browser session cleanup failed",
                ) as Error & { code: string };
                error.code =
                  ticket.cleanupCode ?? "browser-session-cleanup-failed";
                throw error;
              }
            },
          },
        });
      } else this.watch(ticket);
    } catch (error) {
      await this.finish(
        ticket,
        browserRefused(
          ticket.controller.signal.aborted
            ? "browser-flow-cancelled"
            : error instanceof BrowserArticleOpenError
              ? error.code
              : "browser-step-failed",
          "The Browser article step could not complete.",
        ),
      );
    }
  }

  private watch(ticket: Ticket): void {
    if (ticket.watching || ticket.done) return;
    ticket.watching = true;
    void ticket.execution!.changed(ticket.controller.signal).then(
      () => {
        ticket.watching = false;
        this.enqueue(ticket);
      },
      () => {
        ticket.watching = false;
        if (!ticket.done)
          void this.finish(
            ticket,
            browserRefused(
              "browser-flow-cancelled",
              "Browser waiting was cancelled.",
            ),
          );
      },
    );
  }

  private watchAdmission(ticket: Ticket): void {
    if (ticket.watching || ticket.done) return;
    ticket.watching = true;
    this.queue.push(ticket);
    this.schedulePump();
  }

  private async restore(ticket: Ticket): Promise<void> {
    try {
      const lease = await this.platforms.acquire(
        ticket.request.session_identity!.session_id,
        ticket.lastPlatform,
        ticket.controller.signal,
      );
      ticket.watching = false;
      if (ticket.done) {
        lease.release({ kind: "cancelled" });
        return;
      }
      ticket.platform = lease;
      ticket.execution!.setNetworkAccess(true);
      this.enqueue(ticket);
    } catch {
      ticket.watching = false;
      if (!ticket.done)
        await this.finish(
          ticket,
          browserRefused(
            "browser-platform-unavailable",
            "Browser platform admission ended.",
          ),
        );
    }
  }

  private async finish(
    ticket: Ticket,
    result: BrowserDeliveryResult,
  ): Promise<void> {
    // Aborting work can race its rejection handler against the owner that ended
    // the ticket. Preserve that owner's first result through the shared cleanup.
    const terminal = (ticket.terminalResult ??= result);
    const outcome: BrowserArticleCloseOutcome =
      terminal.kind === "refused" && terminal.code === "browser-flow-cancelled"
        ? { kind: "cancelled" }
        : {
            kind: "retained",
            code: terminal.kind === "refused" ? terminal.code : terminal.kind,
          };
    await this.closeTicket(ticket, outcome);
    if (!ticket.delivered)
      ticket.resolve(
        ticket.cleanupFailed
          ? browserRefused(
              "browser-session-cleanup-failed",
              `The Browser session could not release its resources (${ticket.cleanupCode ?? "browser-session-cleanup-failed"}).`,
            )
          : terminal,
      );
  }

  private closeTicket(
    ticket: Ticket,
    outcome: BrowserArticleCloseOutcome,
  ): Promise<void> {
    ticket.closing ??= (async () => {
      ticket.done = true;
      clearTimeout(ticket.lifetime);
      ticket.detach();
      ticket.detachExecution?.();
      ticket.controller.abort();
      for (const list of [this.queue, this.ready]) {
        const index = list.indexOf(ticket);
        if (index >= 0) list.splice(index, 1);
      }
      try {
        await ticket.execution?.close(outcome);
      } catch (error) {
        ticket.cleanupFailed = true;
        ticket.cleanupCode = cleanupFailureCode(error);
        if (ticket.platform)
          this.platforms.quarantine(ticket.platform.platform);
        this.logger.error("Browser session cleanup failed", {
          code: "browser-flow-close-failed",
          cause_code: ticket.cleanupCode,
          session_id: ticket.request.session_identity!.session_id,
        });
        this.projectClosed(ticket, {
          kind: "retained",
          code: ticket.cleanupCode,
        });
      } finally {
        // An unproven cleanup retains its capacity and platform reservation.
        // New work cannot silently reuse resources that may still be alive.
        if (!ticket.cleanupFailed) {
          const end: BrowserAccessEnd = {
            kind:
              outcome.kind === "cancelled"
                ? "cancelled"
                : outcome.kind === "published" ||
                    outcome.code === "exhausted" ||
                    outcome.code === "delivered"
                  ? "completed"
                  : outcome.code === "browser-runtime-lost"
                    ? "runtime-failure"
                    : "failure",
          };
          if (end.kind === "runtime-failure" && !ticket.startDispatched)
            this.platforms.failed(true);
          this.networkEnded(ticket.request.session_identity!.session_id, end);
          this.sessions.delete(ticket.request.session_identity!.session_id);
          this.projectClosed(ticket, outcome);
        }
        this.schedulePump();
      }
    })();
    return ticket.closing;
  }

  private projectClosed(
    ticket: Ticket,
    outcome: BrowserArticleCloseOutcome,
  ): void {
    try {
      this.options.onRemoved?.(
        ticket.request.session_identity!.session_id,
        outcome,
      );
    } catch {
      this.logger.error("Browser collaboration feedback failed", {
        code: "browser-projection-failed",
      });
    }
  }
}

/** Only declared internal causes may leave the exception chain; never URLs/messages. */
function cleanupFailureCode(error: unknown, depth = 0): string {
  if (!(error instanceof Error) || depth > 8)
    return "browser-session-cleanup-failed";
  const code = "code" in error ? error.code : undefined;
  if (
    code === "browser-platform-handoff-stalled" ||
    code === "browser-runtime-lost" ||
    code === "browser-download-cancel-unconfirmed"
  )
    return code;
  const causes = error instanceof AggregateError ? error.errors : [error.cause];
  for (const cause of causes) {
    const found = cleanupFailureCode(cause, depth + 1);
    if (found !== "browser-session-cleanup-failed") return found;
  }
  return "browser-session-cleanup-failed";
}
