import { BrowserActivityLog, activityText } from "../browser/activity.js";
import { randomUUID } from "node:crypto";
import {
  parseBrowserAction,
  parseWorkbenchActionCommand,
  parseWorkbenchObservation,
  type BrowserAction,
  type WorkbenchActionCommand,
  type WorkbenchObservation,
  type WorkbenchView,
  type WorkbenchCandidate,
  type WorkbenchGuidance,
  type CandidatePublicationReceipt,
} from "@sciretriever/contracts";
import { BrowserPageTransitionError } from "../browser/page-runtime.js";
import { BrowserControlCoordinator } from "../browser/control.js";
import {
  BrowserObservationStore,
  type BrowserCaptureState,
  type BrowserObservation,
} from "../browser/observation.js";
import type {
  BrowserAgentCapability,
  BrowserAgentEvent,
  BrowserAgentSession,
} from "../browser/decision.js";
import type { BrowserPageHandle } from "../browser/host.js";
import type { BrowserArticleExecution } from "../browser/article-session.js";
import type {
  BrowserArticleAutomaticContext,
  FlowPageHandle,
} from "../browser/article-flow.js";
import { ExecutionLoop } from "../acquisition/execution-loop.js";
import {
  ExecutionPolicy,
  ExecutionPolicyError,
  type ExecutionBudget,
} from "../acquisition/execution-policy.js";
import {
  DEFAULT_BROWSER_AGENT_ACTION_COOLDOWN_MS,
  DEFAULT_BROWSER_AGENT_CHALLENGE_WAIT_MS,
  DEFAULT_BROWSER_AGENT_WAIT_FOR_CHANGE_MS,
  waitForBrowserAgentCooldown,
} from "../browser/pacing.js";

export class WorkbenchSessionError extends Error {
  constructor(
    readonly code:
      | "stale-command"
      | "session-busy"
      | "session-closed"
      | "model-unavailable"
      | "browser-failed",
  ) {
    super("workbench session operation failed");
  }
}
export type WorkbenchSessionState =
  | "watching"
  | "agent-running"
  | "needs-assistance"
  | "paused"
  | "cancelled"
  | "finished"
  | "failed";
export type BrowserDecision = import("../browser/article-flow.js").FlowDecision;

/** One fixed article, one page, one command executor. Viewer transport owns no Browser resources. */
export class WorkbenchSession {
  readonly id: string;
  private readonly control: BrowserControlCoordinator;
  private readonly observations = new BrowserObservationStore();
  private readonly policy: Pick<
    ExecutionPolicy,
    "state" | "remaining" | "pause" | "resume" | "cancel" | "finish" | "consume"
  >;
  private readonly loop: ExecutionLoop | undefined;
  private readonly sharedCommands = new Map<
    string,
    { digest: string; completion: Promise<void> }
  >();
  private readonly humans = new Set<string>();
  private readonly candidates = new Map<string, WorkbenchCandidate>();
  private readonly agentId = `agent-${randomUUID()}`;
  private current: BrowserObservation | undefined;
  private wire: WorkbenchObservation | null = null;
  private observedAt = "";
  private observationPending = false;
  private stateValue: WorkbenchSessionState = "watching";
  private errorValue: WorkbenchSessionError["code"] | null = null;
  private busy = false;
  private actionPromise: Promise<unknown> | undefined;
  private refreshPromise: Promise<void> | undefined;
  private agentAbort: AbortController | undefined;
  private agentPromise: Promise<void> | undefined;
  private closePromise: Promise<void> | undefined;
  private publicationAbort: AbortController | undefined;
  private publicationPromise: Promise<void> | undefined;
  private abandonmentAbort: AbortController | undefined;
  private abandonmentPromise: Promise<void> | undefined;
  private captureStateValue: BrowserCaptureState = "NONE";
  private stopResult: "stopped" | "budget" | "cancelled" | undefined;
  private readonly guidance = new Map<
    string,
    WorkbenchGuidance & { owner: string }
  >();
  private readonly waiters = new Set<() => void>();
  private agentSession: BrowserAgentSession | undefined;
  private readonly pendingAgentEvents: BrowserAgentEvent[] = [];
  private activity: BrowserActivityLog;
  private readonly displayArticleId: string;
  private queuedAt = new Date().toISOString();
  private publishedOutcome:
    | import("@sciretriever/contracts").WorkbenchArticleCloseOutcome
    | undefined;
  private nextObservationActor: "human" | "platform" = "platform";

  constructor(
    public articleId: string,
    private page: BrowserPageHandle,
    budget: ExecutionBudget,
    private readonly decide?: BrowserDecision,
    id = `session-${randomUUID()}`,
    private readonly closePage?: () => Promise<void>,
    private readonly publishCandidate?: (
      candidate: WorkbenchCandidate,
      signal: AbortSignal,
    ) => Promise<CandidatePublicationReceipt>,
    private readonly switchTarget?: (articleId: string) => Promise<void>,
    private readonly abandonCandidateOperation?: (
      candidate: WorkbenchCandidate,
      signal: AbortSignal,
    ) => Promise<void>,
    private readonly production = false,
    private readonly execution?: BrowserArticleExecution,
    private readonly capability?: BrowserAgentCapability,
    private readonly display?: {
      readonly title?: string;
      readonly operation_id?: string;
    },
  ) {
    this.activity = execution?.activity ?? new BrowserActivityLog();
    this.displayArticleId = articleId;
    if (!/^[a-zA-Z0-9._:-]{1,128}$/u.test(articleId))
      throw new WorkbenchSessionError("stale-command");
    this.id = id;
    this.control = new BrowserControlCoordinator(id);
    this.control.attach({
      client_id: this.agentId,
      workspace_id: id,
      role: "agent",
    });
    if (execution) {
      if (
        !production ||
        execution.session_id !== id ||
        execution.identity.literature_id !== articleId
      )
        throw new WorkbenchSessionError("stale-command");
      this.policy = {
        remaining: () => ({ ...execution.clock.remaining(), bytes: 0 }),
        state: () =>
          this.stateValue === "paused"
            ? "paused"
            : this.stateValue === "cancelled"
              ? "cancelled"
              : ["finished", "failed"].includes(this.stateValue)
                ? "finished"
                : "running",
        pause: () => {},
        resume: () => {},
        cancel: () => {},
        finish: () => {},
        consume: () => {
          throw new WorkbenchSessionError("stale-command");
        },
      };
      this.loop = undefined;
    } else {
      const policy = new ExecutionPolicy(
        "browser:generic",
        "published",
        budget,
      );
      this.policy = policy;
      this.loop = new ExecutionLoop(policy, () => this.control.state().epoch);
    }
  }
  /** Switch the active tab while retaining the session's article and control lease. */
  async activatePage(page: BrowserPageHandle): Promise<void> {
    this.live();
    if (this.busy || this.agentPromise || this.refreshPromise)
      throw new WorkbenchSessionError("session-busy");
    if (!page || typeof page.id !== "string")
      throw new WorkbenchSessionError("stale-command");
    await page.activate?.();
    this.nextObservationActor = "human";
    this.page = page;
    this.current = undefined;
    this.wire = null;
    this.errorValue = null;
    await this.refresh();
  }
  /** Select a new Literature target while preserving the same Browser session and control lease. */
  async selectTarget(
    clientId: string,
    epoch: number,
    articleId: string,
  ): Promise<void> {
    this.human(clientId);
    this.live();
    if (!/^[a-zA-Z0-9._:-]{1,128}$/u.test(articleId))
      throw new WorkbenchSessionError("stale-command");
    this.control.assertController(clientId, epoch);
    if (
      articleId === this.articleId ||
      this.busy ||
      this.agentPromise ||
      this.publicationPromise ||
      this.abandonmentPromise ||
      this.refreshPromise ||
      this.candidates.size
    )
      throw new WorkbenchSessionError("session-busy");
    if (!this.switchTarget || !this.page.navigate)
      throw new WorkbenchSessionError("stale-command");
    this.busy = true;
    try {
      await this.switchTarget(articleId);
      this.expireGuidance();
      await this.agentSession?.close();
      this.agentSession = undefined;
      this.pendingAgentEvents.length = 0;
      this.articleId = articleId;
      this.activity = new BrowserActivityLog();
      this.queuedAt = new Date().toISOString();
      this.current = undefined;
      this.wire = null;
      this.captureStateValue = "NONE";
      this.errorValue = null;
      this.stateValue = "watching";
    } finally {
      this.busy = false;
    }
  }
  attach(existingId?: string): string {
    if (this.humans.size >= 16 || this.closePromise)
      throw new WorkbenchSessionError("session-closed");
    const id = existingId ?? `client-${randomUUID()}`;
    if (!/^[a-zA-Z0-9._:-]{1,128}$/u.test(id))
      throw new WorkbenchSessionError("stale-command");
    if (this.humans.has(id)) throw new WorkbenchSessionError("stale-command");
    this.humans.add(id);
    this.control.attach({
      client_id: id,
      workspace_id: this.id,
      role: "human",
    });
    return id;
  }
  detach(clientId: string): void {
    this.human(clientId);
    const controlled = this.control.state().controller_id === clientId;
    if (this.control.state().controller_id === clientId)
      this.publicationAbort?.abort();
    if (this.control.state().controller_id === clientId)
      this.abandonmentAbort?.abort();
    this.humans.delete(clientId);
    this.control.detach(clientId);
    if (controlled && this.production) {
      this.policy.pause();
      this.stateValue = "paused";
    }
    if (controlled) this.controlChanged();
    else this.wake();
  }
  private wake(): void {
    for (const waiter of this.waiters) waiter();
    this.waiters.clear();
  }
  private recordAgentEvent(event: BrowserAgentEvent): void {
    if (this.execution) this.execution.recordAgentEvent?.(event);
    else if (this.agentSession) this.agentSession.record(event);
    else if (this.capability) this.pendingAgentEvents.push(event);
  }
  private async openAgentSession(): Promise<BrowserAgentSession> {
    if (!this.agentSession) {
      if (!this.capability)
        throw new WorkbenchSessionError("model-unavailable");
      const opened = await this.capability.open({
        session_id: this.id,
        literature_id: this.articleId,
      });
      if (this.closePromise || this.policy.state() === "cancelled") {
        await opened.close();
        throw new WorkbenchSessionError("session-closed");
      }
      this.agentSession = opened;
      for (const event of this.pendingAgentEvents.splice(0))
        this.agentSession.record(event);
    }
    return this.agentSession;
  }
  private controlChanged(): void {
    this.execution?.controlEpochChanged();
    this.recordAgentEvent({
      kind: "control",
      control_epoch: this.control.state().epoch,
      controller:
        this.control.state().controller_id === null ? "agent" : "human",
    });
    this.wake();
  }

  /** Production input is projected from the Browser article owner, including its clock. */
  automaticContext(): BrowserArticleAutomaticContext {
    if (!this.execution) throw new WorkbenchSessionError("stale-command");
    let dispatchedGuidance: readonly string[] = [];
    return {
      canDecide: () =>
        !this.closePromise &&
        this.policy.state() === "running" &&
        this.control.state().controller_id === null &&
        !this.busy,
      controlEpoch: () => this.control.state().epoch,
      guidance: () => {
        const accepted = [...this.guidance.values()].filter(
          (item) => item.state === "accepted",
        );
        dispatchedGuidance = accepted.map((item) => item.guidance_id);
        return accepted.map((item) => item.text);
      },
      onDispatched: () => {
        for (const id of dispatchedGuidance) {
          const item = this.guidance.get(id);
          if (item?.state === "accepted") {
            this.guidance.set(id, { ...item, state: "consumed" });
            this.recordAgentEvent({
              kind: "guidance",
              guidance_id: id,
              state: "consumed",
              control_epoch: this.control.state().epoch,
            });
          }
        }
      },
      onObservation: (observation, frame, page) =>
        this.acceptAutomaticObservation(observation, frame, page),
      stopReason: () => this.stopResult,
    };
  }

  private acceptAutomaticObservation(
    observation: WorkbenchObservation,
    frame: Uint8Array | null,
    page: FlowPageHandle,
  ): void {
    if (
      observation.session_id !== this.id ||
      observation.article_id !== this.articleId ||
      observation.control_epoch !== this.control.state().epoch ||
      !("id" in page) ||
      typeof page.id !== "string"
    )
      throw new WorkbenchSessionError("stale-command");
    this.page = page as BrowserPageHandle;
    this.wire = parseWorkbenchObservation(observation);
    this.activity.observe(this.wire);
    this.current = {
      article_id: observation.article_id,
      page_id: observation.page_id,
      document_generation: observation.document_generation,
      revision: observation.observation_revision,
      document_version: observation.document_generation,
      viewport_version: observation.viewport_revision,
      url: observation.url,
      title: observation.title,
      text: observation.text,
      viewport: observation.viewport,
      elements: observation.elements,
      loading: observation.loading,
      partial: observation.partial,
      frame: frame ? new Uint8Array(frame) : null,
      frame_truncated: observation.frame_dropped,
      page_state: observation.page_state,
      capture_state: observation.capture_state,
    };
    this.observationPending = false;
    this.errorValue = null;
  }
  private human(clientId: string): void {
    if (!this.humans.has(clientId))
      throw new WorkbenchSessionError("stale-command");
  }
  private live(): void {
    if (
      ["cancelled", "finished", "failed"].includes(this.stateValue) ||
      this.closePromise
    )
      throw new WorkbenchSessionError("session-closed");
  }
  private invalidateAgent(): void {
    this.agentAbort?.abort();
    if (this.control.state().controller_id === this.agentId)
      this.control.release(this.agentId, this.control.state().epoch);
  }
  takeover(clientId: string, epoch: number): void {
    this.human(clientId);
    if (
      this.closePromise ||
      (!this.candidates.size &&
        ["cancelled", "finished", "failed"].includes(this.stateValue))
    )
      throw new WorkbenchSessionError("session-closed");
    if (epoch !== this.control.state().epoch)
      throw new WorkbenchSessionError("stale-command");
    this.invalidateAgent();
    this.publicationAbort?.abort();
    this.abandonmentAbort?.abort();
    this.control.takeover(clientId);
    if (this.stateValue === "agent-running") this.stateValue = "watching";
    this.expireGuidance();
    this.controlChanged();
  }
  release(clientId: string, epoch: number): void {
    this.human(clientId);
    this.control.release(clientId, epoch);
    this.publicationAbort?.abort();
    this.abandonmentAbort?.abort();
    if (this.production && this.stateValue === "paused") {
      this.policy.resume();
      this.stateValue = "watching";
    }
    this.controlChanged();
  }
  pause(clientId: string, epoch: number): void {
    this.human(clientId);
    this.live();
    this.control.assertController(clientId, epoch);
    this.invalidateAgent();
    this.policy.pause();
    this.publicationAbort?.abort();
    this.abandonmentAbort?.abort();
    this.stateValue = "paused";
    // Revoke even the current human's in-flight low-level input guard.
    this.control.takeover(clientId);
    this.controlChanged();
  }
  resume(clientId: string, epoch: number): void {
    this.human(clientId);
    this.live();
    this.control.assertController(clientId, epoch);
    this.policy.resume();
    this.stateValue = "watching";
    this.controlChanged();
  }
  cancel(clientId: string, epoch: number): void {
    this.human(clientId);
    this.live();
    this.control.assertController(clientId, epoch);
    this.publicationAbort?.abort();
    this.abandonmentAbort?.abort();
    this.invalidateAgent();
    this.policy.cancel();
    this.stateValue = "cancelled";
    if (!this.production)
      this.activity.close(this.publishedOutcome ?? { kind: "cancelled" });
    this.control.release(clientId, this.control.state().epoch);
    this.execution?.cancel();
    this.controlChanged();
  }
  activityLog(): BrowserActivityLog {
    return this.activity;
  }
  view(): WorkbenchView {
    const control = this.control.state();
    return Object.freeze({
      ...(this.production ? { mode: "production" as const } : {}),
      actions: this.activity.snapshot(),
      ...(!this.production
        ? {
            sessions: [
              {
                session_id: this.id,
                article_id: this.articleId,
                generation: 0,
                operation_id: this.display?.operation_id ?? this.id,
                ...(this.articleId === this.displayArticleId &&
                this.display?.title
                  ? { title: activityText(this.display.title, 512) }
                  : {}),
                queued_at: this.queuedAt,
                phase: this.activity.closedAt
                  ? ("closed" as const)
                  : this.stateValue === "agent-running"
                    ? ("deciding" as const)
                    : this.captureStateValue === "CANDIDATE"
                      ? ("downloading" as const)
                      : ("ready" as const),
                ...(this.activity.closedAt
                  ? { closed_at: this.activity.closedAt }
                  : {}),
                ...(this.activity.outcome
                  ? { outcome: this.activity.outcome }
                  : {}),
                ...(this.activity.stop ? { stop: this.activity.stop } : {}),
              },
            ],
          }
        : {}),
      candidates: [...this.candidates.values()],
      ...(this.production
        ? {
            guidance: [...this.guidance.values()].map((item) => ({
              guidance_id: item.guidance_id,
              article_id: item.article_id,
              text: item.text,
              state: item.state,
            })),
          }
        : {}),
      session_id: this.id,
      article_id: this.articleId,
      state:
        this.execution &&
        this.stateValue === "watching" &&
        this.execution.phase() === "deciding"
          ? "agent-running"
          : this.stateValue,
      control: { ...control, viewers: this.humans.size },
      model_ready: !!(this.decide || this.execution || this.capability),
      error: this.errorValue,
      observation: this.wire
        ? {
            ...this.wire,
            control_epoch: control.epoch,
            capture_state: this.captureStateValue,
            remaining: this.policy.remaining(),
          }
        : null,
    });
  }
  candidateReady(candidate: WorkbenchCandidate): void {
    if (
      this.candidates.size >= 100 &&
      !this.candidates.has(candidate.transfer_id)
    )
      throw new WorkbenchSessionError("session-busy");
    const previous = this.candidates.get(candidate.transfer_id);
    this.candidates.set(candidate.transfer_id, Object.freeze({ ...candidate }));
    if (!this.execution?.activity && !previous)
      this.activity.record({
        actor: "platform",
        kind:
          candidate.disposition === "accepted"
            ? "validation-passed"
            : "validation-failed",
      });
    this.captureStateValue = "CAPTURED";
  }
  transferStarted(): void {
    if (!this.closePromise) {
      this.captureStateValue = "CANDIDATE";
      this.activity.record({ actor: "platform", kind: "download-started" });
    }
    this.wake();
  }
  transferFailed(): void {
    this.activity.record({
      actor: "platform",
      kind: "download-failed",
      label: "browser-transfer-failed",
    });
    if (!this.closePromise && this.captureStateValue !== "CAPTURED")
      this.captureStateValue = "NONE";
    this.wake();
  }
  notifyCapture(): void {
    this.captureStateValue = "CAPTURED";
    this.wake();
  }
  private expireGuidance(): void {
    for (const [id, item] of this.guidance)
      if (item.state === "accepted") {
        this.guidance.set(id, { ...item, state: "expired" });
        this.recordAgentEvent({
          kind: "guidance",
          guidance_id: id,
          state: "expired",
          control_epoch: this.control.state().epoch,
        });
      }
  }
  submitGuidance(clientId: string, value: unknown): WorkbenchGuidance {
    this.human(clientId);
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new WorkbenchSessionError("stale-command");
    const command = value as Record<string, unknown>;
    if (
      Object.keys(command).sort().join() !==
        "article_id,control_epoch,guidance_id,session_id,text" ||
      command.session_id !== this.id ||
      command.article_id !== this.articleId ||
      typeof command.control_epoch !== "number" ||
      command.control_epoch !== this.control.state().epoch ||
      typeof command.guidance_id !== "string" ||
      !/^[a-zA-Z0-9._:-]{1,128}$/u.test(command.guidance_id) ||
      typeof command.text !== "string" ||
      command.text.trim().length === 0 ||
      command.text.length > 2048 ||
      [...command.text].some(
        (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
      )
    )
      throw new WorkbenchSessionError("stale-command");
    const existing = this.guidance.get(command.guidance_id);
    if (existing) {
      if (
        existing.text !== command.text ||
        existing.article_id !== this.articleId
      )
        throw new WorkbenchSessionError("stale-command");
      return this.guidanceView(existing);
    }
    const pending = [...this.guidance.values()].filter(
      (item) => item.state === "accepted",
    ).length;
    if (this.guidance.size >= 64 || pending >= 16)
      throw new WorkbenchSessionError("session-busy");
    const state: WorkbenchGuidance["state"] =
      this.stateValue === "paused" ||
      (this.control.state().controller_id !== null &&
        this.control.state().controller_id !== this.agentId) ||
      ["cancelled", "finished", "failed"].includes(this.stateValue)
        ? "rejected"
        : "accepted";
    const item = {
      guidance_id: command.guidance_id,
      article_id: this.articleId,
      text: command.text,
      state,
      owner: clientId,
    };
    this.guidance.set(item.guidance_id, item);
    this.recordAgentEvent({
      kind: "guidance",
      guidance_id: item.guidance_id,
      state,
      text: item.text,
      control_epoch: command.control_epoch,
    });
    this.wake();
    return this.guidanceView(item);
  }
  private guidanceView(item: WorkbenchGuidance): WorkbenchGuidance {
    return {
      guidance_id: item.guidance_id,
      article_id: item.article_id,
      text: item.text,
      state: item.state,
    };
  }
  cancelGuidance(clientId: string, value: unknown): WorkbenchGuidance {
    this.human(clientId);
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new WorkbenchSessionError("stale-command");
    const command = value as Record<string, unknown>;
    if (
      Object.keys(command).sort().join() !== "guidance_id,session_id" ||
      command.session_id !== this.id ||
      typeof command.guidance_id !== "string"
    )
      throw new WorkbenchSessionError("stale-command");
    const item = this.guidance.get(command.guidance_id);
    if (!item || item.owner !== clientId || item.state !== "accepted")
      throw new WorkbenchSessionError("stale-command");
    const cancelled = { ...item, state: "cancelled" as const };
    this.guidance.set(item.guidance_id, cancelled);
    this.recordAgentEvent({
      kind: "guidance",
      guidance_id: item.guidance_id,
      state: "cancelled",
      control_epoch: this.control.state().epoch,
    });
    return this.guidanceView(cancelled);
  }
  async acceptCandidate(clientId: string, value: unknown): Promise<void> {
    this.human(clientId);
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new WorkbenchSessionError("stale-command");
    const command = value as Record<string, unknown>;
    if (
      Object.keys(command).sort().join() !==
        "control_epoch,session_id,sha256,transfer_id" ||
      command.session_id !== this.id ||
      typeof command.transfer_id !== "string" ||
      typeof command.control_epoch !== "number"
    )
      throw new WorkbenchSessionError("stale-command");
    this.control.assertController(clientId, command.control_epoch);
    if (this.closePromise) throw new WorkbenchSessionError("session-closed");
    if (this.publicationPromise || !this.publishCandidate)
      throw new WorkbenchSessionError("session-busy");
    const candidate = this.candidates.get(command.transfer_id);
    if (
      !candidate ||
      candidate.sha256 !== command.sha256 ||
      candidate.disposition !== "accepted"
    )
      throw new WorkbenchSessionError("stale-command");
    const abort = new AbortController();
    this.publicationAbort = abort;
    this.publicationPromise = (async () => {
      const publication = await this.publishCandidate!(candidate, abort.signal);
      if (
        publication.literature_id !== this.articleId ||
        publication.sha256 !== candidate.sha256
      )
        throw new WorkbenchSessionError("stale-command");
      if (!this.production)
        this.publishedOutcome = {
          kind: "published",
          receipt_id: publication.receipt_id,
        };
      // A commit that already crossed its publication boundary remains a valid fact after takeover.
      this.candidates.set(
        candidate.transfer_id,
        Object.freeze({ ...candidate, publication }),
      );
    })();
    try {
      await this.publicationPromise;
    } finally {
      this.publicationPromise = undefined;
      this.publicationAbort = undefined;
    }
  }
  async abandonCandidate(clientId: string, value: unknown): Promise<void> {
    this.human(clientId);
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new WorkbenchSessionError("stale-command");
    const command = value as Record<string, unknown>;
    if (
      Object.keys(command).sort().join() !==
        "control_epoch,session_id,sha256,transfer_id" ||
      command.session_id !== this.id ||
      typeof command.transfer_id !== "string" ||
      typeof command.sha256 !== "string" ||
      typeof command.control_epoch !== "number"
    )
      throw new WorkbenchSessionError("stale-command");
    this.control.assertController(clientId, command.control_epoch);
    if (this.closePromise) throw new WorkbenchSessionError("session-closed");
    if (
      this.publicationPromise ||
      this.abandonmentPromise ||
      !this.abandonCandidateOperation
    )
      throw new WorkbenchSessionError("session-busy");
    const candidate = this.candidates.get(command.transfer_id);
    if (
      !candidate ||
      candidate.sha256 !== command.sha256 ||
      candidate.publication
    )
      throw new WorkbenchSessionError("stale-command");
    const abort = new AbortController();
    this.abandonmentAbort = abort;
    this.abandonmentPromise = this.abandonCandidateOperation(
      candidate,
      abort.signal,
    ).then(() => {
      this.candidates.delete(candidate.transfer_id);
      if (!this.candidates.size) this.captureStateValue = "NONE";
    });
    try {
      await this.abandonmentPromise;
    } finally {
      this.abandonmentPromise = undefined;
      this.abandonmentAbort = undefined;
    }
  }
  frame(sequence: number): Uint8Array | null {
    return this.wire?.frame_seq === sequence && this.current?.frame
      ? new Uint8Array(this.current.frame)
      : null;
  }
  async refresh(): Promise<void> {
    if (
      this.busy ||
      this.closePromise ||
      (this.production && this.stateValue === "agent-running") ||
      (this.execution &&
        this.control.state().controller_id === null &&
        [
          "deciding",
          "waiting",
          "downloading",
          "validating",
          "candidate-ready",
          "closing",
          "closed",
        ].includes(this.execution.phase())) ||
      ["cancelled", "finished", "failed"].includes(this.stateValue)
    )
      return;
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = this.refreshInternal();
    try {
      await this.refreshPromise;
    } finally {
      this.refreshPromise = undefined;
    }
  }
  private async refreshInternal(): Promise<void> {
    try {
      const observation = await this.observations.observe(
        this.articleId,
        this.page.id,
        this.page,
        this.captureStateValue,
      );
      if (
        observation.document_generation === undefined ||
        !Number.isSafeInteger(observation.document_generation) ||
        observation.document_generation < 0
      )
        throw new WorkbenchSessionError("browser-failed");
      this.observedAt = new Date().toISOString();
      this.wire = parseWorkbenchObservation({
        session_id: this.id,
        article_id: this.articleId,
        page_id: observation.page_id,
        document_generation: observation.document_generation,
        observation_revision: observation.revision,
        viewport_revision: observation.viewport_version,
        control_epoch: this.control.state().epoch,
        frame_seq: observation.revision,
        frame_available: observation.frame !== null,
        frame_dropped: observation.frame_truncated,
        observed_at: this.observedAt,
        url: observation.url,
        title: observation.title,
        text: observation.text ?? "",
        loading: observation.loading ?? false,
        partial: observation.partial ?? false,
        viewport: observation.viewport,
        elements: observation.elements ?? [],
        page_state: observation.page_state,
        capture_state: observation.capture_state,
        remaining: this.policy.remaining(),
      });
      this.activity.observe(this.wire, this.nextObservationActor);
      this.nextObservationActor = "platform";
      this.current = observation;
      this.observationPending = false;
      this.errorValue = null;
      if (this.stateValue === "watching" && observation.page_state !== "NORMAL")
        this.stateValue = "needs-assistance";
    } catch (error) {
      this.observationPending = error instanceof BrowserPageTransitionError;
      this.errorValue = "browser-failed";
      // Retain the last intact frame; a pending transition must be re-observed before dispatch.
    }
  }
  async command(
    clientId: string,
    value: unknown,
  ): Promise<"applied" | "duplicate"> {
    this.human(clientId);
    return this.execute(clientId, parseWorkbenchActionCommand(value), true);
  }
  private async execute(
    clientId: string,
    command: WorkbenchActionCommand,
    human: boolean,
  ): Promise<"applied" | "duplicate"> {
    this.live();
    if (this.refreshPromise) await this.refreshPromise;
    this.live();
    if (this.busy) throw new WorkbenchSessionError("session-busy");
    const observation = this.current;
    if (
      this.errorValue === "browser-failed" ||
      !observation ||
      command.session_id !== this.id ||
      command.page_id !== this.page.id ||
      command.document_generation !== observation.document_generation ||
      command.observation_revision !== observation.revision ||
      command.viewport_revision !== observation.viewport_version
    )
      throw new WorkbenchSessionError("stale-command");
    this.control.assertController(clientId, command.control_epoch);
    const current = () =>
      this.control.state().controller_id === clientId &&
      this.control.state().epoch === command.control_epoch &&
      this.policy.state() === "running" &&
      !this.closePromise;
    this.busy = true;
    try {
      const request = {
        client_id: clientId,
        epoch: command.control_epoch,
        request_id: command.request_id,
        observation,
        action: command.input,
      };
      const applyInput = async (
        input: import("@sciretriever/contracts").OperatorInput,
      ) => {
        const apply = async () => {
          if (!current()) throw new WorkbenchSessionError("stale-command");
          const applied = await this.page.apply(
            input,
            command.document_generation,
            current,
          );
          if (this.wire)
            this.activity.applied(
              input,
              this.wire,
              applied,
              human ? "human" : "agent",
            );
          if (input.kind === "stop") {
            this.policy.finish();
            this.stateValue = "finished";
            if (!this.production)
              this.activity.close(
                this.publishedOutcome ?? {
                  kind: "retained",
                  code:
                    input.reason === "cancel"
                      ? "browser-flow-cancelled"
                      : input.reason === "budget"
                        ? "browser-flow-budget-exhausted"
                        : "exhausted",
                },
              );
            this.stopResult =
              input.reason === "budget"
                ? "budget"
                : input.reason === "cancel"
                  ? "cancelled"
                  : "stopped";
            this.wake();
            this.execution?.controlEpochChanged();
          }
        };
        if (human)
          await this.control.dispatchOperator(
            clientId,
            command.control_epoch,
            input,
            observation,
            apply,
          );
        else
          await this.control.dispatch(
            clientId,
            command.control_epoch,
            parseBrowserAction(input),
            observation,
            apply,
          );
      };
      const action = this.loop
        ? this.loop.apply(request, applyInput)
        : this.applySharedCommand(clientId, command, applyInput);
      this.actionPromise = action;
      const result = await action;
      if (human && result === "applied")
        this.recordAgentEvent({
          kind: "human-action",
          action: command.input.kind,
          outcome: "applied",
          control_epoch: command.control_epoch,
        });
      return result;
    } finally {
      this.actionPromise = undefined;
      this.busy = false;
    }
  }

  private async applySharedCommand(
    clientId: string,
    command: WorkbenchActionCommand,
    apply: (
      input: import("@sciretriever/contracts").OperatorInput,
    ) => Promise<void>,
  ): Promise<"applied" | "duplicate"> {
    const key = JSON.stringify([clientId, command.request_id]);
    const digest = JSON.stringify(command);
    const previous = this.sharedCommands.get(key);
    if (previous) {
      if (previous.digest !== digest)
        throw new WorkbenchSessionError("stale-command");
      await previous.completion;
      return "duplicate";
    }
    if (this.sharedCommands.size >= 4096)
      throw new WorkbenchSessionError("session-busy");
    const completion = Promise.resolve().then(() => apply(command.input));
    this.sharedCommands.set(key, { digest, completion });
    await completion;
    return "applied";
  }
  /** A capture may settle before its already-dispatched click returns. */
  async settleActions(): Promise<void> {
    await this.actionPromise?.catch(() => undefined);
  }

  /**
   * Apply the automatic Agent's post-action hand-off. The internal wait uses the
   * same ExecutionLoop and page guard as the model action, so navigation/challenge
   * reactions are observed before the next model request. Human commands never call
   * this helper.
   */
  private async paceAgentAction(
    input: BrowserAction,
    observation: WorkbenchObservation,
    epoch: number,
    signal: AbortSignal,
  ): Promise<"ready" | "cancelled" | "budget"> {
    if (input.kind === "stop" || this.candidates.size > 0) return "ready";
    if (
      this.policy.remaining().actions > 0 &&
      input.kind !== "wait-for-change"
    ) {
      const waitInput: BrowserAction = {
        kind: "wait-for-change",
        timeout_ms:
          observation.page_state === "CHALLENGE" &&
          (input.kind === "click-point" || input.kind === "click-element")
            ? DEFAULT_BROWSER_AGENT_CHALLENGE_WAIT_MS
            : DEFAULT_BROWSER_AGENT_WAIT_FOR_CHANGE_MS,
        revision: observation.observation_revision,
      };
      try {
        await this.execute(
          this.agentId,
          {
            session_id: observation.session_id,
            page_id: observation.page_id,
            document_generation: observation.document_generation,
            observation_revision: observation.observation_revision,
            viewport_revision: observation.viewport_revision,
            control_epoch: epoch,
            request_id: `agent-wait-${randomUUID()}`,
            input: waitInput,
          },
          false,
        );
      } catch (error) {
        if (signal.aborted) return "cancelled";
        if (error instanceof ExecutionPolicyError) return "budget";
        throw error;
      }
    }
    if (this.candidates.size > 0) return "ready";
    // Once the action budget is exhausted there cannot be another model decision,
    // so do not spend a final delay after the final permitted page action.
    if (this.policy.remaining().actions === 0) return "ready";
    const cooled = await waitForBrowserAgentCooldown(
      DEFAULT_BROWSER_AGENT_ACTION_COOLDOWN_MS,
      signal,
    );
    if (cooled) return "ready";
    return signal.aborted
      ? this.policy.remaining().deadline_ms === 0
        ? "budget"
        : "cancelled"
      : "cancelled";
  }

  runAgent(clientId: string, epoch: number): Promise<void> {
    if (this.execution) throw new WorkbenchSessionError("stale-command");
    this.human(clientId);
    this.live();
    this.control.assertController(clientId, epoch);
    if (!this.decide && !this.capability) {
      this.errorValue = "model-unavailable";
      throw new WorkbenchSessionError("model-unavailable");
    }
    if (
      this.agentPromise ||
      this.busy ||
      this.refreshPromise ||
      !this.wire ||
      this.policy.state() !== "running"
    )
      throw new WorkbenchSessionError("session-busy");
    this.control.release(clientId, epoch);
    const lease = this.control.takeover(this.agentId);
    const abort = new AbortController();
    this.agentAbort = abort;
    const observation = this.view().observation!;
    const decide = this.decide;
    this.stateValue = "agent-running";
    this.agentPromise = (async () => {
      try {
        let input: BrowserAction | undefined;
        const execute = async (action: BrowserAction) => {
          if (
            abort.signal.aborted ||
            this.control.state().epoch !== lease.epoch
          )
            throw new WorkbenchSessionError("stale-command");
          await this.execute(
            this.agentId,
            parseWorkbenchActionCommand({
              session_id: this.id,
              page_id: observation.page_id,
              document_generation: observation.document_generation,
              observation_revision: observation.observation_revision,
              viewport_revision: observation.viewport_revision,
              control_epoch: lease.epoch,
              request_id: `request-${randomUUID()}`,
              input: action,
            }),
            false,
          );
          input = action;
        };
        if (this.capability) {
          const agent = await this.openAgentSession();
          let accepted = false;
          await agent.run(
            {
              observation,
              frame: this.frame(observation.frame_seq),
              admitRequest: (_request, signal) => ({
                onDispatched: () => {
                  if (
                    signal.aborted ||
                    this.control.state().epoch !== lease.epoch
                  )
                    throw new WorkbenchSessionError("stale-command");
                  this.policy.consume("model_call");
                },
              }),
              executeAction: async (action) => {
                if (
                  abort.signal.aborted ||
                  this.control.state().epoch !== lease.epoch
                )
                  return {
                    status: "cancelled",
                    code: "browser-action-revoked",
                  };
                if (accepted)
                  return {
                    status: "rejected",
                    code: "browser-action-batch-limit",
                  };
                accepted = true;
                try {
                  await execute(action);
                  return { status: "success", code: "browser-action-applied" };
                } catch {
                  return {
                    status: "rejected",
                    code: "browser-action-rejected",
                  };
                }
              },
            },
            abort.signal,
          );
        } else {
          this.policy.consume("model_call");
          const result = await decide!(
            observation,
            this.frame(observation.frame_seq),
            abort.signal,
          );
          if (
            abort.signal.aborted ||
            this.control.state().epoch !== lease.epoch
          )
            return;
          await execute(parseBrowserAction(result));
        }
        if (
          !input ||
          abort.signal.aborted ||
          this.control.state().epoch !== lease.epoch
        )
          return;
        await this.paceAgentAction(
          input,
          observation,
          lease.epoch,
          abort.signal,
        );
      } catch {
        if (
          !abort.signal.aborted &&
          this.control.state().epoch === lease.epoch
        ) {
          this.stateValue = "needs-assistance";
          this.errorValue = "stale-command";
        }
      } finally {
        if (
          this.control.state().controller_id === this.agentId &&
          this.control.state().epoch === lease.epoch
        )
          this.control.release(this.agentId, lease.epoch);
        if (this.stateValue === "agent-running") this.stateValue = "watching";
      }
    })();
    return this.agentPromise.finally(() => {
      this.agentPromise = undefined;
      this.agentAbort = undefined;
    });
  }
  /** One production decision point on the same page used by the article flow. */
  async runAutomaticStep(
    signal: AbortSignal,
  ): Promise<
    "applied" | "retry" | "stopped" | "budget" | "cancelled" | "invalid-action"
  > {
    if (this.execution) {
      if (signal.aborted) return "cancelled";
      const step = await this.execution.step();
      if (step.kind === "candidate") return "stopped";
      if (step.kind !== "terminal") return "retry";
      if (step.result.kind === "exhausted") return "stopped";
      return step.result.code === "browser-flow-budget-exhausted"
        ? "budget"
        : step.result.code === "browser-flow-cancelled"
          ? "cancelled"
          : "invalid-action";
    }
    if (!this.production) throw new WorkbenchSessionError("stale-command");
    if (signal.aborted || this.policy.state() === "cancelled")
      return "cancelled";
    if (this.stopResult) return this.stopResult;
    if (this.policy.remaining().deadline_ms === 0) return "budget";
    if (
      this.policy.remaining().actions === 0 ||
      this.policy.remaining().model_calls === 0
    )
      return "budget";
    if (
      this.control.state().controller_id !== null ||
      this.policy.state() === "paused"
    ) {
      await this.waitForChange(signal);
      return signal.aborted
        ? "cancelled"
        : (this.stopResult ??
            (this.policy.remaining().deadline_ms === 0 ? "budget" : "retry"));
    }
    if (!this.decide) throw new WorkbenchSessionError("model-unavailable");
    const expectedEpoch = this.control.state().epoch;
    const successor = await this.page.successor?.();
    if (successor) {
      this.page = successor;
      this.current = undefined;
      this.wire = null;
    }
    await this.refresh();
    if (this.observationPending) {
      await waitForBrowserAgentCooldown(
        DEFAULT_BROWSER_AGENT_ACTION_COOLDOWN_MS,
        signal,
      );
      return signal.aborted ? "cancelled" : "retry";
    }
    if (signal.aborted || this.policy.state() === "cancelled")
      return "cancelled";
    if (this.stopResult) return this.stopResult;
    if (this.policy.remaining().deadline_ms === 0) return "budget";
    if (
      this.policy.state() !== "running" ||
      this.control.state().controller_id !== null ||
      this.control.state().epoch !== expectedEpoch
    )
      return "retry";
    const observed = this.view().observation;
    if (
      !observed ||
      this.errorValue === "browser-failed" ||
      observed.session_id !== this.id ||
      observed.article_id !== this.articleId ||
      observed.page_id !== this.page.id ||
      observed.control_epoch !== expectedEpoch
    )
      throw new WorkbenchSessionError("browser-failed");
    const lease = this.control.takeover(this.agentId);
    const abort = new AbortController();
    const onAbort = () => abort.abort();
    signal.addEventListener("abort", onAbort, { once: true });
    const deadlineTimer = setTimeout(
      onAbort,
      this.policy.remaining().deadline_ms,
    );
    this.agentAbort = abort;
    this.stateValue = "agent-running";
    try {
      try {
        this.policy.consume("model_call");
      } catch (error) {
        if (error instanceof ExecutionPolicyError) return "budget";
        throw error;
      }
      const guidance = [...this.guidance.values()]
        .filter((item) => item.state === "accepted")
        .map((item) => {
          this.guidance.set(item.guidance_id, { ...item, state: "consumed" });
          return item.text;
        });
      const decision = this.decide(
        this.view().observation ?? observed,
        this.frame(observed.frame_seq),
        abort.signal,
        guidance,
      );
      // A model adapter may ignore AbortSignal. Revoke the decision promptly and
      // observe the page anew after a human takeover; its late result is discarded.
      const result = await Promise.race([
        decision.then((value) => ({ kind: "result" as const, value })),
        new Promise<{ kind: "aborted" }>((resolve) => {
          if (abort.signal.aborted) resolve({ kind: "aborted" });
          else
            abort.signal.addEventListener(
              "abort",
              () => resolve({ kind: "aborted" }),
              { once: true },
            );
        }),
      ]);
      if (
        result.kind === "aborted" ||
        signal.aborted ||
        this.control.state().epoch !== lease.epoch
      )
        return signal.aborted
          ? "cancelled"
          : this.policy.remaining().deadline_ms === 0
            ? "budget"
            : "retry";
      let input;
      try {
        input = parseBrowserAction(result.value);
      } catch {
        return "invalid-action";
      }
      try {
        await this.execute(
          this.agentId,
          {
            session_id: observed.session_id,
            page_id: observed.page_id,
            document_generation: observed.document_generation,
            observation_revision: observed.observation_revision,
            viewport_revision: observed.viewport_revision,
            control_epoch: lease.epoch,
            request_id: `agent-${randomUUID()}`,
            input,
          },
          false,
        );
        const paced = await this.paceAgentAction(
          input,
          observed,
          lease.epoch,
          abort.signal,
        );
        if (paced === "cancelled")
          return signal.aborted
            ? "cancelled"
            : this.policy.remaining().deadline_ms === 0
              ? "budget"
              : "retry";
        if (paced === "budget") return "budget";
      } catch (error) {
        if (signal.aborted) return "cancelled";
        if (error instanceof ExecutionPolicyError) return "budget";
        if (
          this.control.state().epoch !== lease.epoch ||
          (error instanceof WorkbenchSessionError &&
            ["stale-command", "session-busy"].includes(error.code))
        )
          return "retry";
        throw error;
      }
      return input.kind === "stop" ? (this.stopResult ?? "stopped") : "applied";
    } finally {
      clearTimeout(deadlineTimer);
      signal.removeEventListener("abort", onAbort);
      if (this.agentAbort === abort) this.agentAbort = undefined;
      if (
        this.control.state().controller_id === this.agentId &&
        this.control.state().epoch === lease.epoch
      )
        this.control.release(this.agentId, lease.epoch);
      if (this.stateValue === "agent-running") this.stateValue = "watching";
      this.wake();
    }
  }
  private async waitForChange(signal: AbortSignal): Promise<void> {
    const waitMs = Math.min(300_000, this.policy.remaining().deadline_ms);
    if (waitMs <= 0 || signal.aborted) return;
    await new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", finish);
        this.waiters.delete(finish);
        resolve();
      };
      const timer = setTimeout(finish, waitMs);
      this.waiters.add(finish);
      signal.addEventListener("abort", finish, { once: true });
    });
  }
  finishProduction(outcome: "finished" | "failed" | "cancelled"): void {
    this.expireGuidance();
    if (this.production) {
      this.invalidateAgent();
      const control = this.control.state();
      if (control.controller_id)
        this.control.release(control.controller_id, control.epoch);
      if (outcome === "cancelled") this.policy.cancel();
      if (this.stateValue !== "cancelled") this.stateValue = outcome;
      this.wake();
    }
  }
  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.invalidateAgent();
    this.publicationAbort?.abort();
    this.abandonmentAbort?.abort();
    this.policy.cancel();
    this.stateValue = "cancelled";
    if (!this.production)
      this.activity.close(this.publishedOutcome ?? { kind: "cancelled" });
    this.expireGuidance();
    this.wake();
    this.closePromise = (async () => {
      await this.publicationPromise?.catch(() => undefined);
      await this.abandonmentPromise?.catch(() => undefined);
      await this.refreshPromise;
      const errors: unknown[] = [];
      try {
        await (this.closePage ? this.closePage() : this.page.close());
      } catch (error) {
        errors.push(error);
      }
      try {
        await this.agentSession?.close();
      } catch (error) {
        errors.push(error);
      }
      await this.agentPromise?.catch(() => undefined);
      this.pendingAgentEvents.length = 0;
      if (errors.length)
        throw new AggregateError(errors, "Workbench session cleanup failed");
    })();
    return this.closePromise;
  }
}
