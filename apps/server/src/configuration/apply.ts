import {
  parseConfigurationApplyRequest,
  parseConfigurationApplyCancelRequest,
  type ConfigurationApplyState,
  type ConfigurationApplyRequest,
  type ConfigurationApplyCancelRequest,
} from "@sciretriever/contracts";
import type { Application } from "../bootstrap/application.js";
import {
  sourceConfiguration,
  sourceDetails,
  unmanagedApply,
  SourceConfigurationError,
  type SourceConfigurationOwner,
} from "./sources.js";
import { sourceProbes } from "./source-probes.js";
export interface ConfigurationLifecycle {
  state(): ConfigurationApplyState;
  request(value: unknown): Promise<ConfigurationApplyState>;
  cancel(value: unknown): Promise<ConfigurationApplyState>;
  flushed(): void;
  bind(application: Application, sources: SourceConfigurationOwner): void;
}
export class ManagedConfigurationLifecycle implements ConfigurationLifecycle {
  private app: Application | undefined;
  private sources: SourceConfigurationOwner | undefined;
  private current: ConfigurationApplyState;
  private unflushed: ConfigurationApplyRequest | undefined;
  constructor(
    readonly runtimeId: string,
    readonly generation: number,
    initial: ConfigurationApplyState | undefined,
    private readonly sendApply: (request: ConfigurationApplyRequest) => void,
    private readonly sendCancel: (
      request: ConfigurationApplyCancelRequest,
    ) => Promise<boolean>,
  ) {
    this.current = initial
      ? { ...initial, runtime_id: runtimeId, generation }
      : {
          ...unmanagedApply(),
          managed: true,
          runtime_id: runtimeId,
          generation,
          state: "starting",
        };
  }
  bind(application: Application, sources: SourceConfigurationOwner) {
    this.app = application;
    this.sources = sources;
    sources.lifecycle = this;
    if (sources.runtime)
      sources.runtime = { ...sources.runtime, runtime_id: this.runtimeId };
    const binding = sources.runtime?.configuration;
    void binding;
    sources.applyState = () => this.state();
    sources.admission = (work) => application.restartAdmission!.newWork(work);
  }
  async ready(): Promise<void> {
    if (!this.sources)
      throw new SourceConfigurationError("configuration-apply-busy");
    const directory = await this.sources.directory();
    this.update({
      ...this.current,
      state: this.current.state === "starting" ? "idle" : this.current.state,
      current_binding_revision: directory.runtime!.binding_revision,
      can_cancel: false,
    });
  }
  state(): ConfigurationApplyState {
    return this.current;
  }
  private pending(
    request: ConfigurationApplyRequest,
  ): ConfigurationApplyState | null {
    if (!["waiting", "draining", "stopping"].includes(this.current.state))
      return null;
    if (
      request.target_binding_revision === this.current.target_binding_revision
    )
      return this.current;
    throw new SourceConfigurationError("configuration-apply-busy");
  }
  update(value: ConfigurationApplyState): void {
    this.current = {
      ...value,
      runtime_id: this.runtimeId,
      generation: this.generation,
      updated_at: new Date().toISOString(),
    };
    this.app?.restartAdmission?.freeze(
      ["waiting", "draining", "stopping"].includes(value.state),
    );
  }
  async request(value: unknown): Promise<ConfigurationApplyState> {
    const request = parseConfigurationApplyRequest(value);
    if (!this.sources || request.runtime_id !== this.runtimeId)
      throw new SourceConfigurationError("source-configuration-conflict");
    const inFlight = this.pending(request);
    if (inFlight) return inFlight;
    const directory = await this.sources.directory();
    if (directory.binding_revision !== request.target_binding_revision)
      throw new SourceConfigurationError(
        "source-configuration-conflict",
        directory.binding_revision,
      );
    const raced = this.pending(request);
    if (raced) return raced;
    this.update({
      ...this.current,
      state: "waiting",
      request_id: request.request_id,
      target_binding_revision: request.target_binding_revision,
      can_cancel: true,
      problem: null,
    });
    this.unflushed = request;
    return this.current;
  }
  flushed(): void {
    const request = this.unflushed;
    if (!request) return;
    this.unflushed = undefined;
    this.sendApply(request);
  }
  async cancel(value: unknown): Promise<ConfigurationApplyState> {
    const request = parseConfigurationApplyCancelRequest(value);
    if (
      request.runtime_id !== this.runtimeId ||
      request.request_id !== this.current.request_id ||
      !this.current.can_cancel
    )
      throw new SourceConfigurationError("source-configuration-conflict");
    if (this.unflushed) {
      this.unflushed = undefined;
      this.update({ ...this.current, state: "cancelled", can_cancel: false });
      return this.current;
    }
    if (!(await this.sendCancel(request)))
      throw new SourceConfigurationError("source-configuration-conflict");
    if (this.current.request_id === request.request_id)
      this.update({ ...this.current, state: "cancelled", can_cancel: false });
    return this.current;
  }
  async inspect() {
    if (!this.app || !this.sources) throw new Error("lifecycle-not-bound");
    const local = this.app.restartAdmission!.blockers();
    local.browser_transfers = Math.max(
      local.browser_transfers,
      this.app.execution?.transfers.activeCount() ?? 0,
    );
    let queued = 0,
      running = 0,
      before: import("../storage/sqlite/worker.js").ExecutionJobCursor | null =
        null;
    for (;;) {
      const jobs: readonly import("../storage/sqlite/worker.js").ExecutionJobListItem[] =
        (await this.app.jobs?.listJobs(1000, "oldest", before, [
          "queued",
          "running",
        ])) ?? [];
      for (const job of jobs) {
        if (job.status === "queued") queued++;
        else if (job.status === "running") running++;
      }
      if (jobs.length < 1000) break;
      const last: import("../storage/sqlite/worker.js").ExecutionJobListItem =
        jobs.at(-1)!;
      before = { job_id: last.job_id, timestamp: last.created_at };
    }
    const directory = await this.sources.directory();
    return {
      blockers: {
        ...local,
        queued,
        running,
        probes: Math.max(
          local.probes,
          sourceProbes(sourceConfiguration(this.sources.owner)).activeCount,
        ),
      },
      binding_revision: directory.binding_revision,
      catalog: (await this.sources.owner.read()).configuration.paths
        .catalog_path!,
    };
  }
  fail(code: string) {
    this.update({
      ...this.current,
      state: "failed",
      can_cancel: false,
      problem: {
        display: "error",
        technical_details: sourceDetails(code, "apply"),
      },
    });
  }
}
