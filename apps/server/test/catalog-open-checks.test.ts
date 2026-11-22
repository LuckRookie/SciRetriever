import { DatabaseSync } from "node:sqlite";
import { mkdir, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  initializeCurrentCatalog,
  CURRENT_CATALOG_CONFIG,
} from "../src/storage/sqlite/catalog-layout.js";
import {
  readCatalogIdentity,
  readCatalogLayout,
} from "../src/storage/sqlite/catalog-identity.js";
import {
  catalogNeedsInitialization,
  inspectCatalogSchema,
} from "../src/storage/sqlite/catalog-schema.js";
import {
  SqliteWorker,
  SqliteWorkerError,
} from "../src/storage/sqlite/worker.js";
import { RetrievalStorageClient } from "../src/storage/sqlite/retrieval-client.js";
import { IndexRefreshService } from "../src/retrieval/refresh.js";
import { CatalogWriteAdmission } from "../src/storage/write-admission.js";
import { FIXTURE_LITERATURE } from "../src/workbench/synthetic-fixture.js";
import { createQueryApplication } from "../src/bootstrap/application.js";
import { startProductionWorkbench } from "../src/bootstrap/workbench.js";
import { parseConfiguration } from "../src/configuration/index.js";
import { runCli } from "../src/cli/main.js";
import { createMcpServer } from "../src/mcp/server.js";
import { startQueryOnlyHttp } from "../src/workbench/http.js";
import { coreProcessingFixture } from "./core-processing-fixture.js";

async function fixture(run: (home: string, catalog: string) => Promise<void>) {
  const home = await mkdtemp(join(tmpdir(), "sciretriever-open-check-"));
  try {
    const catalog = join(home, "catalog.sqlite");
    const db = new DatabaseSync(catalog);
    initializeCurrentCatalog(db);
    db.close();
    await run(home, catalog);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

it("reads a single schema inventory and singleton identities without checking catalog rows", async () =>
  fixture(async (_, catalog) => {
    const db = new DatabaseSync(catalog);
    const prepare = db.prepare.bind(db),
      sql: string[] = [];
    const spy = vi.spyOn(db, "prepare").mockImplementation((text) => {
      sql.push(text);
      if (/integrity_check|foreign_key_check/iu.test(text))
        throw Error("unexpected full check");
      return prepare(text);
    });
    try {
      expect(readCatalogIdentity(db, CURRENT_CATALOG_CONFIG)).toMatchObject({
        product: "sciretriever",
      });
      expect(
        sql.filter((s) => /sqlite_(?:master|schema)/u.test(s)),
      ).toHaveLength(1);
      expect(sql).toHaveLength(5);
      db.exec("CREATE TABLE sqlitex_payload(value TEXT)");
      expect(
        readCatalogLayout(db, CURRENT_CATALOG_CONFIG)?.extra_objects,
      ).toEqual([{ type: "table", name: "sqlitex_payload" }]);
      db.exec("DROP TABLE sqlitex_payload");
      db.exec("DROP INDEX literature_reference_target_lookup");
      expect(() => readCatalogIdentity(db, CURRENT_CATALOG_CONFIG)).toThrow(
        "catalog-layout-not-current",
      );
    } finally {
      spy.mockRestore();
      db.close();
    }
  }));

it("uses an empty-target probe while explicit schema inspection still checks data", async () =>
  fixture(async (home, catalog) => {
    expect(await catalogNeedsInitialization(join(home, "absent.sqlite"))).toBe(
      true,
    );
    const empty = join(home, "empty.sqlite");
    new DatabaseSync(empty).close();
    expect(await catalogNeedsInitialization(empty)).toBe(true);
    const foreign = join(home, "foreign.sqlite"),
      db = new DatabaseSync(foreign);
    db.exec("CREATE TABLE foreign_data(value TEXT)");
    db.close();
    // A foreign or older catalog is refused read-only, before anything opens it for writing.
    await expect(catalogNeedsInitialization(foreign)).rejects.toMatchObject({
      code: "catalog-schema-refused",
      reason: "catalog-layout-not-current",
    });
    const prepare = DatabaseSync.prototype.prepare;
    const probe = vi
      .spyOn(DatabaseSync.prototype, "prepare")
      .mockImplementation(function (this: DatabaseSync, sql: string) {
        if (/integrity_check|foreign_key_check/iu.test(sql))
          throw Error("full-check-requested");
        return prepare.call(this, sql);
      });
    try {
      expect(await catalogNeedsInitialization(catalog)).toBe(false);
      await expect(inspectCatalogSchema(catalog)).rejects.toMatchObject({
        reason: "catalog-integrity-refused",
      });
    } finally {
      probe.mockRestore();
    }
  }));

it("serves an initialized production workbench without running the explicit inspection gate", async () =>
  fixture(async (home, catalog) => {
    await mkdir(join(home, ".sciretriever"), { mode: 0o700 });
    const prepare = DatabaseSync.prototype.prepare;
    const probe = vi
      .spyOn(DatabaseSync.prototype, "prepare")
      .mockImplementation(function (this: DatabaseSync, sql: string) {
        if (/integrity_check|foreign_key_check/iu.test(sql))
          throw Error("startup-full-check-requested");
        return prepare.call(this, sql);
      });
    let server:
      | Awaited<ReturnType<typeof startProductionWorkbench>>
      | undefined;
    const browserHost = vi.fn(() => null);
    try {
      server = await startProductionWorkbench({
        home,
        port: 0,
        access: { host: "127.0.0.1" },
        assets: new Map([["/", { contentType: "text/html", body: "ok" }]]),
        applicationOptions: {
          configurationSnapshot: {
            revision: "synthetic-open-check",
            configuration: parseConfiguration(
              `[paths]\ncatalog_path=${JSON.stringify(catalog)}\nartifact_root=${JSON.stringify(join(home, "artifacts"))}\n[sources.acquisition]\nmode="custom"\nproviders=[]\n`,
            ),
          },
          browserHost,
          metadata: {},
        },
      });
      expect((await fetch(`${server.origin}/auth/status`)).status).toBe(200);
      expect((await fetch(server.origin, { redirect: "manual" })).status).toBe(
        303,
      );
      expect(browserHost).not.toHaveBeenCalled();
    } finally {
      await server?.close();
      probe.mockRestore();
    }
  }));

it("opens writable/read-only workers and reconnects after ordinary writes without full checks", async () =>
  fixture(async (home, catalog) => {
    const probe = join(home, "forbid-checks.mjs");
    await writeFile(
      probe,
      `import {DatabaseSync} from 'node:sqlite';
const original=DatabaseSync.prototype.prepare;
DatabaseSync.prototype.prepare=function(sql){if(/integrity_check|foreign_key_check/iu.test(sql))throw Error('unexpected full check');return original.call(this,sql)};`,
    );
    const argv = [...process.execArgv];
    process.execArgv.push("--import", pathToFileURL(probe).href);
    const admission = new CatalogWriteAdmission(catalog),
      writer = new SqliteWorker(catalog, admission),
      reader = new SqliteWorker(catalog, undefined, { readOnly: true });
    process.execArgv.splice(0, process.execArgv.length, ...argv);
    try {
      expect(await writer.schema()).toMatchObject({ product: "sciretriever" });
      expect((await reader.queryPreflight()).status).toBe("ready");
      const outside = new DatabaseSync(catalog);
      outside.exec(
        "UPDATE library_state_revision SET revision=revision+1 WHERE singleton=1",
      );
      outside.close();
      expect(await writer.schema()).toMatchObject({ product: "sciretriever" });
      expect((await reader.queryPreflight()).status).toBe("ready");
      // The explicit maintenance path still attempts the forbidden full check.
      await expect(
        new RetrievalStorageClient(reader).verifyCatalog(),
      ).rejects.toBeInstanceOf(SqliteWorkerError);
    } finally {
      await writer.close();
      await reader.close();
      await admission.close();
    }
  }));

async function damageMetadata(catalog: string) {
  const admission = new CatalogWriteAdmission(catalog),
    writer = new SqliteWorker(catalog, admission);
  try {
    await writer.putLiterature(FIXTURE_LITERATURE);
  } finally {
    await writer.close();
    await admission.close();
  }
  const db = new DatabaseSync(catalog);
  const page = Number(
    db
      .prepare(
        "SELECT rootpage FROM sqlite_master WHERE name='literature_metadata'",
      )
      .get()!.rootpage,
  );
  const pageSize = Number(db.prepare("PRAGMA page_size").get()!.page_size);
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  db.close();
  const file = await open(catalog, "r+");
  try {
    await file.write(Buffer.from([0]), 0, 1, (page - 1) * pageSize);
    await file.sync();
  } finally {
    await file.close();
  }
}

it("keeps schema-only readiness but reports a damaged source page on reads, writes and explicit verification", async () =>
  fixture(async (home, catalog) => {
    await damageMetadata(catalog);
    const q = await createQueryApplication(home),
      admission = new CatalogWriteAdmission(catalog),
      writer = new SqliteWorker(catalog, admission),
      reader = new SqliteWorker(catalog, undefined, { readOnly: true });
    let web: Awaited<ReturnType<typeof startQueryOnlyHttp>> | undefined;
    try {
      expect(q.readiness.status).toBe("ready");
      await expect(
        q.query!.detail(FIXTURE_LITERATURE.literature_id),
      ).rejects.toMatchObject({
        code: "catalog-corrupt",
        sqlite_code: "SQLITE_CORRUPT",
        maintenance_hint: "verify-catalog",
      });
      await expect(
        writer.putLiterature(FIXTURE_LITERATURE),
      ).rejects.toMatchObject({
        code: "catalog-corrupt",
        sqlite_code: "SQLITE_CORRUPT",
      });
      await expect(
        new RetrievalStorageClient(reader).verifyCatalog(),
      ).rejects.toMatchObject({ code: "catalog-corrupt" });
      const errors: string[] = [];
      expect(
        (
          await runCli(
            ["literature", "show", FIXTURE_LITERATURE.literature_id, "--json"],
            { home, stderr: (s) => errors.push(s) },
          )
        ).code,
      ).toBe(3);
      expect(JSON.parse(errors.join(""))).toMatchObject({
        code: "catalog-corrupt",
        maintenance_hint: "verify-catalog",
      });
      errors.length = 0;
      expect(
        (
          await runCli(["maintenance", "verify-catalog"], {
            home,
            stderr: (s) => errors.push(s),
          })
        ).code,
      ).toBe(3);
      expect(JSON.parse(errors.join(""))).toMatchObject({
        code: "catalog-corrupt",
        maintenance_hint: "verify-catalog",
      });
      web = await startQueryOnlyHttp({ application: q });
      const response = await fetch(`${web.origin}/api/v1/query/read`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-SciRetriever-Protocol-Version": "1",
        },
        body: JSON.stringify({
          protocol_version: 1,
          request: { literature_id: FIXTURE_LITERATURE.literature_id },
        }),
      });
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({
        code: "catalog-corrupt",
        maintenance_hint: "verify-catalog",
      });
    } finally {
      await web?.close();
      await q.close();
      await writer.close();
      await reader.close();
      await admission.close();
    }
  }));

it("does not turn SQLITE_NOTADB into an uninitialized or merely unavailable catalog", async () =>
  fixture(async (home, catalog) => {
    await writeFile(catalog, Buffer.alloc(8192, 0x78));
    await expect(createQueryApplication(home)).rejects.toMatchObject({
      code: "catalog-corrupt",
      sqlite_code: "SQLITE_NOTADB",
      maintenance_hint: "verify-catalog",
    });
    const admission = new CatalogWriteAdmission(catalog),
      writer = new SqliteWorker(catalog, admission);
    try {
      await expect(writer.schema()).rejects.toMatchObject({
        code: "catalog-corrupt",
        sqlite_code: "SQLITE_NOTADB",
      });
    } finally {
      await writer.close();
      await admission.close();
    }
  }));

it("verifies a catalog without a retrieval generation through CLI, HTTP and MCP and detects foreign-key damage", async () => {
  const e = await coreProcessingFixture();
  // Keep this negative fixture unindexed across transport-owned Applications.
  // Automatic startup catch-up is covered by retrieval-stale-serving instead.
  const monitor = vi
    .spyOn(IndexRefreshService.prototype, "start")
    .mockResolvedValue(undefined);
  const q = await createQueryApplication(e.home);
  const web = await startQueryOnlyHttp({
    application: q,
    maintenance: e.app.maintenance!,
  });
  const server = createMcpServer({ home: e.home, maintenance: true });
  const client = new Client({ name: "catalog-maintenance", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    const cli = await runCli(["maintenance", "verify-catalog"], {
      home: e.home,
    });
    expect(cli.code).toBe(0);
    expect(cli.value).toMatchObject({
      integrity: "ok",
      foreign_keys: "ok",
      active_generation: null,
    });
    const root = await fetch(web.origin),
      cookie = root.headers.get("set-cookie")!.split(";")[0]!;
    const session = await fetch(`${web.origin}/api/v1/maintenance/session`, {
      headers: { Cookie: cookie },
    });
    const { csrf } = (await session.json()) as { csrf: string };
    const verify = () =>
      fetch(`${web.origin}/api/v1/maintenance/verify-catalog`, {
        method: "POST",
        headers: {
          Cookie: cookie,
          Origin: web.origin,
          "Content-Type": "application/json",
          "X-SciRetriever-Csrf": csrf,
          "X-SciRetriever-Protocol-Version": "1",
        },
        body: JSON.stringify({
          protocol_version: 1,
          request: { kind: "verify" },
        }),
      });
    const ok = await verify();
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({
      result: { integrity: "ok", active_generation: null },
    });
    await server.connect(a);
    await client.connect(b);
    const result = await client.callTool({
      name: "verify_catalog",
      arguments: {},
    });
    expect(result.isError).not.toBe(true);
    expect(JSON.stringify(result)).toContain('"integrity":"ok"');
    const broken = new DatabaseSync(join(e.home, "catalog.sqlite"));
    try {
      broken.exec("PRAGMA foreign_keys=OFF");
      broken
        .prepare(
          "INSERT INTO literature_metadata_keywords VALUES(?,0,'orphan')",
        )
        .run("00000000-0000-0000-0000-000000000999");
    } finally {
      broken.close();
    }
    const bad = await verify();
    expect(bad.status).toBe(503);
    expect(await bad.json()).toMatchObject({
      code: "catalog-corrupt",
      maintenance_hint: "verify-catalog",
    });
    const mcp = await client.callTool({
      name: "verify_catalog",
      arguments: {},
    });
    expect(mcp.isError).toBe(true);
    expect(JSON.stringify(mcp)).toContain("verify-catalog");
  } finally {
    await client.close();
    await server.close();
    await web.close();
    await q.close();
    await e.close();
    monitor.mockRestore();
  }
}, 30000);
