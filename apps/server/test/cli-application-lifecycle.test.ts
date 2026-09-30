import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { parseAsset, sha256 } from "@sciretriever/contracts";
import * as bootstrap from "../src/bootstrap/application.js";
import { runCli } from "../src/cli/main.js";
import { FileStore } from "../src/storage/files/store.js";
import { SqliteWorker } from "../src/storage/sqlite/worker.js";
import { FIXTURE_LITERATURE } from "../src/workbench/synthetic-fixture.js";

describe("CLI application lifecycle", () => {
  it.each([
    { missing: false, cleanupFails: false, code: 0, failure: null },
    { missing: true, cleanupFails: false, code: 3, failure: "business-failed" },
    {
      missing: false,
      cleanupFails: true,
      code: 70,
      failure: "internal-failed",
    },
    { missing: true, cleanupFails: true, code: 70, failure: "internal-failed" },
  ])(
    "reports operation and cleanup outcomes: $missing / $cleanupFails",
    async ({ missing, cleanupFails, code, failure }) => {
      const home = await mkdtemp(join(tmpdir(), "sciretriever-cli-close-"));
      const seed = await bootstrap.createApplication(home);
      await seed.database.putLiterature(FIXTURE_LITERATURE);
      await seed.close();
      const fileClose = FileStore.prototype.close;
      const databaseClose = SqliteWorker.prototype.close;
      const closedFiles: FileStore[] = [];
      const closedDatabases: SqliteWorker[] = [];
      const cleanupFailure = new TypeError("synthetic private cleanup detail");
      const fileCleanup = vi
        .spyOn(FileStore.prototype, "close")
        .mockImplementation(async function (this: FileStore) {
          closedFiles.push(this);
          await fileClose.call(this);
          if (cleanupFails) throw cleanupFailure;
        });
      const databaseCleanup = vi
        .spyOn(SqliteWorker.prototype, "close")
        .mockImplementation(async function (this: SqliteWorker) {
          closedDatabases.push(this);
          await databaseClose.call(this);
        });
      const buildQueryApplication = bootstrap.createQueryApplication;
      const application = await buildQueryApplication(home);
      const create = vi
        .spyOn(bootstrap, "createQueryApplication")
        .mockResolvedValue(application);
      const errors: string[] = [];
      try {
        const result = await runCli(
          missing
            ? ["literature", "show", "00000000-0000-0000-0000-000000000999"]
            : ["literature", "search"],
          { home, stderr: (text) => errors.push(text) },
        );
        expect(result.code).toBe(code);
        expect(errors).toEqual(
          failure ? [`${JSON.stringify({ code: failure })}\n`] : [],
        );
        expect(create).toHaveBeenCalledExactlyOnceWith(home);
        expect(fileCleanup).toHaveBeenCalledTimes(1);
        expect(databaseCleanup).toHaveBeenCalledTimes(1);
        expect(closedFiles).toHaveLength(1);
        expect(closedDatabases).toHaveLength(1);
        await expect(closedFiles[0]!.stage()).rejects.toMatchObject({
          code: "file-store",
        });
        await expect(
          closedDatabases[0]!.queryPreflight(),
        ).rejects.toMatchObject({
          code: "sqlite-worker",
        });
      } finally {
        create.mockRestore();
        fileCleanup.mockRestore();
        databaseCleanup.mockRestore();
        await Promise.allSettled([application.close()]);
        await rm(home, { recursive: true, force: true });
      }
    },
  );

  it("preserves query startup and cleanup failures while closing the reader", async () => {
    const home = await mkdtemp(join(tmpdir(), "sciretriever-query-startup-"));
    const seed = await bootstrap.createApplication(home);
    await seed.database.putLiterature(FIXTURE_LITERATURE);
    await seed.close();
    const startupFailure = new Error("synthetic query preflight failure");
    const cleanupFailure = new Error("synthetic query reader close failure");
    const databaseClose = SqliteWorker.prototype.close;
    const closedDatabases: SqliteWorker[] = [];
    const preflight = vi
      .spyOn(SqliteWorker.prototype, "queryPreflight")
      .mockRejectedValue(startupFailure);
    const close = vi
      .spyOn(SqliteWorker.prototype, "close")
      .mockImplementation(async function (this: SqliteWorker) {
        closedDatabases.push(this);
        await databaseClose.call(this);
        throw cleanupFailure;
      });
    try {
      await expect(
        bootstrap.createQueryApplication(home),
      ).rejects.toMatchObject({
        message: "query application startup and cleanup failed",
        cause: startupFailure,
        errors: [
          startupFailure,
          {
            message: "query application cleanup failed",
            errors: [cleanupFailure],
          },
        ],
      });
      expect(preflight).toHaveBeenCalledTimes(1);
      expect(close).toHaveBeenCalledTimes(1);
      expect(closedDatabases).toHaveLength(1);
      await expect(
        closedDatabases[0]!.listExecutionJobs(),
      ).rejects.toMatchObject({ code: "sqlite-worker" });
    } finally {
      preflight.mockRestore();
      close.mockRestore();
      await Promise.allSettled(
        closedDatabases.map((database) => database.close()),
      );
      await rm(home, { recursive: true, force: true });
    }
  });

  it("shares one concurrent and reentrant query close result and closes SQLite after file cleanup fails", async () => {
    const home = await mkdtemp(join(tmpdir(), "sciretriever-query-close-"));
    const seed = await bootstrap.createApplication(home);
    await seed.close();
    const cleanupFailure = new Error("synthetic query file close failure");
    const fileClose = FileStore.prototype.close;
    const databaseClose = SqliteWorker.prototype.close;
    const closedFiles: FileStore[] = [];
    const closedDatabases: SqliteWorker[] = [];
    let reentrant: Promise<void> | undefined;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const files = vi
      .spyOn(FileStore.prototype, "close")
      .mockImplementation(async function (this: FileStore) {
        closedFiles.push(this);
        reentrant = application.close();
        await fileClose.call(this);
        await barrier;
        throw cleanupFailure;
      });
    const database = vi
      .spyOn(SqliteWorker.prototype, "close")
      .mockImplementation(async function (this: SqliteWorker) {
        closedDatabases.push(this);
        await databaseClose.call(this);
      });
    let application: Awaited<
      ReturnType<typeof bootstrap.createQueryApplication>
    >;
    try {
      application = await bootstrap.createQueryApplication(home);
      const first = application.close();
      const second = application.close();
      expect(second).toBe(first);
      const settledPromise = Promise.allSettled([first, second]);
      release();
      const settled = await settledPromise;

      expect(reentrant).toBe(first);
      expect(settled[0]).toMatchObject({
        status: "rejected",
        reason: {
          message: "query application cleanup failed",
          errors: [cleanupFailure],
        },
      });
      expect(settled[1]).toEqual(settled[0]);
      expect(application.close()).toBe(first);
      expect(files).toHaveBeenCalledTimes(1);
      expect(database).toHaveBeenCalledTimes(1);
      expect(closedFiles).toHaveLength(1);
      expect(closedDatabases).toHaveLength(1);
      await expect(closedFiles[0]!.stage()).rejects.toMatchObject({
        code: "file-store",
      });
      await expect(
        closedDatabases[0]!.listExecutionJobs(),
      ).rejects.toMatchObject({ code: "sqlite-worker" });
    } finally {
      release();
      files.mockRestore();
      database.mockRestore();
      await rm(home, { recursive: true, force: true });
    }
  });

  it("releases the real graph when the raw artifact presenter throws", async () => {
    const home = await mkdtemp(join(tmpdir(), "sciretriever-cli-presenter-"));
    const writer = await bootstrap.createApplication(home);
    const bytes = Buffer.from("%PDF-1.4\nsynthetic-presenter-fixture\n%%EOF\n");
    const presenter = vi.fn(() => {
      throw new Error("synthetic private presenter detail");
    });
    const fileClose = FileStore.prototype.close;
    const databaseClose = SqliteWorker.prototype.close;
    const closedFiles: FileStore[] = [];
    const closedDatabases: SqliteWorker[] = [];
    const fileCleanup = vi
      .spyOn(FileStore.prototype, "close")
      .mockImplementation(async function (this: FileStore) {
        closedFiles.push(this);
        await fileClose.call(this);
      });
    const databaseCleanup = vi
      .spyOn(SqliteWorker.prototype, "close")
      .mockImplementation(async function (this: SqliteWorker) {
        closedDatabases.push(this);
        await databaseClose.call(this);
      });
    let application:
      | Awaited<ReturnType<typeof bootstrap.createQueryApplication>>
      | undefined;
    let create: { mockRestore(): void } | undefined;
    const errors: string[] = [];
    try {
      await writer.database.putLiterature(FIXTURE_LITERATURE);
      const staged = await writer.files.stage({ maxBytes: bytes.length });
      await staged.write(bytes);
      await writer.files.publish(staged, "objects/presenter.pdf");
      const asset = parseAsset({
        asset_id: "00000000-0000-0000-0000-000000000701",
        sha256: await sha256(bytes),
        size_bytes: bytes.length,
        media_type: "application/pdf",
        path: "objects/presenter.pdf",
      });
      await writer.database.putLiteratureAsset({
        literature_asset_id: "00000000-0000-0000-0000-000000000702",
        literature_id: FIXTURE_LITERATURE.literature_id,
        asset,
        role: "primary-pdf",
        source_url: null,
        provenance: {
          provenance_id: "00000000-0000-0000-0000-000000000703",
          source_kind: "user",
          source_name: "synthetic-presenter",
          source_record_id: null,
          observed_at: "2026-09-16T00:00:00Z",
          input_sha256: asset.sha256,
          parameters_sha256: null,
        },
      });
      await writer.close();
      fileCleanup.mockClear();
      databaseCleanup.mockClear();
      closedFiles.length = 0;
      closedDatabases.length = 0;
      application = await bootstrap.createQueryApplication(home);
      create = vi
        .spyOn(bootstrap, "createQueryApplication")
        .mockResolvedValue(application);
      const result = await runCli(
        ["export", "pdf", FIXTURE_LITERATURE.literature_id, "-"],
        { home, stdoutBytes: presenter, stderr: (text) => errors.push(text) },
      );
      expect(result.code).toBe(70);
      expect(presenter).toHaveBeenCalledExactlyOnceWith(bytes);
      expect(errors).toEqual(['{"code":"internal-failed"}\n']);
      expect(create).toHaveBeenCalledExactlyOnceWith(home);
      expect(fileCleanup).toHaveBeenCalledTimes(1);
      expect(databaseCleanup).toHaveBeenCalledTimes(1);
      expect(closedFiles).toHaveLength(1);
      expect(closedDatabases).toHaveLength(1);
      await expect(closedFiles[0]!.stage()).rejects.toMatchObject({
        code: "file-store",
      });
      await expect(closedDatabases[0]!.queryPreflight()).rejects.toMatchObject({
        code: "sqlite-worker",
      });
      create.mockRestore();
      create = undefined;
      fileCleanup.mockRestore();
      databaseCleanup.mockRestore();
      const recovered = await bootstrap.createApplication(home);
      try {
        expect(
          (await recovered.library.detail(FIXTURE_LITERATURE.literature_id))
            .primary_pdf?.asset.sha256,
        ).toBe(asset.sha256);
      } finally {
        await recovered.close();
      }
    } finally {
      create?.mockRestore();
      fileCleanup.mockRestore();
      databaseCleanup.mockRestore();
      await Promise.allSettled([application?.close(), writer.close()]);
      await rm(home, { recursive: true, force: true });
    }
  });
});
