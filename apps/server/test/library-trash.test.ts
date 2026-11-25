import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { parseFolderNode } from "@sciretriever/contracts";
import { expect, it, vi } from "vitest";
import {
  createApplication,
  createQueryApplication,
} from "../src/bootstrap/application.js";
import { runCli } from "../src/cli/main.js";
import { executeMaintenance } from "../src/entry/maintenance-operations.js";
import { executeQuery } from "../src/entry/query-operations.js";
import { createMcpServer } from "../src/mcp/server.js";
import { httpMcpPurpose } from "../src/mcp/tools.js";
import { manifestObject } from "../src/storage/sqlite/catalog-ddl.js";
import { readCatalogLayout } from "../src/storage/sqlite/catalog-identity.js";
import {
  catalogConfigFor,
  initializeCurrentCatalog,
} from "../src/storage/sqlite/catalog-layout.js";
import { inspectCatalogSchema } from "../src/storage/sqlite/catalog-schema.js";
import { runLibraryTrashStorage } from "../src/storage/sqlite/library-trash-engine.js";
import {
  ARCHIVE_ISSUES_ADDITION,
  LIBRARY_SCALE_ADDITION,
  LIBRARY_TRASH_ADDITION,
  SCHEMA_FINGERPRINT,
} from "../src/storage/sqlite/schema.js";
import { startQueryOnlyHttp } from "../src/workbench/http.js";
import {
  withdrawalFixture,
  withdrawalRecord as record,
} from "./intake-withdrawal-fixture.js";

const selector = (literature_ids: readonly string[]) => ({
  kind: "literatures",
  literature_ids,
});

async function trashFixture(keys: readonly string[]) {
  const f = await withdrawalFixture();
  const imported = await f.batch(keys.map((key) => record(key)));
  const ids = imported.report.items.map((item) => item.literature_id!);
  const trash = (operation: "delete" | "restore", literature_ids: string[]) =>
    executeMaintenance(f.app, "library-trash", {
      operation,
      selector: selector(literature_ids),
    });
  const query = (value: unknown): Promise<unknown> => f.app.trash.query(value);
  return { ...f, ids, imported, trash, query };
}

/** Every read the tests compare before deletion and after restore. */
async function reads(
  f: Awaited<ReturnType<typeof trashFixture>>,
  folderId: string,
) {
  const page = await f.app.library.search({
    query: {},
    sort: "title-asc",
  });
  const counts = await f.app.library.counts({});
  const folders = (
    (await f.app.folders.query({ operation: "list", request: {} })) as {
      items: unknown[];
    }
  ).items.map(parseFolderNode);
  const inFolder = await f.app.library.search({
    query: { folder: { id: folderId, include_descendants: true } },
    sort: "title-asc",
  });
  const text = await f.app.library.search({
    query: { text: "Withdrawal" },
    sort: "relevance",
  });
  return {
    ids: page.items.map((item) => item.literature.literature_id),
    total: page.total_count,
    counts: { total: counts.total, statuses: counts.statuses },
    folder: folders.map(({ own_count, total_count }) => ({
      own_count,
      total_count,
    })),
    folderIds: inFolder.items.map((item) => item.literature.literature_id),
    text: text.items.map((item) => item.literature.literature_id).sort(),
  };
}

it("hides deleted papers from every read and restores them with their folders and history", async () => {
  const f = await trashFixture(["a", "b", "c", "d"]);
  try {
    const [a, b, c, d] = f.ids as [string, string, string, string];
    const folder = await f.folder("Kept");
    await f.app.folders.manage({
      operation: "add",
      request: { folder_id: folder, literature_ids: [a, b, c] },
    });
    await executeMaintenance(f.app, "reading-open", { literature_id: a });
    const before = await reads(f, folder);
    expect(before).toMatchObject({
      total: 4,
      counts: { total: 4 },
      folder: [{ own_count: 3, total_count: 3 }],
    });
    expect(before.text).toHaveLength(4);

    expect(await f.trash("delete", [a, c, randomUUID()])).toEqual({
      operation: "delete",
      target_count: 3,
      changed: 2,
    });
    const hidden = await reads(f, folder);
    expect(hidden.ids).toEqual(before.ids.filter((id) => id !== a && id !== c));
    expect(hidden).toMatchObject({
      total: 2,
      counts: { total: 2 },
      folder: [{ own_count: 1, total_count: 1 }],
      folderIds: [b],
      text: [b, d].sort(),
    });
    expect(
      Object.values(hidden.counts.statuses).reduce((n, v) => n + v, 0),
    ).toBe(2);
    await expect(f.app.library.detail(a)).rejects.toMatchObject({
      code: "literature-not-found",
    });
    expect(await f.app.database.getLiterature(c)).toBeNull();
    // Nothing about the paper itself is removed.
    expect(
      f.rows(
        "SELECT (SELECT count(*) FROM literatures WHERE literature_id=?) AS lit,(SELECT count(*) FROM folder_members WHERE literature_id=?) AS member,(SELECT open_count FROM reading_history WHERE literature_id=?) AS opened",
        a,
        a,
        a,
      ),
    ).toEqual([{ lit: 1, member: 1, opened: 1 }]);
    expect(await f.query({ operation: "count", request: {} })).toEqual({
      total_count: 2,
    });

    expect(await f.trash("delete", [a])).toMatchObject({ changed: 0 });
    expect(await f.trash("restore", [a, b])).toEqual({
      operation: "restore",
      target_count: 2,
      changed: 1,
    });
    expect(await f.trash("restore", [c])).toMatchObject({ changed: 1 });
    expect(await f.trash("restore", [c])).toMatchObject({ changed: 0 });
    expect(await reads(f, folder)).toEqual(before);
    expect((await f.app.library.detail(a)).literature.literature_id).toBe(a);
    expect(await f.query({ operation: "count", request: {} })).toEqual({
      total_count: 0,
    });
    expect(f.rows("PRAGMA foreign_key_check")).toEqual([]);
  } finally {
    await f.close();
  }
});

it("lists newest deletions first in stable pages and counts from the trash table alone", async () => {
  const f = await trashFixture(["p", "q", "r", "s", "t"]);
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    const sorted = [...f.ids].sort();
    vi.setSystemTime(new Date("2026-11-25T01:00:00.000Z"));
    await f.trash("delete", [sorted[4]!]);
    vi.setSystemTime(new Date("2026-11-25T02:00:00.000Z"));
    await f.trash("delete", [sorted[3]!, sorted[0]!, sorted[2]!]);
    vi.setSystemTime(new Date("2026-11-25T03:00:00.000Z"));
    await f.trash("delete", [sorted[1]!]);
    const expected = [sorted[1], sorted[0], sorted[2], sorted[3], sorted[4]];
    const seen: unknown[] = [];
    let cursor: string | null = null,
      pages = 0;
    do {
      const page = (await f.query({
        operation: "list",
        request: { limit: 2, cursor },
      })) as {
        items: {
          literature: { literature_id: string; title: string };
          deleted_at: string;
          deleted_by: string;
        }[];
        next_cursor: string | null;
      };
      seen.push(...page.items);
      cursor = page.next_cursor;
      pages++;
    } while (cursor);
    expect(pages).toBe(3);
    expect(
      seen.map(
        (item) =>
          (item as { literature: { literature_id: string } }).literature
            .literature_id,
      ),
    ).toEqual(expected);
    expect(seen[0]).toEqual({
      literature: {
        literature_id: sorted[1],
        identifiers: [
          { namespace: "doi", value: expect.stringMatching(/^10\.5555\//u) },
        ],
        title: expect.stringMatching(/^Withdrawal /u),
        year: expect.anything(),
      },
      deleted_at: "2026-11-25T03:00:00.000Z",
      deleted_by: expect.any(String),
    });
    expect(await f.query({ operation: "count", request: {} })).toEqual({
      total_count: 5,
    });
    const q = await createQueryApplication(f.home);
    try {
      for (const request of [
        { operation: "list", request: { limit: 101, cursor: null } },
        { operation: "list", request: { limit: 1, cursor: "not-a-cursor" } },
        { operation: "count", request: { limit: 1 } },
      ])
        await expect(
          executeQuery(q, "library-trash", request),
        ).rejects.toMatchObject({ code: "invalid-request" });
    } finally {
      await q.close();
    }
  } finally {
    vi.useRealTimers();
    await f.close();
  }

  // Both reads walk only library_trash (and the page's own bibliography).
  const db = new DatabaseSync(":memory:");
  try {
    initializeCurrentCatalog(db);
    const prepare = vi.spyOn(db, "prepare");
    runLibraryTrashStorage(db, { kind: "count" });
    runLibraryTrashStorage(db, {
      kind: "list",
      limit: 10,
      after: ["2026-11-25T00:00:00.000Z", randomUUID()],
    });
    const statements = prepare.mock.calls.map(([sql]) => sql);
    prepare.mockRestore();
    const plans = statements.map((sql) =>
      db
        .prepare("EXPLAIN QUERY PLAN " + sql)
        .all(...Array(sql.split("?").length - 1).fill(null))
        .map(({ detail }) => String(detail)),
    );
    const scans = plans.flat().filter((detail) => detail.startsWith("SCAN"));
    expect(
      scans.every((detail) => /library_trash|json_each/u.test(detail)),
    ).toBe(true);
    // count walks the order index; the page seeks it from the cursor.
    expect(plans[0]).toEqual([
      "SCAN library_trash USING COVERING INDEX library_trash_order",
    ]);
    expect(plans[1]![0]).toMatch(
      /^SEARCH t USING INDEX library_trash_order \(deleted_at<\?\)$/u,
    );
  } finally {
    db.close();
  }
});

it("refuses oversized, duplicated and busy requests atomically and keeps the folder delete permission on MCP", async () => {
  const f = await trashFixture(["x", "y"]);
  try {
    const [x, y] = f.ids as [string, string];
    for (const literature_ids of [
      Array.from({ length: 1001 }, () => randomUUID()),
      [x, x],
      [],
    ])
      await expect(
        executeMaintenance(f.app, "library-trash", {
          operation: "delete",
          selector: selector(literature_ids),
        }),
      ).rejects.toMatchObject({ code: "invalid-request" });
    const { ExecutionRepository, normalizeExecutionPolicy } = await import(
      "../src/storage/execution/repository.js"
    );
    const repo = new ExecutionRepository(f.app.database);
    const jobId = `job-${randomUUID()}`;
    await repo.createJob({
      job_id: jobId,
      target_kind: "literature",
      selector: { literature_ids: [y] },
      policy_version: randomUUID(),
      idempotency_key: randomUUID(),
      policy: normalizeExecutionPolicy({}),
      targets: [
        {
          target_id: randomUUID(),
          job_id: jobId,
          ordinal: 0,
          literature_id: y,
          version_role: "published",
          stage: "acquisition",
          disposition: "pending",
          next_eligible_at: null,
        },
      ],
    });
    for (const state of ["queued", "running"] as const) {
      await repo.updateJob(jobId, state);
      await expect(f.trash("delete", [x, y])).rejects.toMatchObject({
        code: "library-trash-busy",
      });
      expect(f.rows("SELECT * FROM library_trash")).toEqual([]);
    }
    await repo.controlJob(jobId, "cancelled");
    expect(await f.trash("delete", [x, y])).toMatchObject({ changed: 2 });
    expect(f.rows("SELECT deleted_by FROM library_trash")).toHaveLength(2);

    for (const [read, write] of [
      ["library_trash_query", "library_trash_manage"],
    ])
      expect([httpMcpPurpose(read!), httpMcpPurpose(write!)]).toEqual([
        httpMcpPurpose("folders_query"),
        httpMcpPurpose("folders_manage"),
      ]);
  } finally {
    await f.close();
  }
});

it("answers the same over CLI, MCP and HTTP", async () => {
  const f = await trashFixture(["m", "n"]);
  const server = createMcpServer({ home: f.home, maintenance: true }),
    client = new Client({ name: "trash-tests", version: "1" });
  let q: Awaited<ReturnType<typeof createQueryApplication>> | undefined,
    web: Awaited<ReturnType<typeof startQueryOnlyHttp>> | undefined;
  async function* stdin(request: unknown) {
    yield Buffer.from(JSON.stringify(request));
  }
  const cli = (args: string[], request?: unknown, stderr?: string[]) =>
    runCli(["literature", "trash", ...args, "--json"], {
      home: f.home,
      ...(request === undefined ? {} : { stdin: stdin(request) }),
      stdout: () => {},
      stderr: (line) => stderr?.push(line),
    });
  try {
    const [m, n] = f.ids as [string, string];
    expect(
      await cli(["delete", "--request", "-"], { selector: selector([m]) }),
    ).toEqual({
      code: 0,
      value: {
        protocol_version: 1,
        result: { operation: "delete", target_count: 1, changed: 1 },
      },
    });
    const stderr: string[] = [];
    expect(
      (
        await cli(
          ["delete", "--request", "-"],
          { selector: selector([n, n]) },
          stderr,
        )
      ).code,
    ).not.toBe(0);
    expect(JSON.parse(stderr.join(""))).toMatchObject({
      code: "invalid-request",
    });
    expect(await cli(["count"])).toMatchObject({
      code: 0,
      value: { protocol_version: 1, result: { total_count: 1 } },
    });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    await client.connect(b);
    const listed = await client.callTool({
      name: "library_trash_query",
      arguments: { operation: "list", request: { limit: 10, cursor: null } },
    });
    expect(listed.isError, JSON.stringify(listed)).not.toBe(true);
    expect(listed.structuredContent).toMatchObject({
      result: {
        items: [{ literature: { literature_id: m } }],
        next_cursor: null,
      },
    });
    const restored = await client.callTool({
      name: "library_trash_manage",
      arguments: { operation: "restore", selector: selector([m, n]) },
    });
    expect(restored.structuredContent).toMatchObject({
      result: { operation: "restore", target_count: 2, changed: 1 },
    });
    q = await createQueryApplication(f.home);
    web = await startQueryOnlyHttp({ application: q });
    const response = await fetch(web.origin + "/api/v1/query/library-trash", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        protocol_version: 1,
        request: { operation: "count", request: {} },
      }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      protocol_version: 1,
      result: { total_count: 0 },
    });
  } finally {
    await web?.close();
    await q?.close();
    await client.close();
    await server.close();
    await f.close();
  }
});

it("restores a deleted paper when it is imported again instead of creating a duplicate", async () => {
  const f = await trashFixture(["again"]);
  try {
    const [id] = f.ids as [string];
    await f.trash("delete", [id]);
    const again = await f.batch([record("again")]);
    expect(again.report.items.map((item) => item.literature_id)).toEqual([id]);
    expect(
      f.rows(
        "SELECT disposition FROM intake_batch_members WHERE batch_id=?",
        again.id,
      ),
    ).toEqual([{ disposition: "restored" }]);
    expect(f.rows("SELECT * FROM library_trash")).toEqual([]);
    expect(f.rows("SELECT count(*) AS n FROM literatures")).toEqual([{ n: 1 }]);
    expect((await f.app.library.search({ query: {} })).total_count).toBe(1);
  } finally {
    await f.close();
  }
});

it("requires the library-trash addition, applies it explicitly and leaves older layouts readable", async () => {
  const home = await mkdtemp(join(tmpdir(), "sciretriever-library-trash-"));
  const path = join(home, "catalog.sqlite");
  const db = new DatabaseSync(path);
  try {
    initializeCurrentCatalog(db);
    for (const sql of [...LIBRARY_TRASH_ADDITION.statements].reverse()) {
      const object = manifestObject(sql);
      db.exec(`DROP ${object.type.toUpperCase()} ${object.name}`);
    }
    db.prepare("DELETE FROM catalog_schema_additions WHERE name=?").run(
      LIBRARY_TRASH_ADDITION.name,
    );
    const previous = catalogConfigFor([
      LIBRARY_SCALE_ADDITION,
      ARCHIVE_ISSUES_ADDITION,
    ]);
    expect(readCatalogLayout(db, previous)?.extra_objects).toEqual([]);
    const required = {
      code: "catalog-addition-required",
      addition: LIBRARY_TRASH_ADDITION.name,
    };
    await expect(inspectCatalogSchema(path)).rejects.toMatchObject(required);
    await expect(
      createApplication(home, { metadata: {}, indexRefreshIntervalMs: null }),
    ).rejects.toMatchObject(required);

    const applied = await runCli(
      [
        "storage",
        "schema-apply",
        "--catalog",
        path,
        "--addition",
        LIBRARY_TRASH_ADDITION.name,
      ],
      { home, stdout: () => {}, stderr: () => {} },
    );
    expect(applied).toMatchObject({
      code: 0,
      value: {
        name: "library-trash",
        ddl_fingerprint: LIBRARY_TRASH_ADDITION.ddl_fingerprint,
      },
    });
    // An older build still opens it and lists the new objects as extra.
    expect(
      readCatalogLayout(db, previous)
        ?.extra_objects.map((object) => object.name)
        .sort(),
    ).toEqual(
      LIBRARY_TRASH_ADDITION.statements
        .map((sql) => manifestObject(sql).name)
        .sort(),
    );
    await expect(inspectCatalogSchema(path)).resolves.toMatchObject({
      status: "ready",
      schema_fingerprint: SCHEMA_FINGERPRINT,
    });
  } finally {
    db.close();
    await rm(home, { recursive: true, force: true });
  }
});
