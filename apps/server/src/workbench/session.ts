import { randomUUID } from "node:crypto";
import {
  parseBrowserAction,
  parseWorkbenchActionCommand,
  parseWorkbenchObservation,
  type WorkbenchActionCommand,
  type WorkbenchObservation,
  type WorkbenchView,
  type WorkbenchCandidate,
  type CandidatePublicationReceipt,
} from "@sciretriever/contracts";
import { BrowserControlCoordinator } from "../browser/control.js";
import {
  BrowserObservationStore,
  type BrowserCaptureState,
  type BrowserObservation,
} from "../browser/observation.js";
import type { BrowserPageHandle } from "../browser/host.js";
import { ExecutionLoop } from "../acquisition/execution-loop.js";
import {
  ExecutionPolicy,
  type ExecutionBudget,
} from "../acquisition/execution-policy.js";

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
export type BrowserDecision = (
  observation: WorkbenchObservation,
  frame: Uint8Array | null,
  signal: AbortSignal,
) => Promise<unknown>;

/** One fixed article, one page, one command executor. Viewer transport owns no Browser resources. */
export class WorkbenchSession {
  readonly id: string;
  private readonly control: BrowserControlCoordinator;
  private readonly observations = new BrowserObservationStore();
  private readonly policy: ExecutionPolicy;
  private readonly loop: ExecutionLoop;
  private readonly humans = new Set<string>();
  private readonly candidates = new Map<string, WorkbenchCandidate>();
  private readonly agentId = `agent-${randomUUID()}`;
  private current: BrowserObservation | undefined;
  private wire: WorkbenchObservation | null = null;
  private observedAt = "";
  private stateValue: WorkbenchSessionState = "watching";
  private errorValue: WorkbenchSessionError["code"] | null = null;
  private busy = false;
  private refreshPromise: Promise<void> | undefined;
  private agentAbort: AbortController | undefined;
  private agentPromise: Promise<void> | undefined;
  private closePromise: Promise<void> | undefined;
  private publicationAbort: AbortController | undefined;
  private publicationPromise: Promise<void> | undefined;
  private abandonmentAbort: AbortController | undefined;
  private abandonmentPromise: Promise<void> | undefined;
  private captureStateValue: BrowserCaptureState = "NONE";

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
  ) {
    if (!/^[a-zA-Z0-9._:-]{1,128}$/u.test(articleId))
      throw new WorkbenchSessionError("stale-command");
    this.id = id;
    this.control = new BrowserControlCoordinator(id);
    this.control.attach({
      client_id: this.agentId,
      workspace_id: id,
      role: "agent",
    });
    this.policy = new ExecutionPolicy("browser:generic", "published", budget);
    this.loop = new ExecutionLoop(
      this.policy,
      () => this.control.state().epoch,
    );
  }
  /** Switch the active tab while retaining the session's article and control lease. */
  async activatePage(page: BrowserPageHandle): Promise<void> {
    this.live();
    if (this.busy || this.agentPromise || this.refreshPromise)
      throw new WorkbenchSessionError("session-busy");
    if (!page || typeof page.id !== "string")
      throw new WorkbenchSessionError("stale-command");
    await page.activate?.();
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
      this.articleId = articleId;
      this.current = undefined;
      this.wire = null;
      this.captureStateValue = "NONE";
      this.errorValue = null;
      this.stateValue = "watching";
    } finally {
      this.busy = false;
    }
  }
  attach(): string {
    if (this.humans.size >= 16 || this.closePromise)
      throw new WorkbenchSessionError("session-closed");
    const id = `client-${randomUUID()}`;
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
    if (this.control.state().controller_id === clientId)
      this.publicationAbort?.abort();
    if (this.control.state().controller_id === clientId)
      this.abandonmentAbort?.abort();
    this.humans.delete(clientId);
    this.control.detach(clientId);
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
  }
  release(clientId: string, epoch: number): void {
    this.human(clientId);
    this.control.release(clientId, epoch);
    this.publicationAbort?.abort();
    this.abandonmentAbort?.abort();
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
  }
  resume(clientId: string, epoch: number): void {
    this.human(clientId);
    this.live();
    this.control.assertController(clientId, epoch);
    this.policy.resume();
    this.stateValue = "watching";
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
    this.control.release(clientId, this.control.state().epoch);
  }
  view(): WorkbenchView {
    const control = this.control.state();
    return Object.freeze({
      candidates: [...this.candidates.values()],
      session_id: this.id,
      article_id: this.articleId,
      state: this.stateValue,
      control: { ...control, viewers: this.humans.size },
      model_ready: !!this.decide,
      error: this.errorValue,
      observation: this.wire
        ? {
            ...this.wire,
            control_epoch: control.epoch,
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
    this.candidates.set(candidate.transfer_id, Object.freeze({ ...candidate }));
    this.captureStateValue = "CAPTURED";
  }
  transferStarted(): void {
    if (!this.closePromise) this.captureStateValue = "CANDIDATE";
  }
  transferFailed(): void {
    if (!this.closePromise && this.captureStateValue !== "CAPTURED")
      this.captureStateValue = "NONE";
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
      this.current = observation;
      this.errorValue = null;
      if (this.stateValue === "watching" && observation.page_state !== "NORMAL")
        this.stateValue = "needs-assistance";
    } catch {
      this.errorValue = "browser-failed";
      // Retain the last intact frame; transient navigation/screenshot failure is recoverable.
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
      return await this.loop.apply(
        {
          client_id: clientId,
          epoch: command.control_epoch,
          request_id: command.request_id,
          observation,
          action: command.input,
        },
        async (input) => {
          const apply = async () => {
            if (!current()) throw new WorkbenchSessionError("stale-command");
            await this.page.apply(input, command.document_generation, current);
            if (input.kind === "stop") {
              this.policy.finish();
              this.stateValue = "finished";
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
        },
      );
    } finally {
      this.busy = false;
    }
  }
  runAgent(clientId: string, epoch: number): Promise<void> {
    this.human(clientId);
    this.live();
    this.control.assertController(clientId, epoch);
    if (!this.decide) {
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
        this.policy.consume("model_call");
        const result = await decide(
          observation,
          this.frame(observation.frame_seq),
          abort.signal,
        );
        if (abort.signal.aborted || this.control.state().epoch !== lease.epoch)
          return;
        const input = parseBrowserAction(result);
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
            input,
          }),
          false,
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
  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.invalidateAgent();
    this.publicationAbort?.abort();
    this.abandonmentAbort?.abort();
    this.policy.cancel();
    this.stateValue = "cancelled";
    this.closePromise = (async () => {
      await this.publicationPromise?.catch(() => undefined);
      await this.abandonmentPromise?.catch(() => undefined);
      await this.refreshPromise;
      await (this.closePage ? this.closePage() : this.page.close());
    })();
    return this.closePromise;
  }
}
