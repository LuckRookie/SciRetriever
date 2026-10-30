import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it, vi } from "vitest";
import { IndexRefreshService } from "../src/retrieval/refresh.js";
import { IndexRefreshStateStore } from "../src/storage/retrieval-refresh.js";
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const generation = (revision: number) => ({
  generation_id: "00000000-0000-0000-0000-000000000101",
  source_revision: revision,
  entry_count: 3,
  source_count: 3,
});

it("serializes a queued rebuild and a later incremental refresh while reporting only the actual operation", async () => {
  const root = await mkdtemp(join(tmpdir(), "sciretriever-index-background-")),
    catalog = join(root, "catalog.sqlite");
  const refreshEntered = gate(),
    releaseRefresh = gate(),
    buildEntered = gate(),
    releaseBuild = gate();
  let revision = 1,
    active = 0,
    peak = 0,
    indexed = 0;
  const calls: string[] = [];
  const service = new IndexRefreshService(
    catalog,
    {
      refresh: async () => {
        active++;
        peak = Math.max(peak, active);
        calls.push("refresh");
        const current = revision;
        try {
          if (calls.length === 1) {
            refreshEntered.resolve();
            await releaseRefresh.promise;
          }
          indexed = current;
          return generation(current);
        } finally {
          active--;
        }
      },
      build: async (_signal, progress) => {
        active++;
        peak = Math.max(peak, active);
        calls.push("rebuild");
        const current = revision;
        try {
          await progress?.({ done: 0, total: 3 });
          await progress?.({ done: 1, total: 3 });
          buildEntered.resolve();
          await releaseBuild.promise;
          await progress?.({ done: 3, total: 3 });
          indexed = current;
          return generation(current);
        } finally {
          active--;
        }
      },
    },
    async () => revision,
    undefined,
    async () => (indexed ? generation(indexed) : null),
  );
  try {
    await service.start();
    expect((await service.status()).index_state).toBe("missing");
    await service.scheduleRefresh();
    await refreshEntered.promise;
    revision = 2;
    expect(await service.scheduleRebuild()).toMatchObject({
      status: "running",
      operation: "refresh",
      progress: null,
    });
    releaseRefresh.resolve();
    await buildEntered.promise;
    expect(await service.status()).toMatchObject({
      status: "running",
      operation: "rebuild",
      progress: { done: 1, total: 3 },
    });
    revision = 3;
    expect(await service.scheduleRefresh()).toMatchObject({
      operation: "rebuild",
      progress: { done: 1, total: 3 },
    });
    releaseBuild.resolve();
    await vi.waitFor(async () =>
      expect(await service.status()).toMatchObject({
        status: "updated",
        operation: "refresh",
        progress: null,
        indexed_revision: 3,
        index_state: "ready",
      }),
    );
    expect(calls).toEqual(["refresh", "rebuild", "refresh"]);
    expect(peak).toBe(1);
    expect(Object.keys(await service.status())).not.toContain(
      "rebuild_requested",
    );
  } finally {
    releaseRefresh.resolve();
    releaseBuild.resolve();
    await service.close();
    await rm(root, { recursive: true, force: true });
  }
}, 20_000);

it("retains a queued background rebuild across shutdown and resumes it as a rebuild", async () => {
  const root = await mkdtemp(
      join(tmpdir(), "sciretriever-index-background-reopen-"),
    ),
    catalog = join(root, "catalog.sqlite");
  const refresh = vi.fn(async () => generation(1)),
    build = vi.fn(
      async (
        _signal?: AbortSignal,
        progress?: (value: { done: number; total: number }) => Promise<void>,
      ) => {
        await progress?.({ done: 1, total: 1 });
        return generation(1);
      },
    );
  let service = new IndexRefreshService(
    catalog,
    { refresh, build },
    async () => 1,
  );
  try {
    await service.scheduleRebuild();
    await service.close();
    expect(
      (await IndexRefreshStateStore.read(`${catalog}.index-refresh.json`))
        .rebuild_requested,
    ).toBe(1);
    service = new IndexRefreshService(
      catalog,
      { refresh, build },
      async () => 1,
    );
    await service.start();
    await vi.waitFor(async () =>
      expect(await service.status()).toMatchObject({
        status: "updated",
        operation: "rebuild",
        progress: { done: 1, total: 1 },
      }),
    );
    expect(build).toHaveBeenCalledTimes(1);
    expect(refresh).not.toHaveBeenCalled();
  } finally {
    await service.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("keeps an interrupted rebuild pending and starts another explicit refresh after a settled rebuild failure", async () => {
  const root = await mkdtemp(
      join(tmpdir(), "sciretriever-index-background-failure-"),
    ),
    catalog = join(root, "catalog.sqlite");
  const entered = gate();
  let cancelled = false;
  let service = new IndexRefreshService(
    catalog,
    {
      refresh: async () => generation(1),
      build: async (signal) => {
        entered.resolve();
        await new Promise<void>((_done, reject) =>
          signal!.addEventListener(
            "abort",
            () => {
              cancelled = true;
              reject(
                Object.assign(Error("cancelled"), { code: "index-cancelled" }),
              );
            },
            { once: true },
          ),
        );
        return generation(1);
      },
    },
    async () => 1,
  );
  try {
    await service.scheduleRebuild();
    await entered.promise;
    await service.close();
    expect(cancelled).toBe(true);
    expect(
      (await IndexRefreshStateStore.read(`${catalog}.index-refresh.json`))
        .status,
    ).toBe("scheduled");
    service = new IndexRefreshService(
      catalog,
      {
        refresh: async () => generation(1),
        build: async () => {
          throw Object.assign(Error("failed"), {
            code: "index-source-invalid",
          });
        },
      },
      async () => 1,
    );
    await service.start();
    await vi.waitFor(async () =>
      expect(await service.status()).toMatchObject({
        status: "failed",
        operation: "rebuild",
      }),
    );
    await service.scheduleRefresh();
    await vi.waitFor(async () =>
      expect(await service.status()).toMatchObject({
        status: "updated",
        operation: "refresh",
        progress: null,
      }),
    );
  } finally {
    await service.close();
    await rm(root, { recursive: true, force: true });
  }
});
