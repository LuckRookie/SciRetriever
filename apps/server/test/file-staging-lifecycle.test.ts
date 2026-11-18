import {
  mkdtemp,
  readFile,
  rename,
  writeFile,
  mkdir,
  utimes,
  stat,
  symlink,
  rm,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createApplication } from "../src/bootstrap/application.js";
import { startWorkbenchHttp } from "../src/workbench/http.js";
import { ProductionWorkbenchSession } from "../src/workbench/production-session.js";
import { BrowserTransferCollector } from "../src/browser/transfer.js";
import { workbenchTestAccess } from "./workbench-auth-fixture.js";

import {
  createStaging,
  FileStagingError,
} from "../src/storage/files/staging.js";

describe("staged file lifecycle", () => {
  it("cleans old abandoned stages only in the server and preserves another application's active stage, candidates and published bytes", async () => {
    const home = await mkdtemp(
      join(tmpdir(), "sciretriever-staging-maintenance-"),
    );
    const root = join(home, "artifacts"),
      directory = join(root, ".staging");
    await mkdir(directory, { recursive: true });
    const abandoned = join(directory, `stage-${randomUUID()}.tmp`);
    const old = new Date(Date.now() - 2 * 3600000);
    await writeFile(abandoned, "abandoned");
    await utimes(abandoned, old, old);
    const app = await createApplication(home, {
      indexRefreshIntervalMs: null,
      importSessions: { maintain: false },
    });
    const writer = await createApplication(home, {
      indexRefreshIntervalMs: null,
      importSessions: { maintain: false },
    });
    const session = new ProductionWorkbenchSession(null, undefined);
    let server: Awaited<ReturnType<typeof startWorkbenchHttp>> | undefined;
    const intervals = vi.spyOn(globalThis, "setInterval");
    const logs = vi.spyOn(process.stderr, "write");
    try {
      // Application/CLI construction must not itself run server maintenance.
      expect(await readFile(abandoned, "utf8")).toBe("abandoned");
      const active = await writer.files.stage();
      await active.write(Buffer.from("active"));
      const collector = new BrowserTransferCollector(app.files, app.database);
      await collector.begin("retained-candidate", 1024, {
        session_id: "synthetic",
        article_id: "synthetic",
        page_id: "synthetic",
        document_generation: 0,
        source_url: "https://fixture.invalid/pdf",
        captured_at: new Date().toISOString(),
      });
      await collector.append("retained-candidate", Buffer.from("candidate"));
      const candidate = await collector.complete("retained-candidate");
      const publishedStage = await app.files.stage();
      await publishedStage.write(Buffer.from("published"));
      await app.files.publish(publishedStage, "objects/published.bin");
      await symlink(
        join(root, "objects/published.bin"),
        join(directory, `stage-${randomUUID()}.tmp`),
      );
      server = await startWorkbenchHttp({
        session,
        assets: new Map(),
        access: workbenchTestAccess,
        workspace: {
          artifact_root: root,
          catalog_path: join(home, "catalog.sqlite"),
          schema_version: 19,
          configuration_revision: null,
          runtime_capabilities: null,
          capabilities: {
            tasks: false,
            query: false,
            maintenance: false,
            discovery: false,
            import: true,
          },
        },
      });
      await expect(stat(abandoned)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(join(root, active.reference), "utf8")).toBe(
        "active",
      );
      await active.write(Buffer.from(" still writing"));
      expect(await readFile(join(root, candidate.reference), "utf8")).toBe(
        "candidate",
      );
      expect(
        (await app.database.getCandidate("retained-candidate"))?.sha256,
      ).toBe(candidate.sha256);
      expect(await readFile(join(root, "objects/published.bin"), "utf8")).toBe(
        "published",
      );
      expect(
        logs.mock.calls.some(([value]) =>
          String(value).includes("removed 1 files (9 bytes)"),
        ),
      ).toBe(true);
      const hourly = intervals.mock.calls.find(([, ms]) => ms === 3600000)?.[0];
      expect(hourly).toBeTypeOf("function");
      await writeFile(abandoned, "again");
      await utimes(abandoned, old, old);
      if (typeof hourly === "function") hourly();
      await expect
        .poll(
          async () =>
            stat(abandoned).then(
              () => false,
              () => true,
            ),
          { timeout: 20000 },
        )
        .toBe(true);
      await server.close();
      server = undefined;
      await writeFile(abandoned, "after close");
      await utimes(abandoned, old, old);
      if (typeof hourly === "function") hourly();
      expect(await readFile(abandoned, "utf8")).toBe("after close");
    } finally {
      vi.restoreAllMocks();
      await server?.close();
      await session.close();
      await writer.close();
      await app.close();
      await rm(home, { recursive: true, force: true });
    }
  }, 30000);
  it("serializes concurrent writes and seals a handed-off stage", async () => {
    const root = await mkdtemp(join(tmpdir(), "sciretriever-staging-"));
    const stage = await createStaging(root, { maxBytes: 8 });
    try {
      await Promise.all([
        stage.write(new TextEncoder().encode("abc")),
        stage.write(new TextEncoder().encode("def")),
      ]);
      await stage.handoff();
      await expect(stage.write(new Uint8Array([1]))).rejects.toBeInstanceOf(
        FileStagingError,
      );
      await expect(stage.read()).resolves.toEqual(
        new TextEncoder().encode("abcdef"),
      );
    } finally {
      await stage.close();
    }
  });

  it("does not delete a replacement after a failed cleanup", async () => {
    const root = await mkdtemp(join(tmpdir(), "sciretriever-staging-"));
    const stage = await createStaging(root);
    const name = stage.reference.split("/").at(-1)!;
    const path = join(root, ".staging", name);
    const replacement = join(root, ".staging", "replacement.tmp");
    await writeFile(replacement, "replacement");
    await rename(replacement, path);
    await expect(stage.discard()).rejects.toBeInstanceOf(FileStagingError);
    await expect(readFile(path, "utf8")).resolves.toBe("replacement");
  });
});
