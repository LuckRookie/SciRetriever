import {
  mkdtemp,
  open,
  rename,
  rm,
  symlink,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it, vi } from "vitest";
import { IndexRefreshService } from "../src/retrieval/refresh.js";
import { IndexRefreshStateStore } from "../src/storage/retrieval-refresh.js";
import { idleIndexRefreshStatus } from "@sciretriever/contracts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it("reopens the state when atomic replacement unlinks the opened inode before fstat", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "sciretriever-index-state-rename-"),
  );
  const store = new IndexRefreshStateStore(join(root, "catalog.sqlite"));
  let restore: (() => void) | undefined;
  try {
    await store.update((state) => state);
    const replacement = `${store.path}.replacement`;
    const next = {
      ...idleIndexRefreshStatus(),
      request_sequence: 1,
      status: "scheduled",
    };
    await writeFile(replacement, JSON.stringify(next), { mode: 0o600 });
    const probe = await open(store.path, "r");
    const prototype = Object.getPrototypeOf(probe) as Pick<FileHandle, "stat">;
    await probe.close();
    const stat = prototype.stat;
    let unlinked = false;
    const pending = vi
      .spyOn(prototype, "stat")
      .mockImplementationOnce(async function (this: FileHandle) {
        await rename(replacement, store.path);
        const value = await stat.call(this);
        unlinked = value.nlink === 0;
        return value;
      });
    restore = () => pending.mockRestore();
    expect(await store.read()).toMatchObject(next);
    expect(unlinked).toBe(true);
  } finally {
    restore?.();
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});
const generation = (revision: number) => ({
  generation_id: "00000000-0000-0000-0000-000000000101",
  source_revision: revision,
  entry_count: 2,
  source_count: 1,
});

it("durably schedules without awaiting a builder and collapses pending revisions into one latest refresh", async () => {
  const root = await mkdtemp(join(tmpdir(), "sciretriever-index-refresh-")),
    catalog = join(root, "catalog.sqlite");
  const release = deferred(),
    started = deferred();
  let revision = 1,
    calls = 0,
    active = 0,
    peak = 0;
  const revisions: number[] = [];
  const service = new IndexRefreshService(
    catalog,
    {
      refresh: async () => {
        const input = revision;
        revisions.push(input);
        calls++;
        active++;
        peak = Math.max(peak, active);
        try {
          if (calls === 1) {
            started.resolve();
            await release.promise;
          }
          return generation(input);
        } finally {
          active--;
        }
      },
      build: async () => generation(revision),
    },
    async () => revision,
  );
  try {
    await service.start();
    expect(await service.schedule()).toEqual({ index_status: "scheduled" });
    expect(
      await IndexRefreshStateStore.read(`${catalog}.index-refresh.json`),
    ).toMatchObject({ status: "scheduled", requested_revision: 1 });
    await started.promise;
    revision = 2;
    await service.schedule();
    revision = 3;
    await service.schedule();
    revision = 4;
    await service.schedule();
    expect(calls).toBe(1);
    release.resolve();
    await vi.waitFor(async () =>
      expect(await service.status()).toMatchObject({
        status: "updated",
        indexed_revision: 4,
      }),
    );
    expect(revisions).toEqual([1, 4]);
    expect(peak).toBe(1);
  } finally {
    release.resolve();
    await service.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("persists failure across reopen, leaves a retry available, and resumes an interrupted request", async () => {
  const root = await mkdtemp(
      join(tmpdir(), "sciretriever-index-refresh-reopen-"),
    ),
    catalog = join(root, "catalog.sqlite");
  const index = {
    refresh: vi.fn(async () => {
      throw Object.assign(new Error("synthetic"), {
        code: "index-source-invalid",
      });
    }),
    build: vi.fn(async () => generation(4)),
  };
  let service = new IndexRefreshService(catalog, index, async () => 4);
  try {
    await service.schedule();
    await vi.waitFor(async () =>
      expect(await service.status()).toMatchObject({
        status: "failed",
        technical_details: { code: "index-source-invalid" },
      }),
    );
    await service.close();
    service = new IndexRefreshService(catalog, index, async () => 4);
    await service.start();
    expect(await service.status()).toMatchObject({ status: "failed" });
    expect(index.refresh).toHaveBeenCalledTimes(1);
    await service.rebuild();
    expect(await service.status()).toMatchObject({
      status: "updated",
      indexed_revision: 4,
      technical_details: { code: null },
    });
    // A short-lived CLI can close before the debounce: the accepted request survives.
    await service.schedule();
    await service.close();
    const refreshed = vi.fn(async () => generation(4));
    service = new IndexRefreshService(
      catalog,
      { ...index, refresh: refreshed },
      async () => 4,
    );
    await service.start();
    await vi.waitFor(async () =>
      expect(await service.status()).toMatchObject({ status: "updated" }),
    );
    expect(refreshed).toHaveBeenCalledTimes(1);
  } finally {
    await service.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("cancels background work on close without discarding its durable request or its last accepted generation", async () => {
  const root = await mkdtemp(
      join(tmpdir(), "sciretriever-index-refresh-cancel-"),
    ),
    catalog = join(root, "catalog.sqlite");
  const started = deferred();
  const service = new IndexRefreshService(
    catalog,
    {
      refresh: async (signal) => {
        started.resolve();
        await new Promise<void>((_resolve, reject) => {
          signal!.addEventListener(
            "abort",
            () =>
              reject(
                Object.assign(new Error("synthetic"), {
                  code: "index-cancelled",
                }),
              ),
            { once: true },
          );
        });
        return generation(1);
      },
      build: async () => generation(1),
    },
    async () => 2,
  );
  try {
    await service.rebuild();
    await service.schedule();
    await started.promise;
    await service.close();
    expect(
      await IndexRefreshStateStore.read(`${catalog}.index-refresh.json`),
    ).toMatchObject({
      status: "scheduled",
      requested_revision: 2,
      indexed_revision: 1,
      technical_details: { code: "index-cancelled" },
    });
  } finally {
    await service.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("refuses a symlinked or invalid projection state without overwriting the target", async () => {
  const root = await mkdtemp(
      join(tmpdir(), "sciretriever-index-refresh-safety-"),
    ),
    catalog = join(root, "catalog.sqlite");
  const target = join(root, "synthetic-target");
  const store = new IndexRefreshStateStore(catalog);
  try {
    await writeFile(target, "synthetic non-state bytes");
    await symlink(target, store.path);
    await expect(store.read()).rejects.toThrow();
    await expect(store.update((s) => s)).rejects.toThrow();
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("does not drop a new request for the same source revision when the in-flight refresh fails", async () => {
  const root = await mkdtemp(
      join(tmpdir(), "sciretriever-index-refresh-sequence-"),
    ),
    catalog = join(root, "catalog.sqlite"),
    gate = deferred(),
    started = deferred();
  let calls = 0;
  const service = new IndexRefreshService(
    catalog,
    {
      refresh: async () => {
        calls++;
        if (calls === 1) {
          started.resolve();
          await gate.promise;
          throw new Error("synthetic");
        }
        return generation(1);
      },
      build: async () => generation(1),
    },
    async () => 1,
  );
  try {
    await service.schedule();
    await started.promise;
    await service.schedule();
    gate.resolve();
    await vi.waitFor(async () =>
      expect(await service.status()).toMatchObject({
        status: "updated",
        request_sequence: 2,
      }),
    );
    expect(calls).toBe(2);
  } finally {
    gate.resolve();
    await service.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("keeps corrupt projection state visible without blocking startup and repairs only on explicit successful rebuild", async () => {
  const root = await mkdtemp(
      join(tmpdir(), "sciretriever-index-refresh-corrupt-"),
    ),
    catalog = join(root, "catalog.sqlite");
  await writeFile(`${catalog}.index-refresh.json`, "synthetic malformed JSON", {
    mode: 0o600,
  });
  const refresh = vi.fn(async () => generation(1));
  const service = new IndexRefreshService(
    catalog,
    { refresh, build: async () => generation(1) },
    async () => 1,
  );
  try {
    await service.start();
    expect(await service.status()).toMatchObject({
      status: "failed",
      technical_details: { code: "index-refresh-state-invalid" },
    });
    expect(refresh).not.toHaveBeenCalled();
    await service.rebuild();
    expect(await service.status()).toMatchObject({
      status: "updated",
      indexed_revision: 1,
    });
  } finally {
    await service.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("merges source changes made by later archive steps after a stale CAS, but does not spin on an unchanged failure", async () => {
  const root = await mkdtemp(
      join(tmpdir(), "sciretriever-index-refresh-stale-"),
    ),
    catalog = join(root, "catalog.sqlite");
  let revision = 1,
    calls = 0,
    change = true,
    failUnchanged = false;
  const service = new IndexRefreshService(
    catalog,
    {
      refresh: async () => {
        calls++;
        if (failUnchanged)
          throw Object.assign(new Error("synthetic"), { code: "index-stale" });
        if (change) {
          change = false;
          revision = 2;
          throw Object.assign(new Error("synthetic"), { code: "index-stale" });
        }
        return generation(revision);
      },
      build: async () => generation(revision),
    },
    async () => revision,
  );
  try {
    await service.schedule();
    await vi.waitFor(async () =>
      expect(await service.status()).toMatchObject({
        status: "updated",
        requested_revision: 2,
        indexed_revision: 2,
        request_sequence: 1,
      }),
    );
    expect(calls).toBe(2);
    failUnchanged = true;
    await service.schedule();
    await vi.waitFor(async () =>
      expect(await service.status()).toMatchObject({
        status: "failed",
        technical_details: { code: "index-stale" },
      }),
    );
    expect(calls).toBe(3);
  } finally {
    await service.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("shares one background builder across two maintenance owners of the same catalog", async () => {
  const root = await mkdtemp(
      join(tmpdir(), "sciretriever-index-refresh-owners-"),
    ),
    catalog = join(root, "catalog.sqlite"),
    started = deferred(),
    gate = deferred();
  let revision = 1,
    calls = 0,
    active = 0,
    peak = 0;
  const index = {
    refresh: async () => {
      const input = revision;
      calls++;
      active++;
      peak = Math.max(peak, active);
      try {
        if (calls === 1) {
          started.resolve();
          await gate.promise;
        }
        return generation(input);
      } finally {
        active--;
      }
    },
    build: async () => generation(revision),
  };
  const first = new IndexRefreshService(catalog, index, async () => revision),
    second = new IndexRefreshService(catalog, index, async () => revision);
  try {
    await first.schedule();
    await started.promise;
    revision = 2;
    await second.schedule();
    gate.resolve();
    await vi.waitFor(async () =>
      expect(await second.status()).toMatchObject({
        status: "updated",
        indexed_revision: 2,
      }),
    );
    expect(peak).toBe(1);
    expect(calls).toBe(2);
  } finally {
    gate.resolve();
    await first.close();
    await second.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("resumes against a restored catalog's lower source revision without refreshing an impossible future in a loop", async () => {
  const root = await mkdtemp(
      join(tmpdir(), "sciretriever-index-refresh-restored-"),
    ),
    catalog = join(root, "catalog.sqlite");
  const refresh = vi.fn(async () => generation(1)),
    index = { refresh, build: async () => generation(1) };
  let service = new IndexRefreshService(catalog, index, async () => 9);
  try {
    await service.schedule();
    await service.close();
    service = new IndexRefreshService(catalog, index, async () => 1);
    await service.start();
    await vi.waitFor(async () =>
      expect(await service.status()).toMatchObject({
        status: "updated",
        requested_revision: 1,
        indexed_revision: 1,
      }),
    );
    expect(refresh).toHaveBeenCalledTimes(1);
  } finally {
    await service.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("observes idle scalar lag, coalesces status reads and retries a temporarily busy index owner", async () => {
  const root = await mkdtemp(join(tmpdir(), "sciretriever-index-monitor-")),
    catalog = join(root, "catalog.sqlite");
  let source = 1,
    indexed = 1,
    calls = 0,
    busy = true;
  const service = new IndexRefreshService(
    catalog,
    {
      refresh: async () => {
        calls++;
        if (busy) {
          busy = false;
          throw Object.assign(new Error("busy"), {
            code: "write-admission-conflict",
          });
        }
        indexed = source;
        return generation(indexed);
      },
      build: async () => generation(source),
    },
    async () => source,
    {
      inspect: async () => ({
        source_revision: source,
        generation: { source_revision: indexed },
      }),
      interval_ms: 25,
    },
  );
  try {
    await service.start();
    expect(calls).toBe(0);
    source = 2;
    await Promise.all(Array.from({ length: 8 }, () => service.status()));
    expect((await service.status()).request_sequence).toBe(1);
    await vi.waitFor(
      async () =>
        expect(await service.status()).toMatchObject({
          status: "updated",
          indexed_revision: 2,
        }),
      { timeout: 20_000 },
    );
    expect(calls).toBe(2);
    source = 3;
    // No status read or new publication drives this pass.
    await vi.waitFor(() => expect(indexed).toBe(3), { timeout: 20_000 });
    expect(calls).toBe(3);
  } finally {
    await service.close();
    await rm(root, { recursive: true, force: true });
  }
});
