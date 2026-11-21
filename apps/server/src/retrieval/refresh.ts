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
/** Live active-state probe is deliberately separate from the durable queue. */
export async function readIndexRefreshStatus(
  path: string,
  active?: () => Promise<unknown | null>,
): Promise<IndexRefreshStatus> {
  const value = await IndexRefreshStateStore.status(path);
  let index_state: IndexRefreshStatus["index_state"];
  if (active) {
    try {
      index_state = (await active()) === null ? "missing" : "ready";
    } catch (error) {
      if (!["index-corrupt", "catalog-corrupt"].includes(code(error)))
        throw error;
      index_state = "corrupt";
    }
  }
  return {
    ...value,
    operation: value.operation ?? null,
    progress: value.progress ?? null,
    ...(index_state ? { index_state } : {}),
  };
}
/** Durable latest-request slot; one builder across processes, never held by publication. */
export class IndexRefreshService {
  private readonly store: IndexRefreshStateStore;
  private readonly owner: CatalogWriteAdmission;
  private readonly stop = new AbortController();
  private work: Promise<void> | undefined;
  private started = false;
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
      build(
        signal?: AbortSignal,
        progress?: (value: { done: number; total: number }) => Promise<void>,
      ): Promise<RetrievalGenerationReceipt>;
    },
    private readonly revision: () => Promise<number>,
    private readonly monitor?: {
      inspect(): Promise<{
        source_revision: number;
        generation: { source_revision: number } | null;
      }>;
      interval_ms?: number;
    },
    private readonly activeIndex?: () => Promise<unknown | null>,
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
    return this.readStatus();
  }
  private async readStatus(): Promise<IndexRefreshStatus> {
    const value = await readIndexRefreshStatus(
      this.store.path,
      this.activeIndex,
    );
    return this.failure
      ? {
          ...value,
          status: "failed",
          technical_details: { code: this.failure },
        }
      : value;
  }
  async start() {
    const firstStart = !this.started;
    this.started = true;
    await this.checkLag(firstStart);
    const state = await this.readStatus();
    if (state.status === "scheduled" || state.status === "running") this.kick();
    if (this.monitor && !this.timer && !this.stopped) {
      this.timer = setInterval(() => {
        void this.checkLag();
      }, this.monitor.interval_ms ?? 5000);
      this.timer.unref();
    }
  }
  /** Coalesced scalar-only observation; query-only applications do not own it. */
  private checkLag(firstStart = false): Promise<void> {
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
      // A previous process may have hit the retired aggregate limits.
      // Retry once on startup; an oversized single source can still fail.
      const retryLimitFailure =
        firstStart &&
        state.status === "failed" &&
        state.technical_details.code === "index-limit";
      if (
        !retryLimitFailure &&
        ["scheduled", "running", "failed"].includes(state.status) &&
        (state.requested_revision ?? -1) >= snapshot.source_revision
      ) {
        if (state.status !== "failed") this.kick();
        return;
      }
      await this.schedule();
    })()
      .catch(async (error) => {
        // A known bad projection is reported by index_state. Do not overwrite
        // an explicitly queued repair merely because the monitor sees it.
        if (["index-corrupt", "catalog-corrupt"].includes(code(error))) return;
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
    await this.request("refresh");
    return { index_status: "scheduled" as const };
  }
  async scheduleRefresh(): Promise<IndexRefreshStatus> {
    await this.request("refresh");
    return this.status();
  }
  async scheduleRebuild(): Promise<IndexRefreshStatus> {
    await this.request("rebuild");
    return this.status();
  }
  private async request(operation: "refresh" | "rebuild") {
    if (this.stopped) throw new Error("index-refresh-closed");
    const revision = await this.revision();
    await this.store
      .update(
        (state) => ({
          ...state,
          status: state.status === "running" ? "running" : "scheduled",
          request_sequence: state.request_sequence + 1,
          requested_revision: Math.max(revision, state.requested_revision ?? 0),
          requested_at: new Date().toISOString(),
          finished_at: null,
          technical_details: { code: null },
          pending_literatures: null,
          operation: state.operation ?? null,
          progress: state.progress ?? null,
          ...(operation === "rebuild"
            ? { rebuild_requested: state.request_sequence + 1 }
            : {}),
        }),
        operation === "rebuild",
      )
      .catch((error) => {
        this.failure = code(error);
        throw error;
      });
    this.failure = null;
    this.kick();
  }
  /** Short-lived CLI retains ownership until the accepted queue work settles. */
  async refresh(signal?: AbortSignal): Promise<IndexRefreshStatus> {
    await this.request("refresh");
    for (;;) {
      signal?.throwIfAborted();
      if (this.stopped) throw new Error("index-refresh-closed");
      const state = await this.status();
      if (state.status === "updated" || state.status === "failed") return state;
      await delay(25, undefined, { ...(signal ? { signal } : {}) });
    }
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
            const rebuildSequence = state.rebuild_requested ?? 0;
            const operation =
              rebuildSequence > (state.rebuild_settled ?? 0)
                ? "rebuild"
                : "refresh";
            const attemptedRevision = await this.revision();
            this.failure = null;
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
              operation,
              progress: null,
              started_at: new Date().toISOString(),
              technical_details: { code: null },
              pending_literatures: null,
            }));
            const refreshStarted = performance.now();
            try {
              const generation =
                operation === "rebuild"
                  ? await this.index.build(
                      this.stop.signal,
                      async (progress) => {
                        await this.store.update((latest) => ({
                          ...latest,
                          progress,
                        }));
                      },
                    )
                  : await this.index.refresh(
                      this.stop.signal,
                      async (pending) => {
                        await this.store.update((latest) => ({
                          ...latest,
                          pending_literatures: pending,
                        }));
                      },
                    );
              // A different process can publish without requesting a refresh.
              const sourceRevision =
                operation === "refresh" ? await this.revision() : null;
              await this.store.update((latest) => {
                const settled =
                  operation === "rebuild"
                    ? Math.max(latest.rebuild_settled ?? 0, rebuildSequence)
                    : (latest.rebuild_settled ?? 0);
                const requestedRevision =
                  sourceRevision === null
                    ? latest.requested_revision
                    : Math.max(latest.requested_revision ?? 0, sourceRevision);
                const pending =
                  (latest.rebuild_requested ?? 0) > settled ||
                  (requestedRevision ?? 0) > generation.source_revision;
                return {
                  ...latest,
                  requested_revision: requestedRevision,
                  indexed_revision: generation.source_revision,
                  rebuild_settled: settled,
                  status: pending ? "scheduled" : "updated",
                  operation,
                  progress:
                    operation === "rebuild" ? (latest.progress ?? null) : null,
                  finished_at: new Date().toISOString(),
                  technical_details: { code: null },
                  pending_literatures: pending ? null : 0,
                  last_refresh_ms: Math.round(
                    performance.now() - refreshStarted,
                  ),
                };
              });
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
                ...(operation === "rebuild" &&
                !this.stopped &&
                !busy &&
                changedRevision === attemptedRevision
                  ? {
                      rebuild_settled: Math.max(
                        latest.rebuild_settled ?? 0,
                        rebuildSequence,
                      ),
                    }
                  : {}),
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
        const result = await this.owner.run(
          () => this.rebuildOwned(signal),
          signal,
        );
        if ((await this.store.read()).status === "scheduled") this.kick();
        return result;
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
    const revision = await this.revision();
    const started = await this.store.update(
      (state) => ({
        ...state,
        request_sequence: state.request_sequence + 1,
        rebuild_requested: state.request_sequence + 1,
        requested_revision: revision,
        requested_at: new Date().toISOString(),
        status: "running",
        operation: "rebuild",
        progress: null,
        pending_literatures: null,
        started_at: new Date().toISOString(),
        finished_at: null,
        technical_details: { code: null },
      }),
      true,
    );
    const begin = performance.now();
    this.failure = null;
    let generation: RetrievalGenerationReceipt;
    try {
      generation = await this.index.build(signal, async (progress) => {
        await this.store.update((state) => ({ ...state, progress }));
      });
    } catch (error) {
      this.failure = code(error);
      await this.store
        .update(
          (state) => ({
            ...state,
            rebuild_settled: Math.max(
              state.rebuild_settled ?? 0,
              started.request_sequence,
            ),
            status:
              state.request_sequence > started.request_sequence
                ? "scheduled"
                : "failed",
            operation: "rebuild",
            finished_at: new Date().toISOString(),
            technical_details: { code: this.failure },
            last_refresh_ms: Math.round(performance.now() - begin),
          }),
          true,
        )
        .catch(() => {});
      throw error;
    }
    await this.store.update((state) => {
      const settled = Math.max(
        state.rebuild_settled ?? 0,
        started.request_sequence,
      );
      const pending =
        (state.rebuild_requested ?? 0) > settled ||
        (state.requested_revision ?? 0) > generation.source_revision;
      return {
        ...state,
        indexed_revision: generation.source_revision,
        rebuild_settled: settled,
        requested_revision: Math.max(
          state.requested_revision ?? 0,
          generation.source_revision,
        ),
        status: pending ? "scheduled" : "updated",
        operation: "rebuild",
        finished_at: new Date().toISOString(),
        technical_details: { code: null },
        last_refresh_ms: Math.round(performance.now() - begin),
        pending_literatures: pending ? null : 0,
      };
    }, true);
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
