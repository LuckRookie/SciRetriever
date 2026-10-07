import { randomUUID } from "node:crypto";
import {
  parseLiteratureId,
  type CompletionTarget,
  type DatabaseCompletionReport,
  type LiteratureId,
  type StableFailure,
  type WorkbenchArticlePhase,
  type WorkbenchCandidate,
  type WorkbenchOperationFeedback,
  type WorkbenchView,
} from "@sciretriever/contracts";
import type {
  BrowserDecisionTarget,
  BrowserDeliveryRequest,
} from "../browser/boundary.js";
import type {
  FlowPageHandle,
  CollaborativeStepResult,
  BrowserArticleAutomaticContext,
} from "../browser/article-flow.js";
import type {
  BrowserArticleExecution,
  BrowserArticleCloseOutcome,
  BrowserArticleSessionIdentity,
} from "../browser/article-session.js";
import type { BrowserPageHandle } from "../browser/host.js";
import { classifyAcquisitionFailure } from "../acquisition/tiered.js";
import type { DatabaseCompletionProgress } from "../entry/database-completion.js";
import type { BrowserDecision } from "./session.js";
import { WorkbenchSession, WorkbenchSessionError } from "./session.js";

interface ArticleProjection {
  readonly identity: BrowserArticleSessionIdentity;
  readonly cancel: () => void;
  session?: WorkbenchSession;
  execution?: BrowserArticleExecution;
  outcome: BrowserArticleCloseOutcome | null;
  cleanupFailure: string | null;
}

/** Projects the owning articles; a viewer's selection never determines capture ownership. */
export class ProductionWorkbenchSession {
  private readonly clients = new Set<string>();
  private readonly sessions = new Map<string, ArticleProjection>();
  private readonly selection = new Map<string, string>();
  private get session(): WorkbenchSession | undefined {
    return this.sessions.get(this.sessionId)?.session;
  }
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
  private readonly pendingCandidates = new Map<
    string,
    Map<string, WorkbenchCandidate>
  >();
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
    for (const [id, record] of this.sessions) {
      if (this.articlePhase(record) === "closed") {
        this.sessions.delete(id);
        this.pendingCandidates.delete(id);
        for (const [client, selected] of this.selection)
          if (selected === id) this.selection.delete(client);
      }
    }
    this.sessionId = `session-${randomUUID()}`;
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

  private articlePhase(record: ArticleProjection): WorkbenchArticlePhase {
    if (record.execution) return record.execution.phase();
    if (record.outcome) return "closed";
    if (!record.session) return "queued";
    return ["finished", "failed", "cancelled"].includes(
      record.session.view().state,
    )
      ? "closed"
      : "ready";
  }

  /** Mirrors Scheduler's queue membership; it owns no admission or work queue. */
  queued(identity: BrowserArticleSessionIdentity, cancel: () => void): void {
    const articleId = parseLiteratureId(identity.literature_id);
    if (this.closed || this.sessions.has(identity.session_id))
      throw new WorkbenchSessionError("stale-command");
    if (this.sessions.size >= 64) {
      const expired = [...this.sessions].find(
        ([, record]) => this.articlePhase(record) === "closed",
      );
      if (!expired) throw new WorkbenchSessionError("session-busy");
      this.sessions.delete(expired[0]);
      for (const [client, selected] of this.selection)
        if (selected === expired[0]) this.selection.delete(client);
    }
    const first = this.sessions.size === 0;
    this.sessions.set(identity.session_id, {
      identity: Object.freeze({
        ...identity,
        literature_id: articleId,
        metadata_snapshot: Object.freeze({ ...identity.metadata_snapshot }),
      }),
      cancel,
      outcome: null,
      cleanupFailure: null,
    });
    if (first || articleId === this.articleId)
      this.sessionId = identity.session_id;
    if (first)
      for (const client of this.clients)
        if (!this.selection.has(client))
          this.selection.set(client, identity.session_id);
  }

  registered(
    execution: BrowserArticleExecution,
    request: BrowserDeliveryRequest,
  ): { close(outcome: BrowserArticleCloseOutcome): void } {
    const identity = execution.identity;
    if (!this.sessions.has(identity.session_id))
      this.queued(identity, () => execution.cancel());
    const record = this.sessions.get(identity.session_id)!;
    if (
      this.closed ||
      request.signal.aborted ||
      record.execution ||
      record.outcome ||
      identity.literature_id !== request.literature_id ||
      record.identity.literature_id !== identity.literature_id ||
      record.identity.generation !== identity.generation ||
      record.identity.operation_id !== identity.operation_id ||
      record.identity.metadata_snapshot.revision !==
        identity.metadata_snapshot.revision ||
      record.identity.metadata_snapshot.sha256 !==
        identity.metadata_snapshot.sha256
    )
      throw new WorkbenchSessionError("stale-command");
    record.execution = execution;
    return {
      close: (outcome) => this.removed(identity.session_id, outcome),
    };
  }

  removed(sessionId: string, outcome: BrowserArticleCloseOutcome): void {
    const record = this.sessions.get(sessionId);
    if (!record) return;
    if (
      record.outcome &&
      outcome.kind === "retained" &&
      (record.outcome.kind !== "retained" ||
        record.outcome.code !== outcome.code)
    )
      record.cleanupFailure ??= outcome.code;
    record.outcome ??= Object.freeze({ ...outcome });
    record.session?.finishProduction(
      record.outcome.kind === "cancelled"
        ? "cancelled"
        : record.outcome.kind === "retained" &&
            record.outcome.code !== "delivered" &&
            record.outcome.code !== "exhausted"
          ? "failed"
          : "finished",
    );
    this.pendingCandidates.delete(sessionId);
  }

  async open(
    request: BrowserDeliveryRequest,
    page: FlowPageHandle,
    deadlineAt: number,
    execution?: BrowserArticleExecution,
  ): Promise<{
    step(signal: AbortSignal): Promise<CollaborativeStepResult>;
    automatic?: BrowserArticleAutomaticContext;
    beforeClose(outcome?: BrowserArticleCloseOutcome): Promise<void>;
    close(failed: boolean, outcome?: BrowserArticleCloseOutcome): void;
  }> {
    const articleId = parseLiteratureId(request.literature_id);
    const id = execution?.session_id ?? this.sessionId;
    let record = this.sessions.get(id);
    if (
      this.closed ||
      request.signal?.aborted ||
      typeof (page as BrowserPageHandle).id !== "string" ||
      record?.session ||
      record?.outcome ||
      (record && record.identity.literature_id !== articleId) ||
      (execution && record?.execution && record.execution !== execution) ||
      (execution && execution.identity.literature_id !== articleId)
    )
      throw new WorkbenchSessionError("stale-command");
    if (!record) {
      this.queued(
        execution?.identity ?? {
          session_id: id,
          operation_id: request.operation_id ?? "standalone-browser-flow",
          generation: request.generation ?? 0,
          literature_id: articleId,
          metadata_snapshot: request.metadata_snapshot,
        },
        () => execution?.cancel(),
      );
      record = this.sessions.get(id)!;
    }
    const target: BrowserDecisionTarget = request.article_goal ?? {
      literature_id: articleId,
      identifier: request.identifier,
      version: request.version,
    };
    const session = new WorkbenchSession(
      articleId,
      page as BrowserPageHandle,
      {
        max_actions: execution?.clock.budget.max_actions ?? 100,
        max_model_calls: execution?.clock.budget.max_model_calls ?? 50,
        max_retries: 100,
        max_bytes: Number.MAX_SAFE_INTEGER,
        deadline_ms:
          execution?.clock.budget.active_ms ??
          Math.max(1, deadlineAt - Date.now()),
      },
      (observation, frame, signal, guidance) =>
        this.decide(observation, frame, signal, guidance, target),
      id,
      async () => {},
      undefined,
      undefined,
      undefined,
      true,
      execution,
    );
    record.session = session;
    if (execution) record.execution = execution;
    for (const client of this.clients) {
      session.attach(client);
    }
    for (const candidate of this.pendingCandidates.get(id)?.values() ?? [])
      session.candidateReady(candidate);
    this.pendingCandidates.delete(id);
    if (articleId === this.articleId) this.phase = "browser";
    await session.refresh();
    const finish = (failed: boolean, outcome?: BrowserArticleCloseOutcome) => {
      if (outcome) record.outcome ??= Object.freeze({ ...outcome });
      session.finishProduction(
        outcome?.kind === "cancelled" || request.signal?.aborted
          ? "cancelled"
          : failed
            ? "failed"
            : "finished",
      );
    };
    return {
      step: (signal) => session.runAutomaticStep(signal),
      ...(execution ? { automatic: session.automaticContext() } : {}),
      beforeClose: async (outcome) => {
        finish(
          outcome?.kind === "cancelled" ||
            (outcome?.kind === "retained" &&
              outcome.code !== "delivered" &&
              outcome.code !== "exhausted"),
          outcome,
        );
        await session.settleActions();
      },
      close: (failed, outcome) => {
        if (articleId === this.articleId) this.phase = "settling";
        finish(failed, outcome);
      },
    };
  }

  captured(
    articleId: string,
    candidate?: WorkbenchCandidate,
    sessionId?: string,
  ): void {
    const matching = [...this.sessions].filter(
      ([, record]) => record.identity.literature_id === articleId,
    );
    const id =
      sessionId ?? (matching.length === 1 ? matching[0]![0] : undefined);
    if (!id) return;
    const record = this.sessions.get(id);
    if (record && record.identity.literature_id !== articleId)
      throw new WorkbenchSessionError("stale-command");
    if (record?.outcome) return;
    if (!record?.session) {
      if (!candidate || this.pendingCandidates.size >= 64) return;
      const pending =
        this.pendingCandidates.get(id) ?? new Map<string, WorkbenchCandidate>();
      if (pending.size < 100) pending.set(candidate.transfer_id, candidate);
      this.pendingCandidates.set(id, pending);
      return;
    }
    if (candidate) record.session.candidateReady(candidate);
    record.session.notifyCapture();
  }

  selectSession(clientId: string, sessionId: unknown): void {
    if (
      !this.clients.has(clientId) ||
      typeof sessionId !== "string" ||
      !this.sessions.has(sessionId)
    )
      throw new WorkbenchSessionError("stale-command");
    this.selection.set(clientId, sessionId);
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
    for (const record of this.sessions.values()) record.session?.attach(id);
    if (this.sessions.size === 1)
      this.selection.set(id, this.sessions.keys().next().value!);
    return id;
  }
  detach(clientId: string): void {
    if (!this.clients.delete(clientId))
      throw new WorkbenchSessionError("stale-command");
    for (const record of this.sessions.values())
      record.session?.detach(clientId);
    this.selection.delete(clientId);
  }
  view(clientId?: string): WorkbenchView {
    const operation_feedback: WorkbenchOperationFeedback = {
      phase: this.phase,
      targets: this.targetCounts(),
      current_target: this.currentTarget,
      report: this.report,
      failure: this.failure,
      primary_pdf_status: this.primaryPdfStatus,
      primary_pdf: this.primaryPdf,
    };
    const selectedId =
      clientId === undefined ? this.sessionId : this.selection.get(clientId);
    const selected = selectedId ? this.sessions.get(selectedId) : undefined;
    const summaries = [...this.sessions].map(([id, record]) => ({
      session_id: id,
      article_id: record.identity.literature_id,
      generation: record.identity.generation,
      phase: this.articlePhase(record),
    }));
    if (selected?.session) {
      const view: WorkbenchView = {
        ...selected.session.view(),
        sessions: summaries,
        session_phase: this.articlePhase(selected),
        session_outcome: selected.outcome,
        ...(selected.cleanupFailure
          ? { session_cleanup_failure: selected.cleanupFailure }
          : {}),
      };
      if (view.article_id !== this.articleId) return view;
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
    const projectionId = selected?.identity.session_id ?? this.sessionId;
    const projectionArticleId =
      selected?.identity.literature_id ?? this.articleId;
    return {
      mode: "production",
      sessions: summaries,
      ...(selected
        ? {
            session_phase: this.articlePhase(selected),
            session_outcome: selected.outcome,
            ...(selected.cleanupFailure
              ? { session_cleanup_failure: selected.cleanupFailure }
              : {}),
          }
        : {}),
      candidates: [
        ...(this.pendingCandidates.get(projectionId)?.values() ?? []),
      ],
      guidance: [],
      session_id: projectionId,
      article_id: projectionArticleId,
      state: selected
        ? selected.outcome?.kind === "cancelled"
          ? "cancelled"
          : selected.outcome?.kind === "published" ||
              (selected.outcome?.kind === "retained" &&
                ["delivered", "exhausted"].includes(selected.outcome.code))
            ? "finished"
            : selected.outcome
              ? "failed"
              : "agent-running"
        : this.operationState,
      control: {
        workspace_id: projectionId,
        viewers: this.clients.size,
        controller_id: null,
        epoch: 0,
      },
      observation: null,
      model_ready: true,
      error: null,
      ...(projectionArticleId === this.articleId ? { operation_feedback } : {}),
    };
  }
  frame(
    sequence: number,
    clientId?: string,
    sessionId?: string,
  ): Uint8Array | null {
    const id =
      sessionId ??
      (clientId === undefined ? this.sessionId : this.selection.get(clientId));
    if (clientId && !this.clients.has(clientId)) return null;
    if (!id || (clientId && this.selection.get(clientId) !== id)) return null;
    return this.sessions.get(id)?.session?.frame(sequence) ?? null;
  }
  async refresh(clientId?: string): Promise<void> {
    if (clientId !== undefined) {
      const id = this.selection.get(clientId);
      await (id ? this.sessions.get(id)?.session?.refresh() : undefined);
      return;
    }
    await Promise.all(
      [...this.sessions.values()].map((record) => record.session?.refresh()),
    );
  }
  private active(clientId: string, sessionId?: string): WorkbenchSession {
    if (!this.clients.has(clientId))
      throw new WorkbenchSessionError("stale-command");
    const id =
      sessionId ??
      this.selection.get(clientId) ??
      (this.sessions.size === 1
        ? this.sessions.keys().next().value
        : undefined);
    const record = id ? this.sessions.get(id) : undefined;
    if (!record?.session) throw new WorkbenchSessionError("session-busy");
    return record.session;
  }
  assertBinding(
    clientId: string,
    sessionId: unknown,
    articleId: unknown,
  ): void {
    if (!this.clients.has(clientId) || typeof sessionId !== "string")
      throw new WorkbenchSessionError("stale-command");
    const record = this.sessions.get(sessionId);
    if (
      record
        ? record.identity.literature_id !== articleId
        : sessionId !== this.sessionId ||
          articleId !== this.articleId ||
          !this.operationAbort
    )
      throw new WorkbenchSessionError("stale-command");
  }
  private commandSessionId(value: unknown): string {
    if (
      !value ||
      typeof value !== "object" ||
      !("session_id" in value) ||
      typeof value.session_id !== "string"
    )
      throw new WorkbenchSessionError("stale-command");
    return value.session_id;
  }
  command(clientId: string, value: unknown) {
    return this.active(clientId, this.commandSessionId(value)).command(
      clientId,
      value,
    );
  }
  takeover(clientId: string, epoch: number, sessionId?: string): void {
    this.active(clientId, sessionId).takeover(clientId, epoch);
  }
  release(clientId: string, epoch: number, sessionId?: string): void {
    this.active(clientId, sessionId).release(clientId, epoch);
  }
  pause(clientId: string, epoch: number, sessionId?: string): void {
    this.active(clientId, sessionId).pause(clientId, epoch);
  }
  resume(clientId: string, epoch: number, sessionId?: string): void {
    this.active(clientId, sessionId).resume(clientId, epoch);
  }
  cancel(clientId: string, epoch: number, sessionId?: string): void {
    if (!this.clients.has(clientId))
      throw new WorkbenchSessionError("stale-command");
    const id = sessionId ?? this.selection.get(clientId) ?? this.sessionId;
    const record = this.sessions.get(id);
    if (record) {
      if (record.outcome) throw new WorkbenchSessionError("session-closed");
      if (!record.session) {
        if (epoch !== 0) throw new WorkbenchSessionError("stale-command");
        record.cancel();
        return;
      }
      record.session.cancel(clientId, epoch);
      if (record.execution) return;
    } else if (id !== this.sessionId || epoch !== 0 || !this.operationAbort)
      throw new WorkbenchSessionError("stale-command");
    this.operationState = "cancelled";
    this.session?.finishProduction("cancelled");
    this.operationAbort?.abort();
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
    return this.active(clientId, this.commandSessionId(value)).submitGuidance(
      clientId,
      value,
    );
  }
  cancelGuidance(clientId: string, value: unknown) {
    return this.active(clientId, this.commandSessionId(value)).cancelGuidance(
      clientId,
      value,
    );
  }
  async close(): Promise<void> {
    this.closed = true;
    this.operationAbort?.abort();
    for (const record of this.sessions.values()) record.cancel();
    await this.operation;
    await Promise.all(
      [...this.sessions.values()].map((record) =>
        record.session?.settleActions(),
      ),
    );
  }
}
