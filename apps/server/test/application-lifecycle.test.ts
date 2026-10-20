import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createApplication } from "../src/bootstrap/application.js";
import { EntryPdfAcquisitionService } from "../src/entry/pdf-acquisition.js";
import { FileStore } from "../src/storage/files/store.js";
import { SqliteWorker } from "../src/storage/sqlite/worker.js";

async function browserHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "sciretriever-close-browser-"));
  const directory = join(home, ".sciretriever");
  await mkdir(directory, { mode: 0o700 });
  await writeFile(
    join(directory, "config.toml"),
    '[browser]\nenabled = true\nprofile = "synthetic"\n',
    { mode: 0o600 },
  );
  return home;
}

describe("application lifecycle", () => {
  it("creates one database and closes it idempotently from an offline home", async () => {
    const home = await mkdtemp(join(tmpdir(), "sciretriever-application-"));
    const application = await createApplication(home);
    expect(application.home).toBe(home);
    expect(application.observations).toBeDefined();
    expect(application.files).toBeDefined();
    expect(application.agents.readiness("analysis")).toEqual({
      configured: false,
      missing: [],
    });
    const stage = await application.files.stage({ maxBytes: 16 });
    await stage.write(new TextEncoder().encode("temporary"));
    await expect(application.close()).resolves.toBeUndefined();
    await expect(application.close()).resolves.toBeUndefined();
    await expect(application.files.stage()).rejects.toMatchObject({
      code: "file-store",
    });
    await expect(application.database.schema()).rejects.toMatchObject({
      code: "sqlite-worker",
    });
  });

  it("cleans already-created resources when any later startup stage fails", async () => {
    const stages = [
      "database",
      "files",
      "network",
      "agents",
      "schema",
    ] as const;
    for (const failedStage of stages) {
      const home = await mkdtemp(
        join(tmpdir(), "sciretriever-startup-failure-"),
      );
      await expect(
        createApplication(home, {
          afterStage: (stage) => {
            if (stage === failedStage)
              throw new Error(`injected ${stage} failure`);
          },
        }),
      ).rejects.toThrow(`injected ${failedStage} failure`);
      let recovered;
      try {
        recovered = await createApplication(home);
      } catch (error) {
        throw new Error(
          `recovery after ${failedStage} failed: ${String(error)}`,
        );
      }
      await expect(recovered.database.schema()).resolves.toBeDefined();
      await expect(recovered.close()).resolves.toBeUndefined();
    }
  });

  it("reopens the same catalog after a normal close", async () => {
    const home = await mkdtemp(join(tmpdir(), "sciretriever-reopen-"));
    const first = await createApplication(home);
    await first.close();
    const second = await createApplication(home);
    await second.close();
  });

  it("shares a failing Browser close and still releases the catalog and files", async () => {
    const home = await browserHome();
    const failure = new TypeError("synthetic browser close failure");
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const close = vi.fn(async () => {
      await barrier;
      throw failure;
    });
    const factory = vi.fn(() => ({
      deliverCandidate: vi.fn(),
      close,
    }));
    const application = await createApplication(home, {
      browserHost: factory,
      browserAdmitNavigation: async (url) => url,
    });
    try {
      const stage = await application.files.stage({ maxBytes: 16 });
      await stage.write(new TextEncoder().encode("temporary"));
      expect(application.browserHost()).not.toBeNull();
      const first = application.close();
      const second = application.close();
      // Observe both promises before any assertion can fail and unblock cleanup.
      const results = Promise.allSettled([first, second]);
      release();
      const settled = await results;
      expect(first).toBe(second);
      expect(settled[0]).toMatchObject({
        status: "rejected",
        reason: {
          message: "application cleanup failed",
          errors: [failure],
        },
      });
      expect(settled[1]).toEqual(settled[0]);
      expect(application.close()).toBe(first);
      expect(close).toHaveBeenCalledTimes(1);
      expect(application.browserHost()).toBeNull();
      expect(factory).toHaveBeenCalledTimes(1);
      await expect(application.files.stage()).rejects.toMatchObject({
        code: "file-store",
      });
      await expect(application.database.schema()).rejects.toMatchObject({
        code: "sqlite-worker",
      });
      await expect(stage.write(new Uint8Array([1]))).rejects.toBeDefined();
      await expect(
        application.writes.run(async () => undefined),
      ).rejects.toMatchObject({
        code: "write-admission-closed",
      });
      const recovered = await createApplication(home, { browserHost: factory });
      await recovered.close();
    } finally {
      release();
      await Promise.allSettled([application.close()]);
      await rm(home, { recursive: true, force: true });
    }
  });

  it("settles a synchronous acquisition close failure and still closes the host and stores", async () => {
    const home = await browserHome();
    const failure = new Error(
      "synthetic synchronous acquisition close failure",
    );
    const hostClose = vi.fn(async () => undefined);
    const application = await createApplication(home, {
      browserAdmitNavigation: async (url) => url,
      browserHost: () => ({
        deliverCandidate: async () => ({ kind: "exhausted" as const }),
        close: hostClose,
      }),
    });
    try {
      expect(application.browserHost()).not.toBeNull();
      vi.spyOn(
        application.pdfAcquisition as EntryPdfAcquisitionService,
        "close",
      ).mockImplementation(() => {
        throw failure;
      });
      await expect(application.close()).rejects.toMatchObject({
        errors: [failure],
      });
      expect(hostClose).toHaveBeenCalledTimes(1);
      await expect(application.database.schema()).rejects.toMatchObject({
        code: "sqlite-worker",
      });
      await expect(application.files.stage()).rejects.toMatchObject({
        code: "file-store",
      });
    } finally {
      await Promise.allSettled([application.close()]);
      await rm(home, { recursive: true, force: true });
    }
  });

  it.each([true, false])(
    "does not create a Browser during or after close (demanded: %s)",
    async (demanded) => {
      const home = await browserHome();
      let release!: () => void;
      const barrier = new Promise<void>((resolve) => {
        release = resolve;
      });
      const factory = vi.fn(() => ({
        deliverCandidate: vi.fn(),
        close: async () => barrier,
      }));
      const application = await createApplication(home, {
        browserHost: factory,
        browserAdmitNavigation: async (url) => url,
      });
      try {
        if (demanded) expect(application.browserHost()).not.toBeNull();
        const closing = application.close();
        const observed = Promise.allSettled([closing]);
        try {
          expect(application.browserHost()).toBeNull();
        } finally {
          release();
          await observed;
        }
        await closing;
        expect(application.browserHost()).toBeNull();
        expect(factory).toHaveBeenCalledTimes(demanded ? 1 : 0);
      } finally {
        release();
        await application.close();
        await rm(home, { recursive: true, force: true });
      }
    },
  );

  it.each([new Error("synthetic network close failure"), null, undefined])(
    "retains every cleanup failure and continues releasing stores (%s)",
    async (failure) => {
      const home = await mkdtemp(join(tmpdir(), "sciretriever-close-failure-"));
      const application = await createApplication(home);
      const networkClose = application.networkBudget.close.bind(
        application.networkBudget,
      );
      const agentClose = application.agents.close.bind(application.agents);
      const agentFailure = new Error("synthetic agent close failure");
      const network = vi
        .spyOn(application.networkBudget, "close")
        .mockImplementation(() => {
          networkClose();
          throw failure;
        });
      const agents = vi
        .spyOn(application.agents, "close")
        .mockImplementation(() => {
          agentClose();
          throw agentFailure;
        });
      try {
        await expect(application.close()).rejects.toMatchObject({
          message: "application cleanup failed",
          errors: [failure, agentFailure],
        });
        await expect(application.files.stage()).rejects.toMatchObject({
          code: "file-store",
        });
        await expect(application.database.schema()).rejects.toMatchObject({
          code: "sqlite-worker",
        });
        await expect(
          application.writes.run(async () => undefined),
        ).rejects.toMatchObject({ code: "write-admission-closed" });
        expect(network).toHaveBeenCalledTimes(1);
        expect(agents).toHaveBeenCalledTimes(1);
      } finally {
        network.mockRestore();
        agents.mockRestore();
        // Also releases stores when this regression is run against the old early-exit cleanup.
        await Promise.allSettled([
          application.close(),
          application.files.close(),
          application.database.close(),
        ]);
        await rm(home, { recursive: true, force: true });
      }
    },
  );

  it("preserves the startup error and every rollback failure while closing the database", async () => {
    const home = await mkdtemp(
      join(tmpdir(), "sciretriever-startup-rollback-"),
    );
    const startupFailure = new Error("synthetic startup failure");
    const fileFailure = new Error("synthetic file close failure");
    const databaseFailure = new Error("synthetic database close failure");
    const fileClose = FileStore.prototype.close;
    const databaseClose = SqliteWorker.prototype.close;
    const closedFiles: FileStore[] = [];
    const closedDatabases: SqliteWorker[] = [];
    const files = vi
      .spyOn(FileStore.prototype, "close")
      .mockImplementation(async function (this: FileStore) {
        closedFiles.push(this);
        await fileClose.call(this);
        throw fileFailure;
      });
    const database = vi
      .spyOn(SqliteWorker.prototype, "close")
      .mockImplementation(async function (this: SqliteWorker) {
        closedDatabases.push(this);
        await databaseClose.call(this);
        throw databaseFailure;
      });
    try {
      await expect(
        createApplication(home, {
          afterStage: (stage) => {
            if (stage === "schema") throw startupFailure;
          },
        }),
      ).rejects.toMatchObject({
        message: "application startup and cleanup failed",
        cause: startupFailure,
        errors: [startupFailure, { errors: [fileFailure, databaseFailure] }],
      });
      expect(files).toHaveBeenCalledTimes(1);
      expect(database).toHaveBeenCalledTimes(1);
      expect(closedFiles).toHaveLength(1);
      expect(closedDatabases).toHaveLength(1);
      await expect(closedFiles[0]!.stage()).rejects.toMatchObject({
        code: "file-store",
      });
      await expect(closedDatabases[0]!.schema()).rejects.toMatchObject({
        code: "sqlite-worker",
      });
      files.mockRestore();
      database.mockRestore();
      const recovered = await createApplication(home);
      await recovered.close();
    } finally {
      files.mockRestore();
      database.mockRestore();
      await rm(home, { recursive: true, force: true });
    }
  });
});
