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
  constructor(
    catalog: string,
    private readonly index: {
      refresh(signal?: AbortSignal): Promise<RetrievalGenerationReceipt>;
      build(signal?: AbortSignal): Promise<RetrievalGenerationReceipt>;
    },
    private readonly revision: () => Promise<number>,
  ) {
    this.store = new IndexRefreshStateStore(catalog);
    this.owner = new CatalogWriteAdmission(`${catalog}.index-refresh-worker`);
  }
  async status(): Promise<IndexRefreshStatus> {
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
    if (this.work || this.stopped) return;
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
            }));
            try {
              const generation = await this.index.refresh(this.stop.signal);
              await this.store.update((latest) => ({
                ...latest,
                indexed_revision: generation.source_revision,
                status:
                  (latest.requested_revision ?? 0) > generation.source_revision
                    ? "scheduled"
                    : "updated",
                finished_at: new Date().toISOString(),
                technical_details: { code: null },
              }));
            } catch (error) {
              // Metadata can advance after render without another publication.
              // A stale CAS retries only when real source work has advanced.
              const changedRevision =
                !this.stopped && code(error) === "index-stale"
                  ? await this.revision()
                  : attemptedRevision;
              await this.store.update((latest) => ({
                ...latest,
                requested_revision: Math.max(
                  latest.requested_revision ?? 0,
                  changedRevision,
                ),
                status:
                  this.stopped ||
                  latest.request_sequence > sequence ||
                  changedRevision > attemptedRevision ||
                  (latest.requested_revision ?? 0) > requested
                    ? "scheduled"
                    : "failed",
                finished_at: new Date().toISOString(),
                technical_details: { code: code(error) },
              }));
              if (this.stopped) return;
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
  async rebuild(signal?: AbortSignal) {
    const sequence = (await this.status()).request_sequence;
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
    this.stop.abort();
    await this.work;
    await this.owner.close();
    await this.store.close();
  }
}
