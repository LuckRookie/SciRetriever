import { setTimeout as delay } from "node:timers/promises";
import type {
  IndexRefreshStatus,
  RetrievalGenerationReceipt,
} from "@sciretriever/contracts";
import { IndexRefreshStateStore } from "../storage/retrieval-refresh.js";
import {
  CatalogWriteAdmission,
  WriteAdmissionError,
} from "../storage/write-admission.js";

function code(error: unknown): string {
  return error &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string" &&
    /^[a-z][a-z0-9-]{0,80}$/u.test(error.code)
    ? error.code
    : "index-refresh-failed";
}
/** Durable latest-request slot; one builder across processes, never held by publication. */
export class IndexRefreshService {
  private readonly store: IndexRefreshStateStore;
  private readonly owner: CatalogWriteAdmission;
  private readonly stop = new AbortController();
  private work: Promise<void> | undefined;
  private stopped = false;
  private failure: string | null = null;
  private timer: ReturnType<typeof setInterval> | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private retryDelay: number | undefined;
  private observing: Promise<void> | undefined;
  constructor(
    catalog: string,
    private readonly index: {
      refresh(
        signal?: AbortSignal,
        progress?: (pending: number) => Promise<void>,
      ): Promise<RetrievalGenerationReceipt>;
      build(signal?: AbortSignal): Promise<RetrievalGenerationReceipt>;
    },
    private readonly revision: () => Promise<number>,
    private readonly monitor?: {
      inspect(): Promise<{
        source_revision: number;
        generation: { source_revision: number } | null;
      }>;
      interval_ms?: number;
    },
  ) {
    if (
      monitor &&
      (!Number.isSafeInteger(monitor.interval_ms ?? 5000) ||
        (monitor.interval_ms ?? 5000) < 1 ||
        (monitor.interval_ms ?? 5000) > 60_000)
    )
      throw new TypeError("index refresh interval is invalid");
    this.store = new IndexRefreshStateStore(catalog);
    this.owner = new CatalogWriteAdmission(`${catalog}.index-refresh-worker`);
  }
  async status(): Promise<IndexRefreshStatus> {
    await this.checkLag();
    const value = await IndexRefreshStateStore.status(this.store.path);
    return this.failure
      ? {
          ...value,
          status: "failed",
          technical_details: { code: this.failure },
        }
      : value;
  }
  async start() {
    const state = await this.status();
    if (state.status === "scheduled" || state.status === "running") this.kick();
    if (this.monitor && !this.timer && !this.stopped) {
      this.timer = setInterval(() => {
        void this.checkLag();
      }, this.monitor.interval_ms ?? 5000);
      this.timer.unref();
    }
  }
  /** Coalesced scalar-only observation; query-only applications do not own it. */
  private checkLag(): Promise<void> {
    if (!this.monitor || this.stopped) return Promise.resolve();
    if (this.observing) return this.observing;
    this.observing = (async () => {
      const snapshot = await this.monitor!.inspect();
      if (
        snapshot.generation?.source_revision === snapshot.source_revision ||
        (!snapshot.generation && snapshot.source_revision === 0)
      )
        return;
      const state = await IndexRefreshStateStore.status(this.store.path);
      if (state.technical_details.code === "index-refresh-state-invalid")
        return;
      if (
        ["scheduled", "running", "failed"].includes(state.status) &&
        (state.requested_revision ?? -1) >= snapshot.source_revision
      ) {
        if (state.status !== "failed") this.kick();
        return;
      }
      await this.schedule();
    })()
      .catch(async (error) => {
        this.failure = code(error);
        await this.store
          .update((state) => ({
            ...state,
            status: "failed",
            technical_details: { code: this.failure },
            finished_at: new Date().toISOString(),
          }))
          .catch(() => {});
      })
      .finally(() => {
        this.observing = undefined;
      });
    return this.observing;
  }
  async schedule() {
    if (this.stopped) throw new Error("index-refresh-closed");
    const revision = await this.revision();
    await this.store
      .update((state) => ({
        ...state,
        status: "scheduled",
        request_sequence: state.request_sequence + 1,
        requested_revision: Math.max(revision, state.requested_revision ?? 0),
        requested_at: new Date().toISOString(),
        finished_at: null,
        technical_details: { code: null },
        pending_literatures: null,
      }))
      .catch((error: unknown) => {
        this.failure = code(error);
        throw error;
      });
    this.failure = null;
    this.kick();
    return { index_status: "scheduled" as const };
  }
  private kick() {
    if (this.work || this.stopped || this.retryTimer) return;
    this.work = this.run()
      .catch(async (error: unknown) => {
        this.failure = code(error);
        // If even the durable diagnostic cannot be saved, status() retains the code.
        await this.store
          .update((state) => ({
            ...state,
            status: "failed",
            finished_at: new Date().toISOString(),
            technical_details: { code: this.failure },
          }))
          .catch(() => {});
      })
      .finally(async () => {
        this.work = undefined;
        // Create the retry outside owner.run's ALS scope. A timer created
        // inside that scope would inherit an expired admission capability.
        if (!this.stopped && this.retryDelay !== undefined) {
          const milliseconds = this.retryDelay;
          this.retryDelay = undefined;
          this.retryTimer = setTimeout(() => {
            this.retryTimer = undefined;
            this.kick();
          }, milliseconds);
          this.retryTimer.unref();
          return;
        }
        // Cover a publication arriving between the last read and runner exit.
        if (!this.stopped && !this.failure) {
          try {
            if ((await this.store.read()).status === "scheduled") this.kick();
          } catch (error) {
            this.failure = code(error);
          }
        }
      });
  }
  private async run() {
    // Coalesce publications that arrive in the same burst; does not delay acceptance.
    await delay(100, undefined, { signal: this.stop.signal }).catch(() => {});
    while (!this.stopped) {
      try {
        await this.owner.run(async () => {
          for (;;) {
            if (this.stopped) return;
            const state = await this.store.read();
            if (state.status !== "scheduled" && state.status !== "running")
              return;
            const requested = state.requested_revision!;
            const sequence = state.request_sequence;
            const attemptedRevision = await this.revision();
            await this.store.update((latest) => ({
              ...latest,
              // A restored catalog may have a lower source counter than its
              // rebuildable sidecar. Do not refresh an impossible future forever.
              requested_revision:
                latest.request_sequence === sequence &&
                (latest.requested_revision ?? 0) > attemptedRevision
                  ? attemptedRevision
                  : latest.requested_revision,
              status: "running",
              started_at: new Date().toISOString(),
              technical_details: { code: null },
              pending_literatures: null,
            }));
            const refreshStarted = performance.now();
            try {
              const generation = await this.index.refresh(
                this.stop.signal,
                async (pending) => {
                  await this.store.update((latest) => ({
                    ...latest,
                    pending_literatures: pending,
                  }));
                },
              );
              await this.store.update((latest) => ({
                ...latest,
                indexed_revision: generation.source_revision,
                status:
                  (latest.requested_revision ?? 0) > generation.source_revision
                    ? "scheduled"
                    : "updated",
                finished_at: new Date().toISOString(),
                technical_details: { code: null },
                pending_literatures:
                  (latest.requested_revision ?? 0) > generation.source_revision
                    ? null
                    : 0,
                last_refresh_ms: Math.round(performance.now() - refreshStarted),
              }));
              this.failure = null;
            } catch (error) {
              // Metadata can advance after render without another publication.
              // A stale CAS retries only when real source work has advanced.
              const changedRevision =
                !this.stopped && code(error) === "index-stale"
                  ? await this.revision()
                  : attemptedRevision;
              const busy = code(error) === "write-admission-conflict";
              await this.store.update((latest) => ({
                ...latest,
                requested_revision: Math.max(
                  latest.requested_revision ?? 0,
                  changedRevision,
                ),
                status:
                  this.stopped ||
                  busy ||
                  latest.request_sequence > sequence ||
                  changedRevision > attemptedRevision ||
                  (latest.requested_revision ?? 0) > requested
                    ? "scheduled"
                    : "failed",
                finished_at: new Date().toISOString(),
                technical_details: { code: code(error) },
                last_refresh_ms: Math.round(performance.now() - refreshStarted),
              }));
              if (this.stopped) return;
              if (busy) {
                this.retryDelay = this.monitor?.interval_ms ?? 5000;
                return;
              }
            }
          }
        }, this.stop.signal);
        return;
      } catch (error) {
        if (this.stopped) return;
        if (
          !(error instanceof WriteAdmissionError) ||
          error.code !== "write-admission-conflict"
        )
          throw error;
        await delay(50, undefined, { signal: this.stop.signal }).catch(
          () => {},
        );
      }
    }
  }
  /** Existing explicit maintenance command also clears a failed scheduled refresh. */
  async rebuild(signal?: AbortSignal): Promise<RetrievalGenerationReceipt> {
    for (;;) {
      try {
        return await this.owner.run(() => this.rebuildOwned(signal), signal);
      } catch (error) {
        if (
          !(error instanceof WriteAdmissionError) ||
          error.code !== "write-admission-conflict"
        )
          throw error;
        await delay(50, undefined, {
          signal: signal
            ? AbortSignal.any([signal, this.stop.signal])
            : this.stop.signal,
        });
      }
    }
  }
  private async rebuildOwned(signal?: AbortSignal) {
    const sequence = (await IndexRefreshStateStore.status(this.store.path))
      .request_sequence;
    let generation: RetrievalGenerationReceipt;
    try {
      generation = await this.index.build(signal);
    } catch (error) {
      this.failure = code(error);
      await this.store
        .update(
          (state) => ({
            ...state,
            status: "failed",
            finished_at: new Date().toISOString(),
            technical_details: { code: this.failure },
          }),
          true,
        )
        .catch(() => {});
      throw error;
    }
    await this.store.update(
      (state) => ({
        ...state,
        indexed_revision: generation.source_revision,
        requested_revision:
          state.request_sequence > sequence &&
          (state.requested_revision ?? 0) > generation.source_revision
            ? state.requested_revision
            : generation.source_revision,
        status:
          state.request_sequence > sequence &&
          (state.requested_revision ?? 0) > generation.source_revision
            ? "scheduled"
            : "updated",
        finished_at: new Date().toISOString(),
        technical_details: { code: null },
      }),
      true,
    );
    this.failure = null;
    return generation;
  }
  async close() {
    this.stopped = true;
    clearInterval(this.timer);
    clearTimeout(this.retryTimer);
    this.stop.abort();
    await this.observing;
    await this.work;
    await this.owner.close();
    await this.store.close();
  }
}
