import { randomUUID } from "node:crypto";
import {
  parseLiteratureId,
  type CompletionTarget,
  type DatabaseCompletionReport,
  type LiteratureId,
  type StableFailure,
  type WorkbenchCandidate,
  type WorkbenchOperationFeedback,
  type WorkbenchView,
} from "@sciretriever/contracts";
import type { BrowserDeliveryRequest } from "../browser/boundary.js";
import type {
  FlowPageHandle,
  CollaborativeStepResult,
} from "../browser/article-flow.js";
import type { BrowserPageHandle } from "../browser/host.js";
import { classifyAcquisitionFailure } from "../acquisition/tiered.js";
import type { DatabaseCompletionProgress } from "../entry/database-completion.js";
import type { BrowserDecision } from "./session.js";
import { WorkbenchSession, WorkbenchSessionError } from "./session.js";

/** In-process projection of one explicit completion operation onto its owned Browser page. */
export class ProductionWorkbenchSession {
  private readonly clients = new Set<string>();
  private session: WorkbenchSession | undefined;
  private articleId: string;
  private sessionId = `session-${randomUUID()}`;
  private operation: Promise<void> | undefined;
  private operationAbort: AbortController | undefined;
  private operationState: WorkbenchView["state"] = "watching";
  private phase: WorkbenchOperationFeedback["phase"] = "idle";
  private report: DatabaseCompletionReport | null = null;
  private failure: StableFailure | null = null;
  private failureCause: Error | null = null;
  private scopeKnown = false;
  private readonly targetStates = new Map<
    string,
    "not-started" | DatabaseCompletionProgress["state"]
  >();
  private currentTarget: LiteratureId | null = null;
  private primaryPdf: WorkbenchOperationFeedback["primary_pdf"] = null;
  private primaryPdfStatus: WorkbenchOperationFeedback["primary_pdf_status"] =
    "unchecked";
  private readonly pendingCandidates = new Map<string, WorkbenchCandidate>();
  private closed = false;

  constructor(
    initialArticleId: string,
    private readonly decide: BrowserDecision,
  ) {
    this.articleId = parseLiteratureId(initialArticleId);
  }

  private startOperation:
    | ((
        articleId: string,
        signal: AbortSignal,
        feedback: {
          scope(targets: readonly CompletionTarget[]): void;
          progress(progress: DatabaseCompletionProgress): void;
        },
      ) => Promise<DatabaseCompletionReport>)
    | undefined;
  private readPrimaryPdf:
    | ((
        articleId: string,
      ) => Promise<WorkbenchOperationFeedback["primary_pdf"]>)
    | undefined;
  bindOperation(
    run: (
      articleId: string,
      signal: AbortSignal,
      feedback: {
        scope(targets: readonly CompletionTarget[]): void;
        progress(progress: DatabaseCompletionProgress): void;
      },
    ) => Promise<DatabaseCompletionReport>,
    readPrimaryPdf?: (
      articleId: string,
    ) => Promise<WorkbenchOperationFeedback["primary_pdf"]>,
  ): void {
    if (this.startOperation) throw new WorkbenchSessionError("session-busy");
    this.startOperation = run;
    this.readPrimaryPdf = readPrimaryPdf;
  }
  start(articleId: string): void {
    if (this.closed || !this.startOperation)
      throw new WorkbenchSessionError("session-closed");
    if (this.operation) throw new WorkbenchSessionError("session-busy");
    this.articleId = parseLiteratureId(articleId);
    this.sessionId = `session-${randomUUID()}`;
    this.session?.finishProduction("finished");
    this.session = undefined;
    this.operationState = "agent-running";
    this.phase = "acquiring";
    this.report = null;
    this.failure = null;
    this.failureCause = null;
    this.scopeKnown = false;
    this.targetStates.clear();
    this.currentTarget = null;
    this.primaryPdf = null;
    this.primaryPdfStatus = "unchecked";
    this.pendingCandidates.clear();
    const abort = new AbortController();
    this.operationAbort = abort;
    const run = this.startOperation;
    const pending = Promise.resolve().then(() =>
      run(this.articleId, abort.signal, {
        scope: (targets) => this.recordScope(targets),
        progress: (progress) => this.recordProgress(progress),
      }),
    );
    let terminalState: WorkbenchView["state"] = "failed";
    this.operation = pending
      .then(
        (report) => {
          this.report = report;
          this.failure =
            report.end.kind === "failed"
              ? report.end.failure
              : (report.failed[0]?.failure ?? null);
          terminalState =
            abort.signal.aborted || report.end.kind === "interrupted"
              ? "cancelled"
              : report.failed.length ||
                  report.notStarted.length ||
                  report.interrupted.length ||
                  report.skipped.some(
                    (item) => item.reason !== "already-satisfied",
                  ) ||
                  report.end.kind === "failed"
                ? "failed"
                : "finished";
          this.phase = "settling";
        },
        (error: unknown) => {
          const kind = classifyAcquisitionFailure(error, abort.signal);
          this.failureCause = new Error("Production PDF completion failed", {
            cause: error,
          });
          this.failure = {
            code:
              kind === "cancel"
                ? "completion-cancelled"
                : `completion-${kind}-failed`,
            reason:
              kind === "cancel"
                ? "The PDF operation was cancelled before a completion report was produced."
                : "The PDF operation could not produce a completion report.",
            action:
              "Inspect existing Library facts and the operation boundary before retrying.",
            retryable: kind === "route",
          };
          this.scopeKnown = false;
          this.targetStates.clear();
          this.currentTarget = null;
          terminalState = abort.signal.aborted ? "cancelled" : "failed";
          this.phase = "settling";
        },
      )
      .then(async () => {
        try {
          this.primaryPdf =
            (await this.readPrimaryPdf?.(this.articleId)) ?? null;
          this.primaryPdfStatus = this.primaryPdf ? "verified" : "missing";
        } catch (error) {
          const readFailure = new Error(
            "Library primary PDF verification failed",
            {
              cause: error,
            },
          );
          this.failureCause = this.failureCause
            ? new AggregateError(
                [this.failureCause, readFailure],
                "Production PDF operation and Library verification failed",
              )
            : readFailure;
          this.primaryPdfStatus = "unreadable";
          this.failure ??= {
            code: "library-read-unavailable",
            reason:
              "The committed primary PDF could not be checked through Library.",
            action: "Refresh Library before retrying acquisition.",
            retryable: true,
          };
          if (terminalState === "finished") terminalState = "failed";
        }
        if (terminalState === "finished" && !this.primaryPdf) {
          this.failure = {
            code: "primary-pdf-unconfirmed",
            reason:
              "The completion report finished without a readable primary PDF.",
            action: "Inspect Library facts before retrying acquisition.",
            retryable: true,
          };
          terminalState = "failed";
        }
        this.operationState =
          abort.signal.aborted || this.operationState === "cancelled"
            ? "cancelled"
            : terminalState;
        this.phase = "ended";
        this.session?.finishProduction(
          this.operationState === "cancelled"
            ? "cancelled"
            : this.operationState === "finished"
              ? "finished"
              : "failed",
        );
      })
      .finally(() => {
        if (this.operationAbort === abort) this.operationAbort = undefined;
        if (this.operation === completed) this.operation = undefined;
      });
    const completed = this.operation;
  }

  /** In-memory causal error for the owning process; never serialized to a viewer. */
  operationFailure(): Error | null {
    return this.failureCause;
  }
  private targetKey(target: CompletionTarget): string {
    return target.kind === "literature"
      ? `literature:${target.literature_id}`
      : `meta-literature:${target.meta_literature_id}`;
  }
  private recordScope(targets: readonly CompletionTarget[]): void {
    this.scopeKnown = true;
    this.targetStates.clear();
    for (const target of targets)
      this.targetStates.set(this.targetKey(target), "not-started");
  }
  private recordProgress(progress: DatabaseCompletionProgress): void {
    const key = this.targetKey(progress.target);
    if (!this.scopeKnown || !this.targetStates.has(key)) return;
    this.targetStates.set(key, progress.state);
    if (progress.state === "started")
      this.currentTarget = progress.literature_id;
    else this.currentTarget = null;
  }
  private targetCounts(): WorkbenchOperationFeedback["targets"] {
    if (this.report)
      return {
        total:
          this.report.completed.length +
          this.report.failed.length +
          this.report.skipped.length +
          this.report.notStarted.length +
          this.report.interrupted.length,
        running: 0,
        completed: this.report.completed.length,
        failed: this.report.failed.length,
        skipped: this.report.skipped.length,
        interrupted: this.report.interrupted.length,
        not_started: this.report.notStarted.length,
      };
    const states = [...this.targetStates.values()];
    return {
      total: this.scopeKnown ? states.length : null,
      running: states.filter((state) => state === "started").length,
      completed: states.filter((state) => state === "completed").length,
      failed: states.filter((state) => state === "failed").length,
      skipped: states.filter((state) => state === "skipped").length,
      interrupted: states.filter((state) => state === "interrupted").length,
      not_started: states.filter((state) => state === "not-started").length,
    };
  }

  async open(
    request: BrowserDeliveryRequest,
    page: FlowPageHandle,
    deadlineAt: number,
  ): Promise<{
    step(signal: AbortSignal): Promise<CollaborativeStepResult>;
    beforeClose(): Promise<void>;
    close(failed: boolean): void;
  }> {
    if (
      this.closed ||
      this.operationAbort?.signal.aborted ||
      request.literature_id !== this.articleId ||
      typeof (page as BrowserPageHandle).id !== "string"
    )
      throw new WorkbenchSessionError("stale-command");
    const session = new WorkbenchSession(
      this.articleId,
      page as BrowserPageHandle,
      {
        max_actions: 24,
        max_model_calls: 12,
        max_retries: 24,
        max_bytes: 16 * 1024 * 1024,
        deadline_ms: Math.max(1, deadlineAt - Date.now()),
      },
      this.decide,
      this.sessionId,
      async () => {},
      undefined,
      undefined,
      undefined,
      true,
    );
    for (const client of this.clients) session.attach(client);
    for (const candidate of this.pendingCandidates.values())
      session.candidateReady(candidate);
    this.session = session;
    this.phase = "browser";
    await session.refresh();
    return {
      step: (signal) => session.runAutomaticStep(signal),
      beforeClose: () => session.settleActions(),
      close: (failed) => {
        this.phase = "settling";
        session.finishProduction(
          this.operationAbort?.signal.aborted
            ? "cancelled"
            : failed
              ? "failed"
              : "finished",
        );
      },
    };
  }
  captured(articleId: string, candidate?: WorkbenchCandidate): void {
    if (articleId !== this.articleId) return;
    if (candidate) {
      this.pendingCandidates.set(candidate.transfer_id, candidate);
      this.session?.candidateReady(candidate);
    }
    // A human may still hold control while the driver waits; capture must wake it.
    this.session?.notifyCapture();
  }
  async waitForCompletion(): Promise<WorkbenchView> {
    await this.operation;
    return this.view();
  }
  attach(): string {
    if (this.closed || this.clients.size >= 16)
      throw new WorkbenchSessionError("session-closed");
    const id = `client-${randomUUID()}`;
    this.clients.add(id);
    this.session?.attach(id);
    return id;
  }
  detach(clientId: string): void {
    if (!this.clients.delete(clientId))
      throw new WorkbenchSessionError("stale-command");
    this.session?.detach(clientId);
  }
  view(): WorkbenchView {
    const operation_feedback: WorkbenchOperationFeedback = {
      phase: this.phase,
      targets: this.targetCounts(),
      current_target: this.currentTarget,
      report: this.report,
      failure: this.failure,
      primary_pdf_status: this.primaryPdfStatus,
      primary_pdf: this.primaryPdf,
    };
    if (this.session) {
      const view = this.session.view();
      if (this.phase === "ended")
        return { ...view, state: this.operationState, operation_feedback };
      if (this.operationState === "cancelled")
        return {
          ...view,
          state: "cancelled",
          observation: null,
          operation_feedback,
        };
      return this.operation && ["finished", "failed"].includes(view.state)
        ? {
            ...view,
            state: "agent-running",
            observation: null,
            operation_feedback,
          }
        : { ...view, operation_feedback };
    }
    return {
      mode: "production",
      candidates: [],
      guidance: [],
      session_id: this.sessionId,
      article_id: this.articleId,
      state: this.operationState,
      control: {
        workspace_id: this.sessionId,
        viewers: this.clients.size,
        controller_id: null,
        epoch: 0,
      },
      observation: null,
      model_ready: true,
      error: null,
      operation_feedback,
    };
  }
  frame(sequence: number): Uint8Array | null {
    return this.session?.frame(sequence) ?? null;
  }
  refresh(): Promise<void> {
    return this.session?.refresh() ?? Promise.resolve();
  }
  private active(): WorkbenchSession {
    if (!this.session) throw new WorkbenchSessionError("session-busy");
    return this.session;
  }
  assertBinding(
    clientId: string,
    sessionId: unknown,
    articleId: unknown,
  ): void {
    if (
      !this.clients.has(clientId) ||
      sessionId !== this.sessionId ||
      articleId !== this.articleId
    )
      throw new WorkbenchSessionError("stale-command");
  }
  command(clientId: string, value: unknown) {
    return this.active().command(clientId, value);
  }
  takeover(clientId: string, epoch: number): void {
    this.active().takeover(clientId, epoch);
  }
  release(clientId: string, epoch: number): void {
    this.active().release(clientId, epoch);
  }
  pause(clientId: string, epoch: number): void {
    this.active().pause(clientId, epoch);
  }
  resume(clientId: string, epoch: number): void {
    this.active().resume(clientId, epoch);
  }
  cancel(clientId: string, epoch: number): void {
    if (!this.clients.has(clientId) || !this.operationAbort)
      throw new WorkbenchSessionError("session-closed");
    const current = this.session?.view();
    if (current && !["finished", "failed", "cancelled"].includes(current.state))
      this.session!.cancel(clientId, epoch);
    else if (epoch !== (current?.control.epoch ?? 0))
      throw new WorkbenchSessionError("stale-command");
    this.operationState = "cancelled";
    this.session?.finishProduction("cancelled");
    this.operationAbort.abort();
  }
  runAgent(_clientId: string, _epoch: number): Promise<void> {
    void _clientId;
    void _epoch;
    throw new WorkbenchSessionError("stale-command");
  }
  selectTarget(
    _clientId: string,
    _epoch: number,
    _articleId: string,
  ): Promise<void> {
    void _clientId;
    void _epoch;
    void _articleId;
    throw new WorkbenchSessionError("stale-command");
  }
  acceptCandidate(_clientId: string, _value: unknown): Promise<void> {
    void _clientId;
    void _value;
    throw new WorkbenchSessionError("stale-command");
  }
  abandonCandidate(_clientId: string, _value: unknown): Promise<void> {
    void _clientId;
    void _value;
    throw new WorkbenchSessionError("stale-command");
  }
  submitGuidance(clientId: string, value: unknown) {
    return this.active().submitGuidance(clientId, value);
  }
  cancelGuidance(clientId: string, value: unknown) {
    return this.active().cancelGuidance(clientId, value);
  }
  async close(): Promise<void> {
    this.closed = true;
    this.operationAbort?.abort();
    await this.operation;
  }
}
